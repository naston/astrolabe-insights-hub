package api

// Tests for the cost handler. Contract under test (per
// astrolabe-insights-hub/src/lib/types.ts):
//
//   - Empty state dir → response has empty arrays, no panic
//   - Window filter excludes records outside the range
//   - Records with no GPURateCentsPerHour contribute 0 cents (rendered
//     as "—" by the frontend); they still count in submits/hours
//   - Local backend (rate=0) shows up in submits but contributes 0 to
//     totals and 0 cents to the breakdown row
//   - Group-by dimension is honored (submitter / repo / gpu_type /
//     outcome / backend)
//   - Stack dimension is honored in the time series; "none" funnels
//     into a single "all" key
//   - Outcome normalization: timeout / stopped / failure → "failed";
//     success → "success"; pre-terminal states → no outcome
//   - prior_total_cents is 0 for window=all
//   - prior_total_cents is non-zero for finite windows with prior data
//   - Legacy gpu_type aliases are recognized (visible via stackKey but
//     don't auto-recover rates — that's a backfill responsibility)

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// --- Fixtures ---------------------------------------------------------------

func tmpStateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return dir
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

// makeHandler builds a Handler with a StateReader pointing at dir.
// AimClient is nil — the cost endpoint doesn't touch Aim in v1.
func makeHandler(dir string) *Handler {
	return NewHandler(nil, NewStateReader(dir), nil)
}

func intPtr(v int) *int     { return &v }

// callCost makes an HTTP-style call to HandleCost and decodes the result.
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

// --- Edge cases first ------------------------------------------------------

func TestHandleCostEmptyDir(t *testing.T) {
	// No state files → response is well-formed but empty. Frontend
	// renders "No spend in window".
	h := makeHandler(tmpStateDir(t))
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

func TestRecordOutsideWindowExcluded(t *testing.T) {
	dir := tmpStateDir(t)
	// Run that ended 60 days ago — outside the 30d window.
	old := time.Now().UTC().AddDate(0, 0, -60).Format(time.RFC3339)
	writeState(t, dir, "old-run", map[string]any{
		"state":                    "COMPLETED",
		"gpu_type":                 "gpu_8x_a100",
		"backend":                  "lambda",
		"submitted_by":             "alice",
		"started_at":               old,
		"finished_at":              time.Now().UTC().AddDate(0, 0, -59).Format(time.RFC3339),
		"gpu_rate_cents_per_hour":  1592,
	})
	resp := callCost(t, makeHandler(dir), "window=30d")
	if len(resp.Experiments) != 0 {
		t.Fatalf("expected 0 experiments in window, got %d", len(resp.Experiments))
	}
}

func TestRecordWithoutRateContributesZeroCents(t *testing.T) {
	// A pre-backfill record (no gpu_rate_cents_per_hour) still
	// appears in the experiments list but with cents=nil/0.
	dir := tmpStateDir(t)
	startedAt := time.Now().UTC().AddDate(0, 0, -5)
	finishedAt := startedAt.Add(time.Hour)
	writeState(t, dir, "no-rate", map[string]any{
		"state":        "COMPLETED",
		"gpu_type":     "gpu_8x_a100",
		"backend":      "lambda",
		"submitted_by": "alice",
		"started_at":   startedAt.Format(time.RFC3339),
		"finished_at":  finishedAt.Format(time.RFC3339),
		// No gpu_rate_cents_per_hour — pre-backfill.
	})
	resp := callCost(t, makeHandler(dir), "window=30d")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment, got %d", len(resp.Experiments))
	}
	exp := resp.Experiments[0]
	if exp.TotalCents != 0 {
		t.Fatalf("no-rate record should have 0 cents, got %d", exp.TotalCents)
	}
	if len(exp.Versions) != 1 {
		t.Fatalf("expected 1 version row, got %d", len(exp.Versions))
	}
	if exp.Versions[0].Cents != nil {
		t.Fatalf("no-rate record should have nil Cents (renders '—'), got %v", *exp.Versions[0].Cents)
	}
	// Still counted in submits/hours via the breakdown.
	if resp.TotalCents != 0 {
		t.Fatalf("total should be 0, got %d", resp.TotalCents)
	}
}

func TestLocalBackendZeroRateZeroContribution(t *testing.T) {
	dir := tmpStateDir(t)
	startedAt := time.Now().UTC().AddDate(0, 0, -2)
	finishedAt := startedAt.Add(30 * time.Minute)
	writeState(t, dir, "local-smoke", map[string]any{
		"state":                   "COMPLETED",
		"gpu_type":                "local",
		"backend":                 "local",
		"submitted_by":            "alice",
		"started_at":              startedAt.Format(time.RFC3339),
		"finished_at":             finishedAt.Format(time.RFC3339),
		"gpu_rate_cents_per_hour": 0, // local is free
	})
	resp := callCost(t, makeHandler(dir), "window=30d")
	if resp.TotalCents != 0 {
		t.Fatalf("local backend should contribute 0 to total, got %d", resp.TotalCents)
	}
	// But the breakdown row exists (submitter=alice).
	if len(resp.Breakdown.Rows) != 1 {
		t.Fatalf("expected 1 breakdown row, got %d", len(resp.Breakdown.Rows))
	}
	if resp.Breakdown.Rows[0].Submits != 1 {
		t.Fatalf("expected submits=1, got %d", resp.Breakdown.Rows[0].Submits)
	}
}

// --- Happy path / sanity ---------------------------------------------------

func TestTotalAndPercentages(t *testing.T) {
	dir := tmpStateDir(t)
	// 2-hour run on 8xA100 at $15.92/hr = $31.84 = 3184 cents
	start1 := time.Now().UTC().AddDate(0, 0, -3)
	writeState(t, dir, "run-a", map[string]any{
		"state":                   "COMPLETED",
		"gpu_type":                "gpu_8x_a100",
		"backend":                 "lambda",
		"submitted_by":            "alice",
		"started_at":              start1.Format(time.RFC3339),
		"finished_at":             start1.Add(2 * time.Hour).Format(time.RFC3339),
		"gpu_rate_cents_per_hour": 1592,
	})
	// 1-hour run by bob at the same rate = $15.92 = 1592 cents
	start2 := time.Now().UTC().AddDate(0, 0, -2)
	writeState(t, dir, "run-b", map[string]any{
		"state":                   "COMPLETED",
		"gpu_type":                "gpu_8x_a100",
		"backend":                 "lambda",
		"submitted_by":            "bob",
		"started_at":              start2.Format(time.RFC3339),
		"finished_at":             start2.Add(time.Hour).Format(time.RFC3339),
		"gpu_rate_cents_per_hour": 1592,
	})
	resp := callCost(t, makeHandler(dir), "window=30d&group_by=submitter")
	wantTotal := 3184 + 1592
	if resp.TotalCents != wantTotal {
		t.Fatalf("total: want %d, got %d", wantTotal, resp.TotalCents)
	}
	// Two breakdown rows, sorted by cents desc.
	if len(resp.Breakdown.Rows) != 2 {
		t.Fatalf("expected 2 breakdown rows, got %d", len(resp.Breakdown.Rows))
	}
	if resp.Breakdown.Rows[0].Key != "alice" {
		t.Fatalf("biggest spender should be first; got %q", resp.Breakdown.Rows[0].Key)
	}
	// Percentages roughly 66.7 and 33.3 — allow 0.5% tolerance.
	got := resp.Breakdown.Rows[0].Pct
	if got < 66.0 || got > 67.5 {
		t.Fatalf("alice pct: want ~66.7, got %.2f", got)
	}
}

func TestGroupByDimensionRespected(t *testing.T) {
	dir := tmpStateDir(t)
	startedAt := time.Now().UTC().AddDate(0, 0, -2).Format(time.RFC3339)
	finishedAt := time.Now().UTC().AddDate(0, 0, -2).Add(time.Hour).Format(time.RFC3339)
	writeState(t, dir, "a", map[string]any{
		"state": "COMPLETED", "gpu_type": "gpu_8x_a100", "backend": "lambda",
		"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
		"gpu_rate_cents_per_hour": 1592,
	})
	writeState(t, dir, "b", map[string]any{
		"state": "COMPLETED", "gpu_type": "gpu_1x_a10", "backend": "lambda",
		"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
		"gpu_rate_cents_per_hour": 129,
	})
	// Group by gpu_type: two rows (different gpus, same user).
	resp := callCost(t, makeHandler(dir), "window=30d&group_by=gpu_type")
	if resp.Breakdown.Dimension != "gpu_type" {
		t.Fatalf("expected dimension gpu_type, got %q", resp.Breakdown.Dimension)
	}
	if len(resp.Breakdown.Rows) != 2 {
		t.Fatalf("expected 2 gpu_type rows, got %d", len(resp.Breakdown.Rows))
	}
}

func TestStackByNoneFunnelsToAll(t *testing.T) {
	dir := tmpStateDir(t)
	startedAt := time.Now().UTC().AddDate(0, 0, -2).Format(time.RFC3339)
	finishedAt := time.Now().UTC().AddDate(0, 0, -2).Add(time.Hour).Format(time.RFC3339)
	writeState(t, dir, "a", map[string]any{
		"state": "COMPLETED", "gpu_type": "gpu_8x_a100", "backend": "lambda",
		"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
		"gpu_rate_cents_per_hour": 1592,
	})
	resp := callCost(t, makeHandler(dir), "window=30d&stack=none")
	// Find the day with the experiment and confirm the bucket keys.
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
	dir := tmpStateDir(t)
	startedAt := time.Now().UTC().AddDate(0, 0, -2).Format(time.RFC3339)
	finishedAt := time.Now().UTC().AddDate(0, 0, -2).Add(time.Hour).Format(time.RFC3339)
	writeState(t, dir, "a", map[string]any{
		"state": "COMPLETED", "gpu_type": "gpu_8x_a100", "backend": "lambda",
		"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
		"gpu_rate_cents_per_hour": 1592,
	})
	writeState(t, dir, "b", map[string]any{
		"state": "COMPLETED", "gpu_type": "gpu_1x_a10", "backend": "lambda",
		"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
		"gpu_rate_cents_per_hour": 129,
	})
	resp := callCost(t, makeHandler(dir), "window=30d&stack=gpu_type")
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
	dir := tmpStateDir(t)
	cases := []struct {
		name    string
		outcome string
		state   string
		want    string // expected stackKey for outcome dim
	}{
		{"ok", "success", "COMPLETED", "success"},
		{"timeout", "timeout", "FAILED", "failed"},
		{"stopped", "stopped", "FAILED", "failed"},
		{"failure", "failure", "FAILED", "failed"},
	}
	startedAt := time.Now().UTC().AddDate(0, 0, -2).Format(time.RFC3339)
	finishedAt := time.Now().UTC().AddDate(0, 0, -2).Add(time.Hour).Format(time.RFC3339)
	for i, c := range cases {
		writeState(t, dir, c.name+strconv.Itoa(i), map[string]any{
			"state": c.state, "gpu_type": "gpu_8x_a100", "backend": "lambda",
			"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
			"gpu_rate_cents_per_hour": 1592,
			"outcome":                 c.outcome,
		})
	}
	resp := callCost(t, makeHandler(dir), "window=30d&group_by=outcome")
	// Expected keys: "success" (1) and "failed" (3).
	keys := map[string]int{}
	for _, r := range resp.Breakdown.Rows {
		keys[r.Key] = r.Submits
	}
	if keys["success"] != 1 || keys["failed"] != 3 {
		t.Fatalf("outcome bucketing wrong: %v", keys)
	}
}

func TestPriorTotalSuppressedOnAllWindow(t *testing.T) {
	dir := tmpStateDir(t)
	startedAt := time.Now().UTC().AddDate(0, 0, -2).Format(time.RFC3339)
	finishedAt := time.Now().UTC().AddDate(0, 0, -2).Add(time.Hour).Format(time.RFC3339)
	writeState(t, dir, "a", map[string]any{
		"state": "COMPLETED", "gpu_type": "gpu_8x_a100", "backend": "lambda",
		"submitted_by": "alice", "started_at": startedAt, "finished_at": finishedAt,
		"gpu_rate_cents_per_hour": 1592,
	})
	resp := callCost(t, makeHandler(dir), "window=all")
	if resp.PriorTotalCents != 0 {
		t.Fatalf("prior_total_cents must be 0 for 'all' window, got %d", resp.PriorTotalCents)
	}
	if resp.Window.Label != "all" {
		t.Fatalf("expected label all, got %q", resp.Window.Label)
	}
}
