package api

// Cost endpoint. Renders the dashboard's /cost page from state-file
// data, no Aim cross-reference in v1.
//
// Scoping rationale: per-version cost would require pulling the rate
// from somewhere durable across submits — state files only keep the
// LATEST submit per experiment. The right path is to plumb the rate
// into AIM_RUN_TAGS so each Aim run carries it, then the Go API can
// join state ↔ Aim by submit_id and render multi-version cost. That's
// a follow-up; v1 ships one row per experiment.
//
// The frontend's CostExperimentEntry shape has a versions[] slice —
// v1 always returns a single-element slice (the latest submit). Once
// per-version rates are available we just lengthen the slice.

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
	Window           CostWindow              `json:"window"`
	TotalCents       int                     `json:"total_cents"`
	PriorTotalCents  int                     `json:"prior_total_cents"`
	TimeSeries       []CostTimeBucket        `json:"time_series"`
	Breakdown        CostBreakdown           `json:"breakdown"`
	Experiments      []CostExperimentEntry   `json:"experiments"`
}

type CostWindow struct {
	Start  string `json:"start"`  // ISO-8601
	End    string `json:"end"`    // ISO-8601
	Label  string `json:"label"`  // 7d | 30d | 90d | all | custom
	Bucket string `json:"bucket"` // daily | weekly | monthly
}

type CostTimeBucket struct {
	Start       string         `json:"start"`         // ISO-8601 date
	TotalCents  int            `json:"total_cents"`
	ByDimension map[string]int `json:"by_dimension"`  // dimension key → cents
}

type CostBreakdown struct {
	Dimension string              `json:"dimension"`
	Rows      []CostBreakdownRow  `json:"rows"`
}

type CostBreakdownRow struct {
	Key     string  `json:"key"`
	Submits int     `json:"submits"`
	Hours   float64 `json:"hours"`
	Cents   int     `json:"cents"`
	Pct     float64 `json:"pct"`
}

type CostExperimentEntry struct {
	Name       string                  `json:"name"`
	TotalHours float64                 `json:"total_hours"`
	TotalCents int                     `json:"total_cents"`
	Versions   []CostVersionEntry      `json:"versions"`
}

type CostVersionEntry struct {
	Version        string   `json:"version"`
	GPUType        string   `json:"gpu_type"`
	State          string   `json:"state"`
	Outcome        string   `json:"outcome"`
	Hours          *float64 `json:"hours"`           // nil = in-flight
	Cents          *int     `json:"cents"`           // nil = in-flight
	EstimatedCents int      `json:"estimated_cents"` // always populated
}

// Legacy gpu_type aliases. Mirrors astrolabe.cost.LEGACY_GPU_ALIASES on
// the engine side — Go API consults this map when it sees a state file
// with a hand-written historical gpu_type. Append-only.
var legacyGPUAliases = map[string]string{
	"8xa100-40gb": "gpu_8x_a100",
	"8xa100-80gb": "gpu_8x_a100_80gb_sxm4",
}

// HandleCost serves GET /api/cost. Query params:
//
//	window   = 7d | 30d | 90d | all  (default 30d)
//	group_by = submitter | repo | gpu_type | outcome | backend  (default submitter)
//	stack    = none | <group_by values>  (default none)
//
// State files only — see file header for the v1 scoping rationale.
func (h *Handler) HandleCost(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	window := defaultStr(q.Get("window"), "30d")
	groupBy := defaultStr(q.Get("group_by"), "submitter")
	stack := defaultStr(q.Get("stack"), "none")

	now := time.Now().UTC()
	winStart, winEnd, bucket, label := resolveWindow(window, now)

	if h.state == nil {
		// No state dir configured — return empty response so the
		// frontend renders "No spend in window" gracefully.
		writeJSON(w, CostResponse{
			Window: CostWindow{
				Start:  winStart.Format(time.RFC3339),
				End:    winEnd.Format(time.RFC3339),
				Label:  label,
				Bucket: bucket,
			},
			TimeSeries: []CostTimeBucket{},
			Breakdown: CostBreakdown{
				Dimension: groupBy,
				Rows:      []CostBreakdownRow{},
			},
			Experiments: []CostExperimentEntry{},
		})
		return
	}

	states, err := h.state.ListAll()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Filter to records that fall inside the window. A record's
	// "time" for filtering purposes is its started_at; missing
	// timestamps are skipped (can't price them).
	inWindow := make([]ExperimentState, 0, len(states))
	for _, s := range states {
		t, ok := parseRFC3339Lenient(s.StartedAt)
		if !ok {
			continue
		}
		if t.Before(winStart) || t.After(winEnd) {
			continue
		}
		inWindow = append(inWindow, s)
	}

	// Build the experiments list. v1: one entry per state file, one
	// version row inside it. The version field defaults to "v1" for
	// pre-versioning records.
	experiments := make([]CostExperimentEntry, 0, len(inWindow))
	var totalCents int
	for _, s := range inWindow {
		hours, hoursPtr := computeHours(s, now)
		rate, hasRate := resolvedRate(s)
		var centsPtr *int
		if hasRate && hoursPtr != nil {
			c := int(float64(rate) * (*hoursPtr))
			centsPtr = &c
			totalCents += c
		}
		// Estimate falls back to record's persisted value, or rate*budget
		// if available. Budget hours isn't surfaced through state files
		// today — leave as the persisted estimate or 0.
		estimated := 0
		if s.EstimatedCostCents != nil {
			estimated = *s.EstimatedCostCents
		}
		version := s.Version
		if version == "" {
			version = "v1"
		}
		experiments = append(experiments, CostExperimentEntry{
			Name:       s.Name,
			TotalHours: hours,
			TotalCents: derefIntZero(centsPtr),
			Versions: []CostVersionEntry{{
				Version:        version,
				GPUType:        s.GPUType,
				State:          s.State,
				Outcome:        normalizeOutcomeStr(s.Outcome, s.State),
				Hours:          hoursPtr,
				Cents:          centsPtr,
				EstimatedCents: estimated,
			}},
		})
	}

	// Sort experiments by total cost desc (matches the frontend's
	// expectation of "costliest first").
	sort.Slice(experiments, func(i, j int) bool {
		return experiments[i].TotalCents > experiments[j].TotalCents
	})

	// Time series: bucket into days. For the "all" window we still
	// bucket daily; switch to weekly/monthly only on very long
	// windows. v1 keeps it simple — frontend handles the X-axis
	// rendering regardless of granularity.
	timeSeries := buildTimeSeries(inWindow, winStart, winEnd, stack)

	// Breakdown: group records by the requested dimension.
	breakdown := buildBreakdown(inWindow, groupBy, now, totalCents)

	// Prior window total — same range shifted back by `days`. Skipped
	// (left as 0) when window is "all"; the frontend suppresses the
	// delta display in that case.
	var priorTotal int
	if label != "all" {
		days := int(winEnd.Sub(winStart).Hours() / 24)
		priorStart := winStart.AddDate(0, 0, -days)
		priorEnd := winStart
		for _, s := range states {
			t, ok := parseRFC3339Lenient(s.StartedAt)
			if !ok || t.Before(priorStart) || !t.Before(priorEnd) {
				continue
			}
			hours, _ := computeHours(s, now)
			rate, hasRate := resolvedRate(s)
			if hasRate {
				priorTotal += int(float64(rate) * hours)
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

// resolvedRate returns the rate for a state file, applying the legacy
// alias fallback when the recorded gpu_type doesn't match what was
// originally persisted. Returns (rate, hasRate). Backfilled records
// already have GPURateCentsPerHour set; this function exists to handle
// records that never went through backfill but whose gpu_type the
// alias map can recover.
//
// Note: this function CANNOT recover rates we don't have stored
// somewhere. If GPURateCentsPerHour is nil and the gpu_type isn't in
// the alias map, we return (0, false) and the cost UI shows "—".
func resolvedRate(s ExperimentState) (int, bool) {
	if s.GPURateCentsPerHour != nil {
		return *s.GPURateCentsPerHour, true
	}
	// No persisted rate — try the legacy alias. Without an in-process
	// rate cache this is informational only (we don't know what rate
	// applies to "gpu_8x_a100" without asking Lambda, which we don't
	// do from the dashboard). Return (0, false); cost shows "—".
	if _, ok := legacyGPUAliases[s.GPUType]; ok {
		return 0, false
	}
	return 0, false
}

// computeHours returns elapsed hours for a state file. For terminal
// runs, finished_at - started_at. For in-flight runs (finished_at
// missing), now - started_at — but the version-row Hours pointer is
// nil so the frontend renders "—" and uses estimated cost instead.
//
// Returns (hoursFloat, hoursPtr) where hoursPtr is nil for in-flight.
func computeHours(s ExperimentState, now time.Time) (float64, *float64) {
	start, ok := parseRFC3339Lenient(s.StartedAt)
	if !ok {
		return 0, nil
	}
	if s.FinishedAt == "" {
		// In-flight — frontend shows "—" for hours + estimated cost.
		return now.Sub(start).Hours(), nil
	}
	end, ok := parseRFC3339Lenient(s.FinishedAt)
	if !ok {
		return 0, nil
	}
	h := end.Sub(start).Hours()
	if h < 0 {
		return 0, nil
	}
	return h, &h
}

// normalizeOutcomeStr collapses astrolabe's raw outcome vocabulary
// (success, failure, timeout, stopped) into the cost page's {success,
// failed} bucket. Matches the frontend's TERMINAL_FAIL_OUTCOMES set
// and the seed's groupByKey. In-flight rows pass empty outcome.
func normalizeOutcomeStr(outcome, state string) string {
	switch outcome {
	case "success":
		return "success"
	case "":
		// No outcome yet — either in-flight or pre-terminal.
		if state == "" || state == "PENDING" || state == "ACQUIRING" ||
			state == "SETUP" || state == "RUNNING" || state == "HEALING" ||
			state == "SUMMARIZING" {
			return ""
		}
		return ""
	default:
		return "failed"
	}
}

// buildTimeSeries buckets in-window records into daily slots, keying
// the contribution by the requested stack dimension. "none" funnels
// everything into a single "all" key so the chart renders flat bars.
func buildTimeSeries(states []ExperimentState, start, end time.Time, stack string) []CostTimeBucket {
	// Pre-create buckets for every day so the chart has continuous
	// x-axis points even on quiet days.
	type rec struct {
		date   string
		byDim  map[string]int
		total  int
	}
	buckets := map[string]*rec{}
	var dayKeys []string
	for d := start; d.Before(end); d = d.AddDate(0, 0, 1) {
		k := d.Format("2006-01-02")
		buckets[k] = &rec{date: k, byDim: map[string]int{}}
		dayKeys = append(dayKeys, k)
	}
	for _, s := range states {
		t, ok := parseRFC3339Lenient(s.StartedAt)
		if !ok {
			continue
		}
		// Assign the full cost to the experiment's started_at date.
		// Pro-rating multi-day runs would be more accurate but
		// adds complexity without much value for cost rollups.
		now := time.Now().UTC()
		hours, _ := computeHours(s, now)
		rate, hasRate := resolvedRate(s)
		if !hasRate {
			continue
		}
		cents := int(float64(rate) * hours)
		key := t.Format("2006-01-02")
		b, ok := buckets[key]
		if !ok {
			continue
		}
		dimKey := "all"
		if stack != "none" {
			dimKey = stackKey(s, stack)
		}
		b.byDim[dimKey] += cents
		b.total += cents
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

// stackKey extracts the stack dimension's value from a record. Mirrors
// the seed's groupByKey on the frontend.
func stackKey(s ExperimentState, dim string) string {
	switch dim {
	case "submitter":
		if s.SubmittedBy == "" {
			return "unknown"
		}
		return s.SubmittedBy
	case "repo":
		if s.Repo == "" {
			return "unknown"
		}
		return s.Repo
	case "gpu_type":
		return s.GPUType
	case "backend":
		if s.Backend == "" {
			return "unknown"
		}
		return s.Backend
	case "outcome":
		o := normalizeOutcomeStr(s.Outcome, s.State)
		if o == "" {
			return "in_flight"
		}
		return o
	}
	return "unknown"
}

// buildBreakdown groups records by the dimension, summing hours/cents/
// submits + computing each row's percent of total. Sorted by cents desc.
func buildBreakdown(states []ExperimentState, dim string, now time.Time, total int) CostBreakdown {
	type acc struct {
		submits int
		hours   float64
		cents   int
	}
	groups := map[string]*acc{}
	for _, s := range states {
		key := stackKey(s, dim)
		a, ok := groups[key]
		if !ok {
			a = &acc{}
			groups[key] = a
		}
		a.submits++
		hours, _ := computeHours(s, now)
		a.hours += hours
		if rate, hasRate := resolvedRate(s); hasRate {
			a.cents += int(float64(rate) * hours)
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

func parseRFC3339Lenient(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	// Try the bare-ISO form some legacy records use.
	if t, err := time.Parse("2006-01-02T15:04:05", s[:min(len(s), 19)]); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func derefIntZero(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func roundTo(v float64, decimals int) float64 {
	multiplier := 1.0
	for i := 0; i < decimals; i++ {
		multiplier *= 10
	}
	return float64(int(v*multiplier+0.5)) / multiplier
}

// CostResponse needs a writer; reuse the package's writeJSON. Verify
// it's in scope by reading handlers.go. (It is — writeJSON lives at
// the bottom of that file.)
var _ = json.Marshal // keep encoding/json import live for godoc lookups

// min for Go < 1.21 compat — newer Go has it built in, but be cautious.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
