package api

// Cost endpoint. Renders the dashboard's /cost page driven from the
// astrolabe state SQLite database — one ``submits`` row per submit
// version is the source of truth for everything cost-related (rate,
// gpu_type, outcome, backend, repo, submitter, wall window).
//
// History: pre-v1.7.4 this read state files (last-write-wins, hid
// non-latest versions); v1.7.4 moved to per-version Aim "metadata"
// runs; v1.8 moved it again — this time off Aim entirely, because
// engine-side writes to a shared Aim repo deadlocked on RocksDB
// cross-process flushes whenever the dashboard read concurrently. The
// fix lifted cost fields into the ``submits`` table directly, so the
// engine never touches Aim for cost data and the dashboard reads from
// SQLite (WAL: concurrent readers + a single writer, no contention).
//
// The downstream aggregation (filterByWindow, runHours, computeRunCents,
// buildExperiments, buildTimeSeriesFromRuns, buildBreakdownFromRuns) is
// unchanged from the Aim-era; it operates on a ``costRun`` shape that
// no longer cares where the rows came from.

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"
)

// CostResponse mirrors astrolabe-insights-hub/src/lib/types.ts. All
// money in integer cents; the frontend formats with the standard
// 2-decimal locale.
type CostResponse struct {
	Window          CostWindow            `json:"window"`
	TotalCents      int                   `json:"total_cents"`
	PriorTotalCents int                   `json:"prior_total_cents"`
	TimeSeries      []CostTimeBucket      `json:"time_series"`
	Breakdown       CostBreakdown         `json:"breakdown"`
	Experiments     []CostExperimentEntry `json:"experiments"`
}

type CostWindow struct {
	Start  string `json:"start"`  // ISO-8601
	End    string `json:"end"`    // ISO-8601
	Label  string `json:"label"`  // 7d | 30d | 90d | all | custom
	Bucket string `json:"bucket"` // daily | weekly | monthly
}

type CostTimeBucket struct {
	Start       string         `json:"start"` // ISO-8601 date
	TotalCents  int            `json:"total_cents"`
	ByDimension map[string]int `json:"by_dimension"` // dimension key → cents
}

type CostBreakdown struct {
	Dimension string             `json:"dimension"`
	Rows      []CostBreakdownRow `json:"rows"`
}

type CostBreakdownRow struct {
	Key     string  `json:"key"`
	Submits int     `json:"submits"`
	Hours   float64 `json:"hours"`
	Cents   int     `json:"cents"`
	Pct     float64 `json:"pct"`
}

type CostExperimentEntry struct {
	Name       string             `json:"name"`
	TotalHours float64            `json:"total_hours"`
	TotalCents int                `json:"total_cents"`
	Versions   []CostVersionEntry `json:"versions"`
}

type CostVersionEntry struct {
	Version        string   `json:"version"`
	GPUType        string   `json:"gpu_type"`
	State          string   `json:"state"`
	Outcome        string   `json:"outcome"`
	Hours          *float64 `json:"hours"`           // nil = in-flight
	Cents          *int     `json:"cents"`           // nil = in-flight or unresolved rate
	EstimatedCents int      `json:"estimated_cents"` // always populated
}

// costRun is the per-submit record the cost handler operates on, built
// from one ``submits`` row. All dimensions come straight off the row;
// no joins, no fan-out.
type costRun struct {
	Experiment  string
	Version     string
	SubmitID    string
	GPUType     string
	RateCents   int  // 0 if unresolved
	HasRate     bool // distinguishes "free" (LocalExecutor → 0) from "unknown"
	State       string // current_state from SQLite — the canonical FSM state, same as Home/Details
	Outcome     string
	SubmittedBy string
	Repo        string
	Backend     string
	Started     time.Time
	Ended       time.Time
	Active      bool // finished_at empty / Ended zero
}

// HandleCost serves GET /api/cost. Query params:
//
//	window   = 7d | 30d | 90d | all  (default 30d)
//	group_by = submitter | repo | gpu_type | outcome | backend  (default submitter)
//	stack    = none | <group_by values>  (default none)
func (h *Handler) HandleCost(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	window := defaultStr(q.Get("window"), "30d")
	groupBy := defaultStr(q.Get("group_by"), "submitter")
	stack := defaultStr(q.Get("stack"), "none")
	loc := parseTZParam(q.Get("tz"))

	// All timestamps in the DB are UTC. The window math and the daily
	// bucketing happen in the viewer's local TZ (passed via ``?tz=``)
	// so the chart's X axis labels the viewer's calendar days, not
	// UTC's. Absolute time comparisons (filterByWindow, runHours)
	// don't care about location — they operate on instants.
	now := time.Now().In(loc)
	winStart, winEnd, bucket, label := resolveWindow(window, now)

	empty := CostResponse{
		Window: CostWindow{
			Start:  winStart.Format(time.RFC3339),
			End:    winEnd.Format(time.RFC3339),
			Label:  label,
			Bucket: bucket,
		},
		TimeSeries:  []CostTimeBucket{},
		Breakdown:   CostBreakdown{Dimension: groupBy, Rows: []CostBreakdownRow{}},
		Experiments: []CostExperimentEntry{},
	}

	if h.state == nil {
		writeJSON(w, empty)
		return
	}

	allRuns, err := h.gatherCostRuns()
	if err != nil {
		// State DB unreachable — render empty rather than 500. Cost is
		// derived data; a transient outage shouldn't 5xx the page.
		writeJSON(w, empty)
		return
	}

	inWindow := filterByWindow(allRuns, winStart, winEnd)

	experiments, totalCents := buildExperiments(inWindow, now)
	sort.Slice(experiments, func(i, j int) bool {
		return experiments[i].TotalCents > experiments[j].TotalCents
	})

	timeSeries := buildTimeSeriesFromRuns(inWindow, winStart, winEnd, stack)
	breakdown := buildBreakdownFromRuns(inWindow, groupBy, totalCents)

	// Prior-window total — same range shifted back. Skipped (left
	// as 0) when window is "all"; frontend hides the delta in that
	// case.
	var priorTotal int
	if label != "all" {
		days := int(winEnd.Sub(winStart).Hours() / 24)
		priorStart := winStart.AddDate(0, 0, -days)
		priorRuns := filterByWindow(allRuns, priorStart, winStart)
		for _, run := range priorRuns {
			cents := computeRunCents(run, now)
			if cents != nil {
				priorTotal += *cents
			}
		}
	}

	writeJSON(w, CostResponse{
		Window: CostWindow{
			Start:  winStart.Format(time.RFC3339),
			End:    winEnd.Format(time.RFC3339),
			Label:  label,
			Bucket: bucket,
		},
		TotalCents:      totalCents,
		PriorTotalCents: priorTotal,
		TimeSeries:      timeSeries,
		Breakdown:       breakdown,
		Experiments:     experiments,
	})
}

// billingWindow derives the compute backend's billing window from a
// submit's FSM transition history.
//
// CALIBRATED FOR LAMBDA. Lambda bills from "instance provisioned and
// accepting connections" (≈ engine ACQUIRING → SETUP transition, also
// when the "Compute acquired" Slack message fires) through "terminate
// confirmed" (≈ first terminal FSM state, since release() fires the
// terminate API call immediately after). Matches Lambda's actual
// invoice within sub-cent rounding.
//
// For the local backend this window is computed but irrelevant — rate
// is 0 so cents=0 regardless. If a future backend has different
// billing semantics (e.g. AWS Spot billing from instance launch, not
// from ready state) this function is the seam: dispatch on
// ``s.Backend`` and pick a different transition pair.
//
// Falls back to (started_at, finished_at) for legacy rows whose
// state_transitions table is empty (pre-SQLite imports). Returns a
// zero start when the submit never reached SETUP — Lambda doesn't
// bill for launches that failed before becoming ready, so we drop
// those rows from the cost view.
func billingWindow(s ExperimentState) (started, ended time.Time, active bool) {
	var setupAt, terminalAt time.Time
	for _, t := range s.StateHistory {
		if setupAt.IsZero() && t.State == "SETUP" {
			setupAt = parseISO(t.At)
		}
		if terminalAt.IsZero() {
			switch t.State {
			case "COMPLETED", "FAILED", "STOPPED":
				terminalAt = parseISO(t.At)
			}
		}
	}
	if setupAt.IsZero() {
		// Two paths:
		//   - Legacy/imported row with no state_transitions: fall back
		//     to the submit row's started_at / finished_at. Less
		//     accurate (includes engine startup + cleanup time) but
		//     it's all we have.
		//   - Modern row with transitions but no SETUP: launch failed
		//     before Lambda was ready, never billed. Return zero
		//     start so caller drops the row.
		if len(s.StateHistory) == 0 {
			started = parseISO(s.StartedAt)
			ended = parseISO(s.FinishedAt)
			active = s.FinishedAt == "" || ended.IsZero()
		}
		return
	}
	started = setupAt
	if terminalAt.IsZero() {
		// SETUP reached, no terminal yet — Lambda is actively billing.
		active = true
		return
	}
	ended = terminalAt
	return
}

// gatherCostRuns enumerates submits in the state DB and builds the
// cost handler's working dataset. One row per submit version; no
// per-run fan-out, no Aim hops. ``gpu_rate_cents_per_hour`` may be
// NULL — those rows surface as cents=nil in the UI but still count
// toward submit/hour totals.
func (h *Handler) gatherCostRuns() ([]costRun, error) {
	states, err := h.state.ListAll()
	if err != nil {
		return nil, err
	}
	out := make([]costRun, 0, len(states))
	for _, s := range states {
		started, ended, active := billingWindow(s)
		if started.IsZero() {
			// Either no usable timestamps (legacy row with empty
			// started_at) or the submit never reached SETUP (Lambda
			// never billed). Drop from the cost view.
			continue
		}

		rateCents := 0
		hasRate := false
		if s.GPURateCentsPerHour != nil {
			rateCents = *s.GPURateCentsPerHour
			hasRate = true
		}
		out = append(out, costRun{
			Experiment:  s.Name,
			Version:     s.Version,
			SubmitID:    s.SubmitID,
			GPUType:     s.GPUType,
			RateCents:   rateCents,
			HasRate:     hasRate,
			State:       s.State,
			Outcome:     s.Outcome,
			SubmittedBy: s.SubmittedBy,
			Repo:        s.Repo,
			Backend:     s.Backend,
			Started:     started,
			Ended:       ended,
			Active:      active,
		})
	}
	return out, nil
}

// filterByWindow returns runs whose Started falls inside [start, end).
func filterByWindow(runs []costRun, start, end time.Time) []costRun {
	out := make([]costRun, 0, len(runs))
	for _, r := range runs {
		if r.Started.Before(start) || !r.Started.Before(end) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// runHours returns (hours, hoursPtr) for a single submit. For terminal
// runs (Ended set), returns (delta, &delta). For in-flight, returns
// (now-Started, nil) — the pointer being nil signals "render — instead
// of a duration" to the frontend.
func runHours(r costRun, now time.Time) (float64, *float64) {
	if r.Active || r.Ended.IsZero() {
		return now.Sub(r.Started).Hours(), nil
	}
	h := r.Ended.Sub(r.Started).Hours()
	if h < 0 {
		return 0, nil
	}
	return h, &h
}

// computeRunCents returns the cents this run contributes, or nil
// when the run is in-flight or has no resolved rate.
func computeRunCents(r costRun, now time.Time) *int {
	if !r.HasRate {
		return nil
	}
	_, hoursPtr := runHours(r, now)
	if hoursPtr == nil {
		return nil
	}
	c := int(float64(r.RateCents) * (*hoursPtr))
	return &c
}

// buildExperiments groups runs by (experiment, version) → version
// entry, then by experiment → experiment entry. Returns the
// experiments list and the running total cents.
//
// Multi-row versions (legacy two-model experiments where v1 had a
// shared Lambda instance) bill once per version: instance hold time is
// approximated as max(Ended) - min(Started). With the SQLite shape
// there's exactly one row per (experiment, version) thanks to the
// UNIQUE constraint, so the aggregation collapses to a passthrough —
// but the structure is kept in case the schema relaxes the constraint.
func buildExperiments(runs []costRun, now time.Time) ([]CostExperimentEntry, int) {
	type versionAgg struct {
		gpuType   string
		rateCents int
		hasRate   bool
		state     string // canonical current_state from SQLite — same value Home/Details show
		outcome   string
		started   time.Time
		ended     time.Time
		anyActive bool
		runCount  int
	}
	// experiment → version → agg
	byExp := map[string]map[string]*versionAgg{}
	expOrder := []string{}
	for _, r := range runs {
		vmap, ok := byExp[r.Experiment]
		if !ok {
			vmap = map[string]*versionAgg{}
			byExp[r.Experiment] = vmap
			expOrder = append(expOrder, r.Experiment)
		}
		v, ok := vmap[r.Version]
		if !ok {
			v = &versionAgg{
				gpuType:   r.GPUType,
				rateCents: r.RateCents,
				hasRate:   r.HasRate,
				state:     r.State,
				outcome:   r.Outcome,
				started:   r.Started,
				ended:     r.Ended,
			}
			vmap[r.Version] = v
		}
		// Aggregate timestamps: earliest start, latest end.
		if r.Started.Before(v.started) {
			v.started = r.Started
		}
		if r.Ended.After(v.ended) {
			v.ended = r.Ended
		}
		if r.Active {
			v.anyActive = true
		}
		if v.outcome == "" && r.Outcome != "" {
			v.outcome = r.Outcome
		}
		v.runCount++
	}

	var total int
	out := make([]CostExperimentEntry, 0, len(byExp))
	for _, expName := range expOrder {
		vmap := byExp[expName]
		// Materialize one CostVersionEntry per version, sorted by
		// version label (v1, v2, ...) for stable rendering.
		versionLabels := make([]string, 0, len(vmap))
		for v := range vmap {
			versionLabels = append(versionLabels, v)
		}
		sort.Slice(versionLabels, func(i, j int) bool {
			return versionLabels[i] < versionLabels[j]
		})

		versions := make([]CostVersionEntry, 0, len(vmap))
		var expTotalHours float64
		var expTotalCents int
		for _, vlabel := range versionLabels {
			v := vmap[vlabel]
			synth := costRun{
				RateCents: v.rateCents,
				HasRate:   v.hasRate,
				Started:   v.started,
				Ended:     v.ended,
				Active:    v.anyActive,
			}
			hours, hoursPtr := runHours(synth, now)
			cents := computeRunCents(synth, now)
			// State comes from the SQLite ``current_state`` column —
			// the same value Home (/api/experiments) and Details
			// (/api/experiments/{name}) render. Three pages, one
			// source of truth. The handler used to infer state from
			// (anyActive, outcome, ended) because the pre-SQLite
			// implementation read Aim metadata runs that had no
			// state column; that inference is dead code now and was
			// the cause of "cost shows RUNNING while Home shows
			// COMPLETED" for any submit whose terminal transition
			// was missing or back-filled wrong.
			state := v.state
			outcome := v.outcome
			if outcome == "" && !v.anyActive && !v.ended.IsZero() {
				// Legacy terminal run with no outcome writeback —
				// frontend's outcome filter will bucket it under
				// "" (unknown); pass through as-is rather than
				// guessing.
				outcome = ""
			}
			versions = append(versions, CostVersionEntry{
				Version:        vlabel,
				GPUType:        v.gpuType,
				State:          state,
				Outcome:        outcome,
				Hours:          hoursPtr,
				Cents:          cents,
				EstimatedCents: 0,
			})
			if cents != nil {
				expTotalCents += *cents
				total += *cents
			}
			if hoursPtr != nil {
				expTotalHours += hours
			}
		}
		out = append(out, CostExperimentEntry{
			Name:       expName,
			TotalHours: expTotalHours,
			TotalCents: expTotalCents,
			Versions:   versions,
		})
	}
	return out, total
}


// resolveWindow maps a window label to (start, end, bucket, normalized label).
// "all" reaches back 5 years — long enough to capture any realistic
// astrolabe history; if a NUC actually accumulates >5y of data we'll
// extend.
func resolveWindow(label string, now time.Time) (time.Time, time.Time, string, string) {
	end := now
	switch label {
	case "7d":
		return end.AddDate(0, 0, -7), end, "daily", "7d"
	case "30d":
		return end.AddDate(0, 0, -30), end, "daily", "30d"
	case "90d":
		return end.AddDate(0, 0, -90), end, "weekly", "90d"
	case "all":
		return end.AddDate(-5, 0, 0), end, "monthly", "all"
	default:
		return end.AddDate(0, 0, -30), end, "daily", "30d"
	}
}

// buildTimeSeriesFromRuns buckets in-window runs into daily slots,
// keying contribution by the requested stack dimension. "none" funnels
// everything into "all" for a flat per-day total bar.
func buildTimeSeriesFromRuns(runs []costRun, start, end time.Time, stack string) []CostTimeBucket {
	type rec struct {
		date  string
		byDim map[string]int
		total int
	}
	buckets := map[string]*rec{}
	var dayKeys []string
	// Walk daily buckets across [startDay, endDay] inclusive on both ends.
	// The window itself (start, end) is hour-precise — a rolling
	// 168-hour span for "7d" — but the time-series buckets are calendar
	// days in the viewer's TZ (carried on start/end via end.Location()).
	// Iterating ``for d := start; d.Before(end)`` would stop before
	// adding the bucket containing ``end``, dropping today from the
	// chart. Truncate to day boundaries and iterate inclusive.
	loc := end.Location()
	startDay := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	endDay := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, loc)
	for d := startDay; !d.After(endDay); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		buckets[k] = &rec{date: k, byDim: map[string]int{}}
		dayKeys = append(dayKeys, k)
	}
	now := time.Now().UTC()
	for _, r := range runs {
		cents := computeRunCents(r, now)
		if cents == nil {
			continue
		}
		// Convert Started (UTC, from SQLite) into the viewer's TZ
		// before extracting the date key. A run that started at
		// 06-03T03:00 UTC is "06-02 evening" in US-Central — it
		// belongs in the local 06-02 bucket, not 06-03.
		key := r.Started.In(loc).Format("2006-01-02")
		b, ok := buckets[key]
		if !ok {
			continue
		}
		dimKey := "all"
		if stack != "none" {
			dimKey = runStackKey(r, stack)
		}
		b.byDim[dimKey] += *cents
		b.total += *cents
	}
	out := make([]CostTimeBucket, 0, len(dayKeys))
	for _, k := range dayKeys {
		b := buckets[k]
		out = append(out, CostTimeBucket{
			Start:       k,
			TotalCents:  b.total,
			ByDimension: b.byDim,
		})
	}
	return out
}

// runStackKey extracts a single dimension value from a costRun.
// Mirrors the frontend seed's groupByKey.
func runStackKey(r costRun, dim string) string {
	switch dim {
	case "submitter":
		if r.SubmittedBy == "" {
			return "unknown"
		}
		return r.SubmittedBy
	case "repo":
		if r.Repo == "" {
			return "unknown"
		}
		return r.Repo
	case "gpu_type":
		if r.GPUType == "" {
			return "unknown"
		}
		return r.GPUType
	case "backend":
		if r.Backend == "" {
			return "unknown"
		}
		return r.Backend
	case "outcome":
		switch r.Outcome {
		case "success":
			return "success"
		case "":
			if r.Active {
				return "in_flight"
			}
			return "unknown"
		default:
			return "failed"
		}
	}
	return "unknown"
}

// buildBreakdownFromRuns groups runs by the dimension, summing
// hours/cents/submits + computing each row's percent of total. One
// submit row counts as one submit (no inflation from multi-run
// versions now that SQLite enforces one row per (experiment, version)).
func buildBreakdownFromRuns(runs []costRun, dim string, total int) CostBreakdown {
	type acc struct {
		submits int
		hours   float64
		cents   int
	}
	now := time.Now().UTC()
	groups := map[string]*acc{}
	for _, r := range runs {
		key := runStackKey(r, dim)
		a, ok := groups[key]
		if !ok {
			a = &acc{}
			groups[key] = a
		}
		a.submits++
		hours, _ := runHours(r, now)
		a.hours += hours
		if cents := computeRunCents(r, now); cents != nil {
			a.cents += *cents
		}
	}
	rows := make([]CostBreakdownRow, 0, len(groups))
	for k, a := range groups {
		var pct float64
		if total > 0 {
			pct = float64(a.cents) / float64(total) * 100
		}
		rows = append(rows, CostBreakdownRow{
			Key:     k,
			Submits: a.submits,
			Hours:   roundTo(a.hours, 2),
			Cents:   a.cents,
			Pct:     pct,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].Cents > rows[j].Cents
	})
	return CostBreakdown{Dimension: dim, Rows: rows}
}

// --- Small helpers ---

func defaultStr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// parseTZParam turns a ``?tz=`` query param value into a Go Location.
// The frontend passes the viewer's IANA name (e.g. "America/Chicago")
// from ``Intl.DateTimeFormat().resolvedOptions().timeZone``. Falls back
// to UTC for missing or unknown zones — better to render UTC-aligned
// buckets than to 500 on a TZ string the Go zoneinfo database doesn't
// recognize.
func parseTZParam(tz string) *time.Location {
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.UTC
	}
	return loc
}

// parseISO parses an ISO-8601 timestamp string written by the engine
// (e.g. "2026-05-06T00:25:34.784457+00:00"). Returns zero on empty
// or malformed input.
func parseISO(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		// Some legacy ISO writers omit timezone; tolerate that.
		if t2, err2 := time.Parse("2006-01-02T15:04:05.999999999", s); err2 == nil {
			return t2.UTC()
		}
		return time.Time{}
	}
	return t.UTC()
}

func roundTo(v float64, decimals int) float64 {
	multiplier := 1.0
	for i := 0; i < decimals; i++ {
		multiplier *= 10
	}
	return float64(int(v*multiplier+0.5)) / multiplier
}

var _ = json.Marshal // keep encoding/json import live
