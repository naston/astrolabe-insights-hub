package api

// Cost endpoint. Renders the dashboard's /cost page driven from Aim
// runs (one per submit version), with state files joined in only for
// per-experiment metadata (repo, backend) that doesn't vary across
// versions of the same experiment.
//
// History: pre-v1.7.4 this read solely from state files, which made
// the page show only the LATEST version per experiment — state files
// are last-write-wins. v1.7.4 added gpu_type, rate, and outcome tags
// to AIM_RUN_TAGS plus a terminal-state Aim writeback, so per-version
// spend can now be derived from Aim. State files retain their original
// role: snapshot of the latest submit, source of FSM state + repo for
// the dashboard's home page.
//
// Rate fallback for pre-v1.7.4 Aim runs: the handler builds a
// gpu_type → rate map from state files (which were backfilled by
// `astrolabe admin backfill-cost-rates`) and applies it to any Aim
// run lacking astrolabe.gpu_rate_cents_per_hour. Runs whose gpu_type
// isn't in the map render with cents=null in the response and "—" in
// the UI.

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"sync"
	"time"
)

// uuidRE matches a canonical UUID v4 string (lowercase hex with the
// 8-4-4-4-12 hyphen layout that uuid.uuid4() emits). Used to filter
// the cost endpoint to *only* astrolabe-managed Aim runs — non-
// astrolabe runs and the legacy ``astrolabe import tensorboard``
// imports either lack a submit_id or carry a sentinel like
// ``tb-import-…`` that we don't want to count toward spend.
var uuidRE = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
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
	Start       string         `json:"start"`        // ISO-8601 date
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

// Legacy gpu_type aliases. Mirrors astrolabe.cost.LEGACY_GPU_ALIASES on
// the engine side — Go API consults this map when it sees an Aim run
// or state file with a hand-written historical gpu_type. Append-only.
var legacyGPUAliases = map[string]string{
	"8xa100-40gb": "gpu_8x_a100",
	"8xa100-80gb": "gpu_8x_a100_80gb_sxm4",
}

// costRun is the per-Aim-run record the cost handler operates on.
// Built by gatherCostRuns from Aim's REST API + state-file metadata
// (for repo / backend, which don't vary across versions of the same
// experiment).
type costRun struct {
	Experiment  string
	Version     string
	SubmitID    string
	GPUType     string
	RateCents   int  // 0 if unresolved
	HasRate     bool // distinguishes "free" (LocalExecutor → 0) from "unknown"
	Outcome     string
	SubmittedBy string
	Repo        string
	Backend     string
	Started     time.Time
	Ended       time.Time
	Active      bool // Ended is zero
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

	now := time.Now().UTC()
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

	if h.aim == nil {
		writeJSON(w, empty)
		return
	}

	allRuns, err := h.gatherCostRuns()
	if err != nil {
		// Aim unreachable — render empty rather than 500. Cost is
		// derived data; a transient Aim outage shouldn't 5xx the page.
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

// gatherCostRuns reads every active Aim run, extracts the astrolabe
// tags relevant to cost, and joins with state-file metadata for the
// repo + backend dimensions (which don't live in Aim tags today).
//
// Pre-v1.7.4 runs lack gpu_type / rate / outcome tags; this function
// applies a rate fallback derived from state files (which were
// backfilled) keyed by gpu_type. Unmatched runs come back with
// HasRate=false and surface as cents=null in the response.
func (h *Handler) gatherCostRuns() ([]costRun, error) {
	experiments, err := h.aim.ListExperiments()
	if err != nil {
		return nil, err
	}

	// Build a gpu_type → rate fallback map from state files. The
	// engine's backfill walker has populated rates on every state file
	// that matches a known gpu_type, so this map captures whatever the
	// admin command resolved. Pre-fix Aim runs missing the rate tag
	// look up here.
	rateByGPU := map[string]int{}
	repoByExp := map[string]string{}
	backendByExp := map[string]string{}
	stateByExp := map[string]ExperimentState{}
	if h.state != nil {
		if states, err := h.state.ListAll(); err == nil {
			for _, s := range states {
				if s.GPURateCentsPerHour != nil && s.GPUType != "" {
					rateByGPU[s.GPUType] = *s.GPURateCentsPerHour
					// Mirror the alias so a legacy run tagged with the
					// short form picks up the rate too.
					if canonical, ok := legacyGPUAliases[s.GPUType]; ok {
						rateByGPU[canonical] = *s.GPURateCentsPerHour
					}
				}
				if s.Repo != "" {
					repoByExp[s.Name] = s.Repo
				}
				if s.Backend != "" {
					backendByExp[s.Name] = s.Backend
				}
				stateByExp[s.Name] = s
			}
		}
	}

	type runJob struct {
		expName string
		ar      AimRun
	}
	var jobs []runJob
	for _, exp := range experiments {
		if exp.RunCount == 0 || exp.Archived {
			continue
		}
		expRuns, err := h.aim.ListExperimentRuns(exp.ID)
		if err != nil {
			continue
		}
		for _, ar := range expRuns.Runs {
			if ar.Archived {
				continue
			}
			jobs = append(jobs, runJob{expName: exp.Name, ar: ar})
		}
	}

	// Fan-out: one GetRunInfo per run for tag extraction.
	out := make([]costRun, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func(i int, j runJob) {
			defer wg.Done()
			tags := AstrolabeTags{}
			if info, err := h.aim.GetRunInfo(j.ar.RunID); err == nil {
				tags = AstrolabeTagsFromParams(info.Params)
			}
			// Discriminator: only count runs whose submit_id is a real
			// UUID. Manual Aim runs (no astrolabe tags) and legacy
			// ``astrolabe import tensorboard`` imports (submit_id
			// sentinels like ``tb-import``) drop out here; out[i]
			// stays zero-valued and gets pruned below.
			if !uuidRE.MatchString(tags.SubmitID) {
				return
			}
			expName := tags.ExperimentName
			if expName == "" {
				expName = j.expName // Aim experiment fallback
			}
			version := tags.Version
			if version == "" {
				version = "v1" // legacy
			}
			gpuType := tags.GPUType
			if gpuType == "" {
				// Fall back to state file for the experiment — newer
				// runs have it on the tag; legacy runs need this.
				if s, ok := stateByExp[expName]; ok {
					gpuType = s.GPUType
				}
			}
			rateCents := 0
			hasRate := false
			if tags.GPURateCentsPerHour != nil {
				rateCents = *tags.GPURateCentsPerHour
				hasRate = true
			} else if r, ok := rateByGPU[gpuType]; ok {
				rateCents = r
				hasRate = true
			}
			started := unixToTime(j.ar.CreationTime)
			ended := unixToTime(j.ar.EndTime)
			out[i] = costRun{
				Experiment:  expName,
				Version:     version,
				SubmitID:    tags.SubmitID,
				GPUType:     gpuType,
				RateCents:   rateCents,
				HasRate:     hasRate,
				Outcome:     tags.Outcome,
				SubmittedBy: tags.SubmittedBy,
				Repo:        repoByExp[expName],
				Backend:     backendByExp[expName],
				Started:     started,
				Ended:       ended,
				Active:      j.ar.EndTime == 0,
			}
		}(i, j)
	}
	wg.Wait()

	// Drop runs with no started timestamp (can't price them or place
	// them in a window) and runs that were filtered out by the
	// UUID-submit_id check above (zero-valued costRun, empty
	// Experiment field is the marker).
	clean := make([]costRun, 0, len(out))
	for _, r := range out {
		if r.Started.IsZero() || r.Experiment == "" {
			continue
		}
		clean = append(clean, r)
	}
	return clean, nil
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

// runHours returns (hours, hoursPtr) for a single Aim run. For
// terminal runs (Ended set), returns (delta, &delta). For in-flight,
// returns (now-Started, nil) — the pointer being nil signals "render
// — instead of a duration" to the frontend, mirroring the prior
// state-file logic.
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
// Multi-run versions (e.g. two-model experiments where v1 ran BERT +
// LatentBERT on the same Lambda instance) bill once per version:
// instance hold time is approximated as max(Ended) - min(Started)
// across the version's runs. Lambda charges per-instance, not per-
// run, so summing run durations would overcount.
func buildExperiments(runs []costRun, now time.Time) ([]CostExperimentEntry, int) {
	type versionAgg struct {
		gpuType     string
		rateCents   int
		hasRate     bool
		outcome     string
		started     time.Time
		ended       time.Time
		anyActive   bool
		runCount    int
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
			state := deriveStateFromVersion(v.anyActive, v.outcome, v.ended)
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

// deriveStateFromVersion gives the frontend a state hint per version.
// Real FSM state is only on the state file (and only for the latest
// version). For non-latest versions we infer from Aim alone:
//   - in-flight (any run active)        → "RUNNING"
//   - terminal + outcome=success        → "COMPLETED"
//   - terminal + outcome present, !success → "FAILED"
//   - terminal + no outcome (legacy)    → "COMPLETED" (best-faith;
//     the row's outcome is empty, frontend renders "unknown")
func deriveStateFromVersion(anyActive bool, outcome string, ended time.Time) string {
	if anyActive || ended.IsZero() {
		return "RUNNING"
	}
	switch outcome {
	case "success":
		return "COMPLETED"
	case "":
		return "COMPLETED"
	default:
		return "FAILED"
	}
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
	for d := start; d.Before(end); d = d.AddDate(0, 0, 1) {
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
		key := r.Started.Format("2006-01-02")
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
// hours/cents/submits + computing each row's percent of total. The
// "submits" count is one-per-Aim-run; multi-run versions therefore
// inflate the submits column. Cleaner would be one-per-(submit_id,
// dim_value); deferring until the seam shows up in real usage.
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

// unixToTime converts an Aim timestamp (Unix seconds, possibly
// fractional). Zero → zero time.
func unixToTime(secs float64) time.Time {
	if secs <= 0 {
		return time.Time{}
	}
	whole := int64(secs)
	frac := int64((secs - float64(whole)) * 1e9)
	return time.Unix(whole, frac).UTC()
}

func roundTo(v float64, decimals int) float64 {
	multiplier := 1.0
	for i := 0; i < decimals; i++ {
		multiplier *= 10
	}
	return float64(int(v*multiplier+0.5)) / multiplier
}

var _ = json.Marshal // keep encoding/json import live
