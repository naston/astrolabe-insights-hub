package api

// Tests for the cost handler. Contract under test (per
// astrolabe-insights-hub/src/lib/types.ts):
//
//   - No Aim runs → response has empty arrays, no panic
//   - Run outside the window → excluded
//   - Run with no rate (no astrolabe.gpu_rate_cents_per_hour tag AND
//     no state-file fallback) → version cents=nil, total=0, but the
//     run still counts in submits/hours
//   - Local backend (rate=0 tag) → submits=1, cents contribution=0
//   - Multi-submitter window → totals/percentages add up; biggest first
//   - group_by dimension is honored
//   - stack dimension is honored in the time series; "none" funnels
//     into a single "all" key
//   - Outcome tag dispatches to "success" / "failed" buckets
//   - prior_total_cents is 0 for window=all
//   - Multiple versions of the same experiment surface as multiple
//     CostVersionEntry rows under one CostExperimentEntry
//   - Pre-v1.7.4 runs (missing rate tag) pick up rates from state
//     files when the experiment's gpu_type matches

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- Fake Aim --------------------------------------------------------------

// fakeRun describes one Aim run for the fake server. Tag map keys
// should use the dotted form ("astrolabe.version") to mirror what the
// callback writes; the handler also accepts the nested form but the
// dotted form is the production layout.
type fakeRun struct {
	experiment   string  // Aim experiment name
	hash         string
	creationTime float64 // unix seconds; 0 means missing
	endTime      float64 // 0 means in-flight
	tags         map[string]any
}

// fakeAim spins up an httptest.Server that mimics the three Aim REST
// endpoints the cost handler hits: list experiments, list runs per
// experiment, get run info (for params/tags). The returned client
// points at the server; t.Cleanup tears it down.
func fakeAim(t *testing.T, runs []fakeRun) *AimClient {
	t.Helper()

	// Bucket runs by experiment, assigning stable IDs.
	byExp := map[string][]fakeRun{}
	for _, r := range runs {
		byExp[r.experiment] = append(byExp[r.experiment], r)
	}
	expIDs := map[string]string{}
	i := 0
	for name := range byExp {
		expIDs[name] = fmt.Sprintf("exp-%d", i)
		i++
	}
	idToName := map[string]string{}
	for name, id := range expIDs {
		idToName[id] = name
	}

	// One dispatcher handles all three routes. Using net/http's default
	// pattern matcher here is fiddly (overlapping /api/experiments/
	// prefixes), so we just inspect the path ourselves.
	dispatch := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/api/experiments/" || path == "/api/experiments":
			out := make([]Experiment, 0, len(expIDs))
			for name, id := range expIDs {
				out = append(out, Experiment{
					ID:       id,
					Name:     name,
					RunCount: len(byExp[name]),
				})
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(out)

		case strings.HasPrefix(path, "/api/experiments/") && strings.HasSuffix(path, "/runs/"):
			id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/experiments/"), "/runs/")
			name, ok := idToName[id]
			if !ok {
				http.NotFound(w, r)
				return
			}
			runs := byExp[name]
			out := ExperimentRuns{ID: id}
			for _, fr := range runs {
				out.Runs = append(out.Runs, AimRun{
					RunID:        fr.hash,
					Name:         fr.hash,
					CreationTime: fr.creationTime,
					EndTime:      fr.endTime,
				})
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(out)

		case strings.HasPrefix(path, "/api/runs/"):
			rest := strings.TrimPrefix(path, "/api/runs/")
			parts := strings.Split(rest, "/")
			if len(parts) < 2 || parts[1] != "info" {
				http.NotFound(w, r)
				return
			}
			hash := parts[0]
			for _, list := range byExp {
				for _, fr := range list {
					if fr.hash == hash {
						w.Header().Set("Content-Type", "application/json")
						_ = json.NewEncoder(w).Encode(RunInfo{Params: fr.tags})
						return
					}
				}
			}
			http.NotFound(w, r)

		default:
			http.NotFound(w, r)
		}
	})

	srv := httptest.NewServer(dispatch)
	t.Cleanup(srv.Close)
	return NewAimClient(srv.URL)
}

// makeHandlerWithAim wires a handler with the given AimClient and a
// state-dir-backed StateReader. Both may be nil where not needed.
func makeHandlerWithAim(t *testing.T, aim *AimClient, stateDir string) *Handler {
	t.Helper()
	var sr *StateReader
	if stateDir != "" {
		sr = NewStateReader(stateDir)
	}
	return NewHandler(aim, sr, nil)
}

func writeState(t *testing.T, dir, name string, body map[string]any) {
	t.Helper()
	body["name"] = name
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func callCost(t *testing.T, h *Handler, query string) CostResponse {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/cost?"+query, nil)
	rr := httptest.NewRecorder()
	h.HandleCost(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp CostResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

// unixSecs returns the Unix-seconds float representation of a time —
// matches Aim's serialization.
func unixSecs(t time.Time) float64 {
	return float64(t.Unix()) + float64(t.Nanosecond())/1e9
}

func tagSet(experiment, version, submitID, user, gpuType, outcome string, rate *int) map[string]any {
	m := map[string]any{
		"astrolabe.experiment": experiment,
		"astrolabe.version":    version,
		"astrolabe.submit_id":  submitID,
	}
	if user != "" {
		m["astrolabe.user"] = user
	}
	if gpuType != "" {
		m["astrolabe.gpu_type"] = gpuType
	}
	if outcome != "" {
		m["astrolabe.outcome"] = outcome
	}
	if rate != nil {
		m["astrolabe.gpu_rate_cents_per_hour"] = fmt.Sprintf("%d", *rate)
	}
	return m
}

func intPtr(v int) *int { return &v }

// --- Edge cases ------------------------------------------------------------

func TestHandleCostEmptyAim(t *testing.T) {
	h := makeHandlerWithAim(t, fakeAim(t, nil), "")
	resp := callCost(t, h, "window=30d")
	if resp.TotalCents != 0 {
		t.Fatalf("expected 0 total, got %d", resp.TotalCents)
	}
	if resp.Window.Label != "30d" {
		t.Fatalf("expected label 30d, got %q", resp.Window.Label)
	}
	if resp.Experiments == nil || resp.TimeSeries == nil || resp.Breakdown.Rows == nil {
		t.Fatalf("nil slices in response — frontend will choke")
	}
}

func TestHandleCostNilAim(t *testing.T) {
	// nil AimClient → still returns an empty, well-shaped response.
	// Mirrors the deploy state on a brand-new NUC where aim isn't
	// configured yet; the dashboard shouldn't 5xx in that state.
	h := makeHandlerWithAim(t, nil, "")
	resp := callCost(t, h, "window=30d")
	if resp.TotalCents != 0 {
		t.Fatalf("expected 0 total, got %d", resp.TotalCents)
	}
}

func TestRunOutsideWindowExcluded(t *testing.T) {
	old := time.Now().UTC().AddDate(0, 0, -60)
	aim := fakeAim(t, []fakeRun{{
		experiment:   "old-run",
		hash:         "abc",
		creationTime: unixSecs(old),
		endTime:      unixSecs(old.Add(time.Hour)),
		tags:         tagSet("old-run", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
	}})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d")
	if len(resp.Experiments) != 0 {
		t.Fatalf("expected 0 experiments in window, got %d", len(resp.Experiments))
	}
}

func TestRunWithoutRateAndNoFallbackContributesNil(t *testing.T) {
	// No rate tag on the Aim run AND no state file to back-fill from.
	// Frontend renders "—" via cents=nil; the version still surfaces.
	start := time.Now().UTC().AddDate(0, 0, -5)
	aim := fakeAim(t, []fakeRun{{
		experiment:   "no-rate",
		hash:         "abc",
		creationTime: unixSecs(start),
		endTime:      unixSecs(start.Add(time.Hour)),
		tags:         tagSet("no-rate", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_unknown", "success", nil),
	}})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment, got %d", len(resp.Experiments))
	}
	exp := resp.Experiments[0]
	if exp.TotalCents != 0 {
		t.Fatalf("no-rate run should have 0 cents, got %d", exp.TotalCents)
	}
	if len(exp.Versions) != 1 {
		t.Fatalf("expected 1 version row, got %d", len(exp.Versions))
	}
	if exp.Versions[0].Cents != nil {
		t.Fatalf("no-rate version should have nil Cents (renders '—'), got %v", *exp.Versions[0].Cents)
	}
	if resp.TotalCents != 0 {
		t.Fatalf("total should be 0, got %d", resp.TotalCents)
	}
}

func TestLocalBackendZeroRateZeroContribution(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	zero := 0
	aim := fakeAim(t, []fakeRun{{
		experiment:   "local-smoke",
		hash:         "abc",
		creationTime: unixSecs(start),
		endTime:      unixSecs(start.Add(30 * time.Minute)),
		tags:         tagSet("local-smoke", "v1", "11111111-1111-4111-8111-111111111111", "alice", "local", "success", &zero),
	}})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d")
	if resp.TotalCents != 0 {
		t.Fatalf("local backend should contribute 0 to total, got %d", resp.TotalCents)
	}
	if len(resp.Breakdown.Rows) != 1 {
		t.Fatalf("expected 1 breakdown row, got %d", len(resp.Breakdown.Rows))
	}
	if resp.Breakdown.Rows[0].Submits != 1 {
		t.Fatalf("expected submits=1, got %d", resp.Breakdown.Rows[0].Submits)
	}
}

// --- Happy path ------------------------------------------------------------

func TestTotalAndPercentages(t *testing.T) {
	start1 := time.Now().UTC().AddDate(0, 0, -3)
	start2 := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{
		{
			experiment:   "run-a",
			hash:         "h1",
			creationTime: unixSecs(start1),
			endTime:      unixSecs(start1.Add(2 * time.Hour)),
			tags:         tagSet("run-a", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
		},
		{
			experiment:   "run-b",
			hash:         "h2",
			creationTime: unixSecs(start2),
			endTime:      unixSecs(start2.Add(time.Hour)),
			tags:         tagSet("run-b", "v1", "22222222-2222-4222-8222-222222222222", "bob", "gpu_8x_a100", "success", intPtr(1592)),
		},
	})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d&group_by=submitter")
	wantTotal := 3184 + 1592
	if resp.TotalCents != wantTotal {
		t.Fatalf("total: want %d, got %d", wantTotal, resp.TotalCents)
	}
	if len(resp.Breakdown.Rows) != 2 {
		t.Fatalf("expected 2 breakdown rows, got %d", len(resp.Breakdown.Rows))
	}
	if resp.Breakdown.Rows[0].Key != "alice" {
		t.Fatalf("biggest spender should be first; got %q", resp.Breakdown.Rows[0].Key)
	}
	got := resp.Breakdown.Rows[0].Pct
	if got < 66.0 || got > 67.5 {
		t.Fatalf("alice pct: want ~66.7, got %.2f", got)
	}
}

func TestGroupByDimensionRespected(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{
		{
			experiment:   "a",
			hash:         "h1",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			tags:         tagSet("a", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
		},
		{
			experiment:   "b",
			hash:         "h2",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			tags:         tagSet("b", "v1", "22222222-2222-4222-8222-222222222222", "alice", "gpu_1x_a10", "success", intPtr(129)),
		},
	})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d&group_by=gpu_type")
	if resp.Breakdown.Dimension != "gpu_type" {
		t.Fatalf("expected dimension gpu_type, got %q", resp.Breakdown.Dimension)
	}
	if len(resp.Breakdown.Rows) != 2 {
		t.Fatalf("expected 2 gpu_type rows, got %d", len(resp.Breakdown.Rows))
	}
}

func TestStackByNoneFunnelsToAll(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{{
		experiment:   "a",
		hash:         "h1",
		creationTime: unixSecs(start),
		endTime:      unixSecs(start.Add(time.Hour)),
		tags:         tagSet("a", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
	}})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d&stack=none")
	for _, b := range resp.TimeSeries {
		if b.TotalCents > 0 {
			if _, ok := b.ByDimension["all"]; !ok {
				t.Fatalf("expected 'all' key in by_dimension, got %v", b.ByDimension)
			}
			return
		}
	}
	t.Fatalf("no day with spend found")
}

func TestStackByGPUTypeProducesDistinctKeys(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{
		{
			experiment:   "a",
			hash:         "h1",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			tags:         tagSet("a", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
		},
		{
			experiment:   "b",
			hash:         "h2",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			tags:         tagSet("b", "v1", "22222222-2222-4222-8222-222222222222", "alice", "gpu_1x_a10", "success", intPtr(129)),
		},
	})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d&stack=gpu_type")
	for _, b := range resp.TimeSeries {
		if b.TotalCents > 0 {
			if len(b.ByDimension) < 2 {
				t.Fatalf("expected >= 2 stack keys, got %v", b.ByDimension)
			}
			return
		}
	}
	t.Fatalf("no day with spend found")
}

func TestOutcomeNormalization(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	cases := []struct {
		name    string
		outcome string
	}{
		{"ok", "success"},
		{"timeout", "timeout"},
		{"stopped", "stopped"},
		{"failure", "failure"},
	}
	var runs []fakeRun
	for i, c := range cases {
		runs = append(runs, fakeRun{
			experiment:   c.name + fmt.Sprintf("%d", i),
			hash:         fmt.Sprintf("h%d", i),
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			tags:         tagSet(c.name+fmt.Sprintf("%d", i), "v1", fmt.Sprintf("%08d-0000-4000-8000-000000000000", i), "alice", "gpu_8x_a100", c.outcome, intPtr(1592)),
		})
	}
	resp := callCost(t, makeHandlerWithAim(t, fakeAim(t, runs), ""), "window=30d&group_by=outcome")
	keys := map[string]int{}
	for _, r := range resp.Breakdown.Rows {
		keys[r.Key] = r.Submits
	}
	if keys["success"] != 1 || keys["failed"] != 3 {
		t.Fatalf("outcome bucketing wrong: %v", keys)
	}
}

func TestPriorTotalSuppressedOnAllWindow(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{{
		experiment:   "a",
		hash:         "h1",
		creationTime: unixSecs(start),
		endTime:      unixSecs(start.Add(time.Hour)),
		tags:         tagSet("a", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
	}})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=all")
	if resp.PriorTotalCents != 0 {
		t.Fatalf("prior_total_cents must be 0 for 'all' window, got %d", resp.PriorTotalCents)
	}
	if resp.Window.Label != "all" {
		t.Fatalf("expected label all, got %q", resp.Window.Label)
	}
}

// --- v1.7.4-specific: per-version + legacy rate fallback -------------------

func TestMultipleVersionsOfSameExperiment(t *testing.T) {
	// Same astrolabe.experiment, different astrolabe.version → one
	// CostExperimentEntry with two version rows. This is the bug
	// v1.7.4 fixes: pre-fix the state file overwrote v1 with v2 and
	// the cost page silently underreported spend.
	start1 := time.Now().UTC().AddDate(0, 0, -5)
	start2 := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{
		{
			experiment:   "exp1",
			hash:         "h1",
			creationTime: unixSecs(start1),
			endTime:      unixSecs(start1.Add(2 * time.Hour)),
			tags:         tagSet("exp1", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "failure", intPtr(1592)),
		},
		{
			experiment:   "exp1",
			hash:         "h2",
			creationTime: unixSecs(start2),
			endTime:      unixSecs(start2.Add(time.Hour)),
			tags:         tagSet("exp1", "v2", "22222222-2222-4222-8222-222222222222", "alice", "gpu_8x_a100", "success", intPtr(1592)),
		},
	})
	resp := callCost(t, makeHandlerWithAim(t, aim, ""), "window=30d")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment, got %d", len(resp.Experiments))
	}
	exp := resp.Experiments[0]
	if len(exp.Versions) != 2 {
		t.Fatalf("expected 2 versions, got %d", len(exp.Versions))
	}
	// Both versions accounted for: 2h@$15.92 + 1h@$15.92 = $47.76 = 4776
	if exp.TotalCents != 4776 {
		t.Fatalf("total cents: want 4776, got %d", exp.TotalCents)
	}
	// Versions sorted by label (v1, v2).
	if exp.Versions[0].Version != "v1" || exp.Versions[1].Version != "v2" {
		t.Fatalf("versions not sorted: %q, %q", exp.Versions[0].Version, exp.Versions[1].Version)
	}
	// Outcome preserved per version.
	if exp.Versions[0].Outcome != "failure" {
		t.Fatalf("v1 outcome: want failure, got %q", exp.Versions[0].Outcome)
	}
	if exp.Versions[1].Outcome != "success" {
		t.Fatalf("v2 outcome: want success, got %q", exp.Versions[1].Outcome)
	}
}

func TestLegacyRunPicksUpRateFromStateFile(t *testing.T) {
	// Aim run lacks astrolabe.gpu_rate_cents_per_hour (pre-v1.7.4).
	// State file has the rate persisted from the backfill walker.
	// Handler should join by gpu_type to recover the rate.
	dir := t.TempDir()
	writeState(t, dir, "legacy", map[string]any{
		"state":                   "COMPLETED",
		"gpu_type":                "gpu_8x_a100",
		"backend":                 "lambda",
		"submitted_by":            "alice",
		"started_at":              time.Now().UTC().AddDate(0, 0, -2).Format(time.RFC3339),
		"finished_at":             time.Now().UTC().AddDate(0, 0, -2).Add(time.Hour).Format(time.RFC3339),
		"gpu_rate_cents_per_hour": 1592,
	})
	start := time.Now().UTC().AddDate(0, 0, -2)
	aim := fakeAim(t, []fakeRun{{
		experiment:   "legacy",
		hash:         "h1",
		creationTime: unixSecs(start),
		endTime:      unixSecs(start.Add(time.Hour)),
		// No rate tag — but gpu_type is present.
		tags: tagSet("legacy", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", nil),
	}})
	resp := callCost(t, makeHandlerWithAim(t, aim, dir), "window=30d")
	if resp.TotalCents != 1592 {
		t.Fatalf("legacy rate fallback failed: want 1592, got %d", resp.TotalCents)
	}
}

// --- v1.7.5: filter non-astrolabe runs -------------------------------------

func TestNonAstrolabeRunsExcluded(t *testing.T) {
	// Aim sees three runs:
	//   1. An astrolabe submit  → real UUID submit_id, must be counted.
	//   2. A TensorBoard import → submit_id="tb-import", must be skipped.
	//   3. A manual Aim run     → no astrolabe.* tags at all, must be
	//      skipped (the rate fallback used to pull these in via the
	//      state-file gpu_type map, inflating spend numbers).
	start := time.Now().UTC().AddDate(0, 0, -2)
	runs := []fakeRun{
		{
			experiment:   "real",
			hash:         "h1",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			tags:         tagSet("real", "v1", "11111111-1111-4111-8111-111111111111", "alice", "gpu_8x_a100", "success", intPtr(1592)),
		},
		{
			experiment:   "tb-imported",
			hash:         "h2",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			// Non-UUID submit_id → filter.
			tags: tagSet("tb-imported", "v1", "tb-import", "alice", "gpu_8x_a100", "", intPtr(1592)),
		},
		{
			experiment:   "manual",
			hash:         "h3",
			creationTime: unixSecs(start),
			endTime:      unixSecs(start.Add(time.Hour)),
			// No astrolabe tags at all (empty map).
			tags: map[string]any{},
		},
	}
	resp := callCost(t, makeHandlerWithAim(t, fakeAim(t, runs), ""), "window=30d")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment (only the real one), got %d: %+v",
			len(resp.Experiments), resp.Experiments)
	}
	if resp.Experiments[0].Name != "real" {
		t.Fatalf("expected real experiment, got %q", resp.Experiments[0].Name)
	}
	if resp.TotalCents != 1592 {
		t.Fatalf("total should be just the real run's 1592, got %d", resp.TotalCents)
	}
}

// Suppress unused-import warning for net/url if the file ever drops
// its only consumer (the cost handler calls url.Values internally).
var _ = url.Values{}
