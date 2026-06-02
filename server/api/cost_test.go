package api

// Tests for the cost handler. Contract under test (per
// astrolabe-insights-hub/src/lib/types.ts):
//
//   - No submits → response has empty arrays, no panic
//   - nil StateReader → empty response (handler must not 5xx on fresh
//     NUC where the state DB hasn't been created yet)
//   - Submit started outside the window → excluded
//   - Submit with NULL gpu_rate_cents_per_hour → version cents=nil,
//     total=0, but the submit still counts in submits/hours
//   - Local backend (rate=0) → submits=1, cents contribution=0
//   - Multi-submitter window → totals/percentages add up; biggest first
//   - group_by dimension is honored
//   - stack dimension is honored in the time series; "none" funnels
//     into a single "all" key
//   - Outcome dispatches to "success" / "failed" buckets
//   - prior_total_cents is 0 for window=all
//   - Multiple versions of the same experiment surface as multiple
//     CostVersionEntry rows under one CostExperimentEntry
//
// Each test stands up a fresh SQLite DB with ``testSchemaSQL``,
// inserts submits via ``insertSubmit``, then opens a real
// ``StateReader`` against the DB file. The cost handler is constructed
// with a nil AimClient — it must never reach for Aim now that cost
// data lives entirely on the submits row.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// --- Test helpers ----------------------------------------------------------

// makeStateReaderWith builds a fresh test DB at a temp path, runs the
// caller's seed function against an open writer connection, then
// returns a read-only StateReader pointed at the same file. The DB
// file lives in t.TempDir() so the test cleanup wipes it.
func makeStateReaderWith(t *testing.T, fn func(*sql.DB)) *StateReader {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(testSchemaSQL); err != nil {
		t.Fatal(err)
	}
	fn(db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	r, err := NewStateReader(path)
	if err != nil {
		t.Fatalf("NewStateReader(%s): %v", path, err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r
}

// makeCostHandler wires a handler with the given StateReader. Aim
// client is intentionally nil — the cost handler is SQLite-only as of
// v1.8 and must not touch Aim. (Named ``makeCostHandler`` rather than
// ``makeHandlerWithState`` to avoid colliding with the same-named
// helper in experiments_handler_test.go, which takes a DB path.)
func makeCostHandler(t *testing.T, state *StateReader) *Handler {
	t.Helper()
	return NewHandler(nil, state, nil)
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

// iso renders a time as the engine writes it.
func iso(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

// --- Edge cases ------------------------------------------------------------

// TestHandleCostEmptyDB exercises the no-rows path: the response must
// be shaped (non-nil slices, label populated) so the frontend renders
// an empty state without a JS-side null deref.
func TestHandleCostEmptyDB(t *testing.T) {
	state := makeStateReaderWith(t, func(db *sql.DB) {})
	h := makeCostHandler(t, state)
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

// TestHandleCostNilState exercises the brand-new-NUC path where the
// state DB file doesn't exist yet; cmd/main.go passes a nil reader in
// that case. The handler must still produce a well-shaped empty
// response, not 5xx.
func TestHandleCostNilState(t *testing.T) {
	h := makeCostHandler(t, nil)
	resp := callCost(t, h, "window=30d")
	if resp.TotalCents != 0 {
		t.Fatalf("expected 0 total, got %d", resp.TotalCents)
	}
	if resp.Experiments == nil || resp.TimeSeries == nil || resp.Breakdown.Rows == nil {
		t.Fatalf("nil slices in response — frontend will choke")
	}
}

// TestRunOutsideWindowExcluded checks the time filter. A submit
// started 60 days ago must not show up in a 30-day window.
func TestRunOutsideWindowExcluded(t *testing.T) {
	old := time.Now().UTC().AddDate(0, 0, -60)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "old-run",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(old),
			"finished_at":             iso(old.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d")
	if len(resp.Experiments) != 0 {
		t.Fatalf("expected 0 experiments in window, got %d", len(resp.Experiments))
	}
}

// TestRunWithoutRateAndNoFallbackContributesNil covers a submit whose
// ``gpu_rate_cents_per_hour`` is NULL (e.g., Lambda outage at acquire
// time, or a backfilled legacy submit). The version must still surface
// — its Cents pointer must be nil so the frontend renders "—".
func TestRunWithoutRateAndNoFallbackContributesNil(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -5)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "no-rate",
			"version":         "v1",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"gpu_type":        "gpu_unknown",
			"started_at":      iso(start),
			"finished_at":     iso(start.Add(time.Hour)),
			"outcome":         "success",
			"current_state":   "COMPLETED",
			// gpu_rate_cents_per_hour intentionally absent → NULL
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment, got %d", len(resp.Experiments))
	}
	exp := resp.Experiments[0]
	if exp.TotalCents != 0 {
		t.Fatalf("no-rate submit should have 0 cents, got %d", exp.TotalCents)
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

// TestLocalBackendZeroRateZeroContribution covers the "free" path:
// LocalExecutor writes rate=0 (not NULL) so the run counts but
// contributes nothing to spend totals.
func TestLocalBackendZeroRateZeroContribution(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "local-smoke",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "local",
			"gpu_type":                "local",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(30 * time.Minute)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 0,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d")
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

// TestTotalAndPercentages: two submits, two submitters, sanity-check
// the sum and the dominant-spender ordering.
func TestTotalAndPercentages(t *testing.T) {
	start1 := time.Now().UTC().AddDate(0, 0, -3)
	start2 := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "run-a",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start1),
			"finished_at":             iso(start1.Add(2 * time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "run-b",
			"version":                 "v1",
			"submitted_by":            "bob",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start2),
			"finished_at":             iso(start2.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d&group_by=submitter")
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

// TestGroupByDimensionRespected confirms the URL param actually
// switches the breakdown axis (not just the column name).
func TestGroupByDimensionRespected(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "a",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "b",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_1x_a10",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 129,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d&group_by=gpu_type")
	if resp.Breakdown.Dimension != "gpu_type" {
		t.Fatalf("expected dimension gpu_type, got %q", resp.Breakdown.Dimension)
	}
	if len(resp.Breakdown.Rows) != 2 {
		t.Fatalf("expected 2 gpu_type rows, got %d", len(resp.Breakdown.Rows))
	}
}

// TestStackByNoneFunnelsToAll: with stack=none, every day-bucket with
// spend must have its contribution keyed under "all" so the frontend
// can render an unstacked total bar.
func TestStackByNoneFunnelsToAll(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "a",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d&stack=none")
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

// TestStackByGPUTypeProducesDistinctKeys: stack by a real dimension
// must produce one key per distinct gpu_type that contributed.
func TestStackByGPUTypeProducesDistinctKeys(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "a",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "b",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_1x_a10",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 129,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d&stack=gpu_type")
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

// TestOutcomeNormalization: any non-success outcome buckets under
// "failed"; only literal "success" survives as "success".
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
	state := makeStateReaderWith(t, func(db *sql.DB) {
		for i, c := range cases {
			insertSubmit(t, db, map[string]any{
				"experiment_name":         fmt.Sprintf("%s%d", c.name, i),
				"version":                 "v1",
				"submitted_by":            "alice",
				"backend":                 "lambda",
				"gpu_type":                "gpu_8x_a100",
				"started_at":              iso(start),
				"finished_at":             iso(start.Add(time.Hour)),
				"outcome":                 c.outcome,
				"current_state":           "COMPLETED",
				"gpu_rate_cents_per_hour": 1592,
			})
		}
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d&group_by=outcome")
	keys := map[string]int{}
	for _, r := range resp.Breakdown.Rows {
		keys[r.Key] = r.Submits
	}
	if keys["success"] != 1 || keys["failed"] != 3 {
		t.Fatalf("outcome bucketing wrong: %v", keys)
	}
}

// TestPriorTotalSuppressedOnAllWindow: the frontend hides the
// delta-vs-prior chip when the user is viewing all-time; the API must
// signal that by returning 0 for prior_total_cents.
func TestPriorTotalSuppressedOnAllWindow(t *testing.T) {
	start := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "a",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start),
			"finished_at":             iso(start.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=all")
	if resp.PriorTotalCents != 0 {
		t.Fatalf("prior_total_cents must be 0 for 'all' window, got %d", resp.PriorTotalCents)
	}
	if resp.Window.Label != "all" {
		t.Fatalf("expected label all, got %q", resp.Window.Label)
	}
}

// --- Multi-version -------------------------------------------------

// TestMultipleVersionsOfSameExperiment: same experiment_name, two
// versions → one CostExperimentEntry with two CostVersionEntry rows.
// Confirms the bug v1.7.4 fixed (state files overwrote v1 with v2)
// stays fixed under the SQLite shape — UNIQUE(experiment_name, version)
// guarantees both rows survive.
func TestMultipleVersionsOfSameExperiment(t *testing.T) {
	start1 := time.Now().UTC().AddDate(0, 0, -5)
	start2 := time.Now().UTC().AddDate(0, 0, -2)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "exp1",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start1),
			"finished_at":             iso(start1.Add(2 * time.Hour)),
			"outcome":                 "failure",
			"current_state":           "FAILED",
			"gpu_rate_cents_per_hour": 1592,
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "exp1",
			"version":                 "v2",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              iso(start2),
			"finished_at":             iso(start2.Add(time.Hour)),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
	})
	resp := callCost(t, makeCostHandler(t, state), "window=30d")
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

// --- Billing window (Lambda-calibrated) ----------------------------------

func TestBillingWindowUsesSetupToTerminalTransition(t *testing.T) {
	// Reproduces the 06b-rtd-calibration v5 regression: engine-process
	// elapsed (started_at → finished_at) overcounts because it includes
	// scheduler queue + Lambda boot + cleanup. Real Lambda charge is
	// from SETUP transition to first terminal-state transition.
	//
	// Setup the SETUP → FAILED window as 4 minutes; the engine-process
	// window as 7 minutes. At 838c/hr the right answer is $0.56, the
	// wrong answer would be $0.98.
	started := time.Date(2026, 6, 2, 18, 56, 52, 0, time.UTC)
	setupAt := time.Date(2026, 6, 2, 18, 59, 15, 0, time.UTC)
	failedAt := time.Date(2026, 6, 2, 19, 3, 15, 0, time.UTC)
	finishedAt := time.Date(2026, 6, 2, 19, 3, 50, 0, time.UTC)

	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "billing-window-test",
			"version":                 "v1",
			"submitted_by":            "nathan",
			"backend":                 "lambda",
			"gpu_type":                "gpu_2x_h100_sxm5",
			"started_at":              started.Format(time.RFC3339Nano),
			"finished_at":             finishedAt.Format(time.RFC3339Nano),
			"outcome":                 "failure",
			"current_state":           "FAILED",
			"gpu_rate_cents_per_hour": 838,
		})
		// Drop FSM transitions matching the live shape on lake1.
		sid := "test-billing-window-test-v1"
		for _, tr := range []struct {
			state string
			at    time.Time
		}{
			{"PENDING", started},
			{"ACQUIRING", started.Add(2 * time.Second)},
			{"SETUP", setupAt},
			{"RUNNING", setupAt.Add(7 * time.Second)},
			{"SUMMARIZING", failedAt.Add(-3 * time.Second)},
			{"FAILED", failedAt},
		} {
			_, err := db.Exec(
				`INSERT INTO state_transitions (submit_id, state, at) VALUES (?, ?, ?)`,
				sid, tr.state, tr.at.Format(time.RFC3339Nano),
			)
			if err != nil {
				t.Fatal(err)
			}
		}
	})

	resp := callCost(t, makeCostHandler(t, state), "window=all")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment, got %d", len(resp.Experiments))
	}
	v := resp.Experiments[0].Versions[0]
	if v.Cents == nil {
		t.Fatal("cents was nil")
	}
	// 838 * (240/3600) = 55.86 → truncated to 55 by int conversion.
	if *v.Cents != 55 && *v.Cents != 56 {
		t.Fatalf("billing window wrong: got %d cents, want 55-56 (838c/hr × 4min). "+
			"If you see ~97-98 you're back on started_at→finished_at.", *v.Cents)
	}
}

func TestBillingWindowFallbackForLegacyRows(t *testing.T) {
	// Pre-SQLite imports have no state_transitions. billingWindow must
	// fall back to (started_at, finished_at) so legacy data still renders
	// — less accurate, but it's all we have.
	start := time.Now().UTC().AddDate(0, 0, -3)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "legacy-no-transitions",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              start.Format(time.RFC3339Nano),
			"finished_at":             start.Add(time.Hour).Format(time.RFC3339Nano),
			"outcome":                 "success",
			"current_state":           "COMPLETED",
			"gpu_rate_cents_per_hour": 1592,
		})
		// Deliberately NOT inserting state_transitions rows.
	})

	resp := callCost(t, makeCostHandler(t, state), "window=30d")
	if len(resp.Experiments) != 1 {
		t.Fatalf("expected 1 experiment, got %d", len(resp.Experiments))
	}
	v := resp.Experiments[0].Versions[0]
	if v.Cents == nil || *v.Cents != 1592 {
		t.Fatalf("legacy fallback wrong: want 1592c (1h × 15.92/hr), got %v", v.Cents)
	}
}

func TestBillingWindowDropsSubmitsThatNeverReachedSetup(t *testing.T) {
	// A submit that failed during ACQUIRING (Lambda launch failed)
	// never billed by Lambda. Modern row (has state_transitions) but no
	// SETUP transition → drop from cost view entirely. Without this,
	// failed launches would inflate submit/hour counts in the
	// breakdown.
	start := time.Now().UTC().AddDate(0, 0, -1)
	state := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name":         "launch-failed",
			"version":                 "v1",
			"submitted_by":            "alice",
			"backend":                 "lambda",
			"gpu_type":                "gpu_8x_a100",
			"started_at":              start.Format(time.RFC3339Nano),
			"finished_at":             start.Add(30 * time.Second).Format(time.RFC3339Nano),
			"outcome":                 "failure",
			"current_state":           "FAILED",
			"gpu_rate_cents_per_hour": 1592,
		})
		sid := "test-launch-failed-v1"
		for _, tr := range []struct {
			state string
			at    time.Time
		}{
			{"PENDING", start},
			{"ACQUIRING", start.Add(1 * time.Second)},
			{"FAILED", start.Add(30 * time.Second)},
		} {
			_, err := db.Exec(
				`INSERT INTO state_transitions (submit_id, state, at) VALUES (?, ?, ?)`,
				sid, tr.state, tr.at.Format(time.RFC3339Nano),
			)
			if err != nil {
				t.Fatal(err)
			}
		}
	})

	resp := callCost(t, makeCostHandler(t, state), "window=30d")
	if len(resp.Experiments) != 0 {
		t.Fatalf("expected 0 experiments (failed-before-SETUP dropped), got %d", len(resp.Experiments))
	}
}
