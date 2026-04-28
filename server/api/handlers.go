package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Handler holds route handlers and the Aim client.
type Handler struct {
	aim    *AimClient
	state  *StateReader
	colors []string
}

// NewHandler creates a Handler with the given Aim client, state reader, and color palette.
func NewHandler(aim *AimClient, state *StateReader, colors []string) *Handler {
	return &Handler{aim: aim, state: state, colors: colors}
}

// --- JSON response types ---

type ExperimentSummary struct {
	Name      string `json:"name"`
	State     string `json:"state"`
	GPUType   string `json:"gpu_type"`
	StartedAt string `json:"started_at"`
	Duration  string `json:"duration"`
	Outcome   string `json:"outcome"`
	RunCount  int    `json:"run_count"`
	// v1.2.0 fields the dashboard frontend reads. Empty string / zero
	// values are tolerated by the dashboard's fallbacks for legacy
	// state files that pre-date these.
	Repo         string            `json:"repo,omitempty"`
	LinearDocURL string            `json:"linear_doc_url,omitempty"`
	VersionCount int               `json:"version_count,omitempty"`
	StateHistory []StateTransition `json:"state_history,omitempty"`
	// v1.4.0 — surfaced for the home-page filter shelf. Read from
	// the experiment's state file (ExperimentRecord.submitted_by). The
	// frontend renders this verbatim in the Submitter dropdown; legacy
	// records (pre-v1.2.1) have it empty and bucket under "unknown".
	SubmittedBy string `json:"submitted_by,omitempty"`
}

type RunSummary struct {
	Hash           string  `json:"hash"`
	Name           string  `json:"name"`
	ExperimentName string  `json:"experiment"`
	CreationTime   float64 `json:"creation_time"`
	EndTime        float64 `json:"end_time"`
	Active         bool    `json:"active"`
	Duration       string  `json:"duration"`
	// v1.2.0 — which submit produced this run. Empty for legacy runs
	// that pre-date the astrolabe.version tag; the dashboard falls
	// back to "v1" in that case.
	Version  string `json:"version,omitempty"`
	SubmitID string `json:"submit_id,omitempty"`
	// v1.4.0 — submitter identity from the astrolabe.user tag. Used
	// by the dashboard's stats table to show "by alice" when comparing
	// across users; empty for legacy runs.
	SubmittedBy string `json:"submitted_by,omitempty"`
}

type RunDetail struct {
	Hash           string        `json:"hash"`
	Name           string        `json:"name"`
	ExperimentName string        `json:"experiment"`
	CreationTime   float64       `json:"creation_time"`
	EndTime        float64       `json:"end_time"`
	Active         bool          `json:"active"`
	Duration       string        `json:"duration"`
	Metrics        []MetricEntry `json:"metrics"`
	FinalLoss      *float64      `json:"final_loss"`
	// v1.2.0 — see RunSummary for the same notes.
	Version  string `json:"version,omitempty"`
	SubmitID string `json:"submit_id,omitempty"`
	// v1.4.0 — see RunSummary.
	SubmittedBy string `json:"submitted_by,omitempty"`
}

type MetricResponse struct {
	Name      string    `json:"name"`
	Steps     []int     `json:"steps"`
	Values    []float64 `json:"values"`
	// WallTimes — elapsed seconds since run start at each step. Populated
	// when the run's wall_time metric is available (the AstrolabeLogger
	// callback writes it). Omitted when missing — frontend falls back
	// to step number for the wall-time x-axis.
	WallTimes []float64 `json:"wall_times,omitempty"`
}

type MetricNameResponse struct {
	Metrics []MetricEntry `json:"metrics"`
}

type MetricEntry struct {
	Name    string                 `json:"name"`
	Context map[string]interface{} `json:"context"`
}

type IncludeEntry struct {
	Name string `json:"name"`
	// Type tells the frontend how the include resolved so it can render
	// distinct affordances (a hash chip differs from an experiment chip).
	// Values:
	//   "experiment"  — matched an Aim experiment name (multi-run)
	//   "hash"        — matched a single Aim run hash
	//   "run-name"    — matched a run.name across the corpus; resolves
	//                   to the SINGLE most recent matching run by
	//                   CreationTime (not every match — researchers
	//                   wanting wider scope can include the
	//                   experiment by name or paste specific hashes)
	//   "unknown"     — no match; frontend renders as struck-out
	Type string   `json:"type"`
	Runs []string `json:"runs"` // Aim run hashes
}

// --- Helpers: Aim run lookup ---

// aimRunIndex builds lookup maps from Aim data:
// - byAimExperiment: Aim experiment name → []RunSummary
// - byHash:          run hash → RunSummary
// - byRunName:       Aim run.name → []RunSummary (across all experiments)
//
// Each RunSummary is enriched with the astrolabe.version /
// astrolabe.submit_id tags (read from Aim run params via GetRunInfo)
// so callers can group runs by version without a second pass. The
// per-run info call is parallelized — N runs → N concurrent calls
// against Aim's REST API. For typical experiments (≤50 runs) this
// completes in ~100ms; for huge experiments it can be a noticeable
// share of the dashboard's poll cadence, but Aim's REST API can
// handle the parallelism.
//
// byRunName is the v1.4.x addition for include resolution. The same
// run.name (e.g. "astrolabe_test") often appears across multiple
// experiments — the slice preserves all matches so a run-name-shaped
// include pulls every matching run, not just one.
func (h *Handler) aimRunIndex() (
	byAimExperiment map[string][]RunSummary,
	byHash map[string]RunSummary,
	byRunName map[string][]RunSummary,
) {
	byAimExperiment = make(map[string][]RunSummary)
	byHash = make(map[string]RunSummary)
	byRunName = make(map[string][]RunSummary)

	experiments, err := h.aim.ListExperiments()
	if err != nil {
		return
	}

	// Collect runs first (cheap), then fan out version lookups in parallel.
	type runEntry struct {
		expName string
		ar      AimRun
	}
	var runEntries []runEntry
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
			runEntries = append(runEntries, runEntry{expName: exp.Name, ar: ar})
		}
	}

	// Fan-out: one GetRunInfo per run for params extraction. Skip on
	// error — the dashboard's fallback handles missing version fields.
	type indexed struct {
		i  int
		rs RunSummary
	}
	results := make(chan indexed, len(runEntries))
	var wg sync.WaitGroup
	for i, e := range runEntries {
		wg.Add(1)
		go func(i int, e runEntry) {
			defer wg.Done()
			rs := RunSummary{
				Hash:           e.ar.RunID,
				Name:           runDisplayName(e.ar, e.expName),
				ExperimentName: e.expName,
				CreationTime:   e.ar.CreationTime,
				EndTime:        e.ar.EndTime,
				Active:         e.ar.EndTime == 0,
				Duration:       formatDuration(e.ar.CreationTime, e.ar.EndTime),
			}
			if info, err := h.aim.GetRunInfo(e.ar.RunID); err == nil {
				tags := AstrolabeTagsFromParams(info.Params)
				rs.Version = tags.Version
				rs.SubmitID = tags.SubmitID
				rs.SubmittedBy = tags.SubmittedBy
			}
			results <- indexed{i: i, rs: rs}
		}(i, e)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	enriched := make([]RunSummary, len(runEntries))
	for r := range results {
		enriched[r.i] = r.rs
	}
	for _, rs := range enriched {
		if rs.Hash == "" {
			continue
		}
		byAimExperiment[rs.ExperimentName] = append(byAimExperiment[rs.ExperimentName], rs)
		byHash[rs.Hash] = rs
		// Run-name index for v1.4.x include resolution. Skip empty
		// names (Aim sometimes omits a name on runs that haven't been
		// labeled yet); they're matchable by hash anyway.
		if rs.Name != "" {
			byRunName[rs.Name] = append(byRunName[rs.Name], rs)
		}
	}
	return
}

// --- Route handlers ---

// HandleExperiments returns all experiments from state files, enriched with Aim run counts.
// GET /api/experiments
func (h *Handler) HandleExperiments(w http.ResponseWriter, r *http.Request) {
	// Get Aim runs indexed by experiment name
	aimByExp, _, _ := h.aimRunIndex()

	var experiments []ExperimentSummary

	if h.state != nil {
		states, err := h.state.ListAll()
		if err == nil {
			for _, s := range states {
				runs := aimByExp[s.Name]
				experiments = append(experiments, ExperimentSummary{
					Name:         s.Name,
					State:        s.State,
					GPUType:      s.GPUType,
					StartedAt:    s.StartedAt,
					Duration:     stateDuration(s.StartedAt, s.FinishedAt),
					Outcome:      s.Outcome,
					RunCount:     len(runs),
					Repo:         s.Repo,
					LinearDocURL: s.LinearDocURL,
					VersionCount: distinctVersionCount(runs),
					StateHistory: s.StateHistory,
					SubmittedBy:  s.SubmittedBy,
				})
			}
		}
	}

	// Sort by start time, newest first
	sort.Slice(experiments, func(i, j int) bool {
		return experiments[i].StartedAt > experiments[j].StartedAt
	})

	writeJSON(w, experiments)
}

// distinctVersionCount counts the unique astrolabe.version tag values
// across a slice of runs. Untagged runs (legacy) are bucketed together
// as a single "v1" so the count reflects what the dashboard shows.
func distinctVersionCount(runs []RunSummary) int {
	seen := make(map[string]struct{})
	for _, r := range runs {
		v := r.Version
		if v == "" {
			v = "v1"
		}
		seen[v] = struct{}{}
	}
	return len(seen)
}

// HandleExperimentRuns returns detailed Aim run info for a specific experiment.
// GET /api/experiments/{name}/runs
func (h *Handler) HandleExperimentRuns(w http.ResponseWriter, r *http.Request) {
	name := extractPathParam(r.URL.Path, "/api/experiments/", "/runs")
	if name == "" {
		http.Error(w, "missing experiment name", http.StatusBadRequest)
		return
	}

	// Find the specific experiment by name (short-circuit instead of building full index)
	experiments, err := h.aim.ListExperiments()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	var expID string
	for _, exp := range experiments {
		if exp.Name == name && !exp.Archived {
			expID = exp.ID
			break
		}
	}
	if expID == "" {
		writeJSON(w, []RunDetail{})
		return
	}

	expRuns, err := h.aim.ListExperimentRuns(expID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Fetch run info in parallel — previously this was serial per run
	type result struct {
		index  int
		detail RunDetail
	}
	results := make(chan result, len(expRuns.Runs))
	var wg sync.WaitGroup

	for i, ar := range expRuns.Runs {
		if ar.Archived {
			continue
		}
		wg.Add(1)
		go func(idx int, ar AimRun) {
			defer wg.Done()
			detail := RunDetail{
				Hash:           ar.RunID,
				Name:           runDisplayName(ar, name),
				ExperimentName: name,
				CreationTime:   ar.CreationTime,
				EndTime:        ar.EndTime,
				Active:         ar.EndTime == 0,
				Duration:       formatDuration(ar.CreationTime, ar.EndTime),
			}

			info, err := h.aim.GetRunInfo(ar.RunID)
			if err == nil {
				for _, m := range info.Traces.Metric {
					if strings.HasPrefix(m.Name, "__system__") {
						continue
					}
					detail.Metrics = append(detail.Metrics, MetricEntry{
						Name:    m.Name,
						Context: m.Context,
					})
				}
				// Aim's info.traces.metric[].last_value is unreliable —
				// observed showing the initial/default value (0.1) even
				// when the actual series has progressed. Fetch the real
				// series and take values[-1] for the displayed final loss.
				if loss, err := h.aim.GetMetric(ar.RunID, "train/loss", nil); err == nil && len(loss.Values) > 0 {
					val := loss.Values[len(loss.Values)-1]
					detail.FinalLoss = &val
				}
				// Extract all astrolabe.* tags. Empty strings are fine —
				// the frontend falls back to v1 / "unknown" for legacy
				// runs that pre-date the tagging.
				tags := AstrolabeTagsFromParams(info.Params)
				detail.Version = tags.Version
				detail.SubmitID = tags.SubmitID
				detail.SubmittedBy = tags.SubmittedBy
			}
			results <- result{index: idx, detail: detail}
		}(i, ar)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	// Collect in original order
	detailsByIndex := make(map[int]RunDetail)
	for r := range results {
		detailsByIndex[r.index] = r.detail
	}
	details := make([]RunDetail, 0, len(detailsByIndex))
	for i := 0; i < len(expRuns.Runs); i++ {
		if d, ok := detailsByIndex[i]; ok {
			details = append(details, d)
		}
	}

	writeJSON(w, details)
}

// HandleExperimentIncludes returns the --include entries for an experiment,
// resolved to Aim run hashes.
//
// Resolution order (first match wins):
//
//  1. Hash       — input matches /^[a-f0-9]{16,}$/. Treated as an Aim run
//                  hash and looked up directly. Single-run include.
//  2. Experiment — input exact-matches an Aim experiment name. Multi-run
//                  include (every run of that experiment).
//  3. Run name   — input exact-matches an Aim run.name across all
//                  experiments. Pulls every matching run; type becomes
//                  "run-name-multi" when matches span >1 experiment so
//                  the frontend can flag the wider scope.
//  4. Unknown    — no match. Returned with type="unknown" and an empty
//                  Runs slice so the frontend can render a struck-out
//                  chip rather than silently dropping the include.
//
// GET /api/experiments/{name}/includes
func (h *Handler) HandleExperimentIncludes(w http.ResponseWriter, r *http.Request) {
	name := extractPathParam(r.URL.Path, "/api/experiments/", "/includes")
	if name == "" {
		http.Error(w, "missing experiment name", http.StatusBadRequest)
		return
	}

	if h.state == nil {
		writeJSON(w, map[string]interface{}{"includes": []IncludeEntry{}})
		return
	}

	includeNames, err := h.state.GetIncludes(name)
	if err != nil || len(includeNames) == 0 {
		writeJSON(w, map[string]interface{}{"includes": []IncludeEntry{}})
		return
	}

	aimByExp, byHash, byRunName := h.aimRunIndex()

	resolved := make([]IncludeEntry, 0, len(includeNames))
	for _, incName := range includeNames {
		resolved = append(resolved, resolveInclude(incName, aimByExp, byHash, byRunName))
	}

	writeJSON(w, map[string]interface{}{"includes": resolved})
}

// resolveInclude applies the four-step resolution order to a single
// include identifier. Pure function over the indexes built by
// aimRunIndex — easy to unit-test without a real Aim instance.
func resolveInclude(
	incName string,
	byAimExperiment map[string][]RunSummary,
	byHash map[string]RunSummary,
	byRunName map[string][]RunSummary,
) IncludeEntry {
	entry := IncludeEntry{Name: incName, Type: "unknown", Runs: []string{}}

	// 1. Hash — strict hex check, ≥16 chars to avoid colliding with
	// short hex-shaped experiment names. Aim hashes are 24+ in
	// practice; the 16-char floor leaves headroom without forcing the
	// caller to type the full hash.
	if isHashLike(incName) {
		if rs, ok := byHash[incName]; ok {
			entry.Type = "hash"
			entry.Runs = []string{rs.Hash}
			return entry
		}
		// Hash-shaped but not found — fall through to other resolvers
		// in case a future Aim layout changes the hash shape. Today
		// nothing else matches a hex-shaped string, so this falls
		// straight through to "unknown".
	}

	// 2. Aim experiment name — exact match, multi-run.
	if runs, ok := byAimExperiment[incName]; ok && len(runs) > 0 {
		entry.Type = "experiment"
		entry.Runs = make([]string, 0, len(runs))
		for _, r := range runs {
			entry.Runs = append(entry.Runs, r.Hash)
		}
		return entry
	}

	// 3. Run name — exact match across all experiments, narrowed to
	// the SINGLE most recent matching run. The same run.name often
	// appears across many experiments (e.g. "astrolabe_test" is the
	// inner training name for several different experiment configs);
	// pulling every match flooded the comparison set with versions
	// the user didn't ask for. Researchers who want wider scope use
	// the experiment-name path (--include=<exp>) or paste specific
	// hashes.
	if runs, ok := byRunName[incName]; ok && len(runs) > 0 {
		latest := runs[0]
		for _, r := range runs[1:] {
			if r.CreationTime > latest.CreationTime {
				latest = r
			}
		}
		entry.Type = "run-name"
		entry.Runs = []string{latest.Hash}
		return entry
	}

	// 4. No match. Empty Runs, type="unknown" — frontend renders as
	// a struck-out unresolved chip so the operator sees the dropped
	// include rather than wondering why their compare set is short.
	return entry
}

// isHashLike returns true if s looks like an Aim run hash: lowercase
// hex, ≥16 chars. Conservative threshold so a researcher with an
// experiment literally named "abc123" doesn't get it interpreted as a
// (non-existent) hash.
func isHashLike(s string) bool {
	if len(s) < 16 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// HandleRuns returns all runs across all experiments (flat list).
// GET /api/runs
func (h *Handler) HandleRuns(w http.ResponseWriter, r *http.Request) {
	_, byHash, _ := h.aimRunIndex()
	var runs []RunSummary
	for _, rs := range byHash {
		runs = append(runs, rs)
	}
	sort.Slice(runs, func(i, j int) bool {
		return runs[i].CreationTime > runs[j].CreationTime
	})
	writeJSON(w, runs)
}

// HandleRunMetrics returns available metric names for a run.
// GET /api/runs/{hash}/metrics
func (h *Handler) HandleRunMetrics(w http.ResponseWriter, r *http.Request) {
	hash := extractPathParam(r.URL.Path, "/api/runs/", "/metrics")
	if hash == "" {
		http.Error(w, "missing run hash", http.StatusBadRequest)
		return
	}

	info, err := h.aim.GetRunInfo(hash)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	var metrics []MetricEntry
	for _, m := range info.Traces.Metric {
		if strings.HasPrefix(m.Name, "__system__") {
			continue
		}
		metrics = append(metrics, MetricEntry{
			Name:    m.Name,
			Context: m.Context,
		})
	}

	writeJSON(w, MetricNameResponse{Metrics: metrics})
}

// HandleMetricData returns step/value data for a specific metric.
// GET /api/runs/{hash}/metrics/{name}
func (h *Handler) HandleMetricData(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	prefix := "/api/runs/"
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(rest, "/metrics/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, "invalid path: expected /api/runs/{hash}/metrics/{name}", http.StatusBadRequest)
		return
	}
	hash := parts[0]
	metricName := parts[1]

	data, err := h.aim.GetMetric(hash, metricName, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	resp := MetricResponse{
		Name:   data.Name,
		Steps:  data.Iters,
		Values: data.Values,
	}

	// Try to attach wall_time per step. The AstrolabeLogger writes
	// `wall_time` as its own metric (elapsed seconds since run start).
	// Indexing by step lets us zip it with any other metric without
	// caring whether the two metrics were tracked at exactly the same
	// moments. Skip the fetch when the requested metric IS wall_time —
	// that would be circular and pointless.
	if metricName != "wall_time" {
		if wt, err := h.aim.GetMetric(hash, "wall_time", nil); err == nil && len(wt.Iters) > 0 {
			byStep := make(map[int]float64, len(wt.Iters))
			for i, step := range wt.Iters {
				byStep[step] = wt.Values[i]
			}
			times := make([]float64, len(data.Iters))
			anyMatched := false
			for i, step := range data.Iters {
				if v, ok := byStep[step]; ok {
					times[i] = v
					anyMatched = true
				}
			}
			if anyMatched {
				resp.WallTimes = times
			}
		}
	}

	writeJSON(w, resp)
}

// HandleRunInfo returns full run info (props + metric list).
// GET /api/runs/{hash}/info
func (h *Handler) HandleRunInfo(w http.ResponseWriter, r *http.Request) {
	hash := extractPathParam(r.URL.Path, "/api/runs/", "/info")
	if hash == "" {
		http.Error(w, "missing run hash", http.StatusBadRequest)
		return
	}

	info, err := h.aim.GetRunInfo(hash)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	writeJSON(w, info)
}

// HandleColors returns the configured color palette.
// GET /api/config/colors
func (h *Handler) HandleColors(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string][]string{"palette": h.colors})
}

// HandleHealth checks Aim API connectivity.
// GET /api/health
func (h *Handler) HandleHealth(w http.ResponseWriter, r *http.Request) {
	_, err := h.aim.ListExperiments()
	if err != nil {
		writeJSON(w, map[string]interface{}{"status": "error", "message": err.Error()})
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func extractPathParam(path, prefix, suffix string) string {
	rest := strings.TrimPrefix(path, prefix)
	if suffix != "" {
		idx := strings.Index(rest, suffix)
		if idx < 0 {
			return ""
		}
		rest = rest[:idx]
	}
	return rest
}

// runDisplayName picks the label shown to the user for a single Aim run.
//
// Prefers the run's own name (set by the training callback from Composer's
// `run_name` — e.g. "astrolabe_test_v2") so multiple runs within one
// experiment are distinguishable. Falls back to the experiment name when
// Aim returned its default placeholder ("Run: <hash>") or an empty name,
// since that value carries no useful information.
func runDisplayName(ar AimRun, experimentName string) string {
	name := strings.TrimSpace(ar.Name)
	if name == "" || strings.HasPrefix(name, "Run: ") {
		return experimentName
	}
	return name
}

func formatDuration(creationTime, endTime float64) string {
	start := time.Unix(int64(creationTime), 0)
	var end time.Time
	if endTime > 0 {
		end = time.Unix(int64(endTime), 0)
	} else {
		end = time.Now()
	}
	d := end.Sub(start)
	if d.Hours() >= 1 {
		h := int(d.Hours())
		m := int(d.Minutes()) % 60
		if m == 0 {
			return strings.TrimRight(d.Truncate(time.Hour).String(), "0s") + ""
		}
		_ = h
		return d.Truncate(time.Minute).String()
	}
	return d.Truncate(time.Second).String()
}

func stateDuration(startedAt, finishedAt string) string {
	if startedAt == "" {
		return ""
	}
	start, err := time.Parse(time.RFC3339, startedAt)
	if err != nil {
		// Try ISO format without timezone
		start, err = time.Parse("2006-01-02T15:04:05", startedAt[:19])
		if err != nil {
			return ""
		}
	}
	var end time.Time
	if finishedAt != "" {
		end, err = time.Parse(time.RFC3339, finishedAt)
		if err != nil {
			end, _ = time.Parse("2006-01-02T15:04:05", finishedAt[:19])
		}
	} else {
		end = time.Now()
	}
	d := end.Sub(start)
	if d.Hours() >= 1 {
		return strings.Replace(d.Truncate(time.Minute).String(), "h0m", "h", 1)
	}
	return d.Truncate(time.Second).String()
}
