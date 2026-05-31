package api

// Tests for HandleExperiments — the home-page experiments list.
//
// Contract being verified (regression test for the SQLite cutover bug):
//
//   * Returns ONE row per experiment_name, even when there are
//     multiple submits (versions) for that experiment in SQLite.
//   * The representative row is the NEWEST submit by started_at.
//   * version_count reflects the count of distinct version values
//     in SQLite for that experiment — including backfilled
//     metadata-only submits that have no composer training run in
//     Aim.
//
// Background: before the SQLite cutover, state files were
// one-per-experiment-name (last-write-wins), so iterating them
// produced one row per experiment "for free." After the cutover
// each version is its own submit row; the original handler kept
// the loop body unchanged and started emitting duplicate rows for
// every multi-version experiment. The bug was caught by a user
// reporting "5 copies of 02-muon-optimizer on the home page" after
// a Lambda invoice backfill landed four new versions.

import (
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func callExperiments(t *testing.T, h *Handler) []ExperimentSummary {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/experiments", nil)
	rr := httptest.NewRecorder()
	h.HandleExperiments(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp []ExperimentSummary
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

func makeHandlerWithState(t *testing.T, dbPath string) *Handler {
	t.Helper()
	sr, err := NewStateReader(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	// fakeAim with nil runs — the home page works fine with no Aim
	// runs at all; the missing-Aim path is exercised elsewhere.
	aim := fakeAim(t, nil)
	return NewHandler(aim, sr, nil)
}

// --- The regression test ---

func TestHandleExperiments_MultiVersionEmitsOneRow(t *testing.T) {
	// Five submits with the same experiment_name (modeling the
	// 02-muon-optimizer backfill scenario): v3 is the real run; v1,
	// v2, v4, v5 are Lambda invoice backfills with synthesized
	// submit_ids. All correctly tagged in SQLite; the home page must
	// still show ONE row, not five.
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "02-muon-optimizer",
			"version":         "v1",
			"submit_id":       "backfill-02-muon-optimizer-v1",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-05-04T08:43:00+00:00",
			"finished_at":     "2026-05-04T09:00:00+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "02-muon-optimizer",
			"version":         "v2",
			"submit_id":       "backfill-02-muon-optimizer-v2",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-05-04T09:38:00+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "02-muon-optimizer",
			"version":         "v3",
			"submit_id":       "real-v3-uuid",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-05-06T00:25:34+00:00",
			"finished_at":     "2026-05-06T01:30:00+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "02-muon-optimizer",
			"version":         "v4",
			"submit_id":       "backfill-02-muon-optimizer-v4",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-05-05T03:49:00+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "02-muon-optimizer",
			"version":         "v5",
			"submit_id":       "backfill-02-muon-optimizer-v5",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-05-05T19:40:00+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
		})
	})

	h := makeHandlerWithState(t, path)
	got := callExperiments(t, h)

	if len(got) != 1 {
		t.Fatalf("expected 1 row (grouped by name), got %d:\n%+v", len(got), got)
	}
	if got[0].Name != "02-muon-optimizer" {
		t.Errorf("Name: want 02-muon-optimizer, got %q", got[0].Name)
	}
	if got[0].VersionCount != 5 {
		t.Errorf("VersionCount: want 5 (one per submit in SQLite), got %d",
			got[0].VersionCount)
	}
	// v3 has the newest started_at among the five — must be the
	// representative row.
	if got[0].StartedAt != "2026-05-06T00:25:34+00:00" {
		t.Errorf("StartedAt: want v3's timestamp, got %q", got[0].StartedAt)
	}
}

func TestHandleExperiments_MultipleExperiments(t *testing.T) {
	// Sanity check: two distinct experiments produce two rows,
	// sorted newest-first.
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "old-exp",
			"version":         "v1",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-05-01T10:00:00+00:00",
			"current_state":   "COMPLETED",
			"outcome":         "success",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "new-exp",
			"version":         "v1",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-05-30T10:00:00+00:00",
			"current_state":   "COMPLETED",
			"outcome":         "success",
		})
	})

	h := makeHandlerWithState(t, path)
	got := callExperiments(t, h)

	if len(got) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(got))
	}
	if got[0].Name != "new-exp" {
		t.Errorf("Newest first: want new-exp, got %q", got[0].Name)
	}
	if got[1].Name != "old-exp" {
		t.Errorf("Older second: want old-exp, got %q", got[1].Name)
	}
}

func TestHandleExperiments_EmptyVersionBucketsAsV1(t *testing.T) {
	// Legacy submits (pre-v1.2.0) lack the version field. They
	// should bucket as a single "v1" so version_count is 1, not 0,
	// matching the dashboard's legacy fallback rendering.
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "legacy-exp",
			"version":         "", // explicit empty version
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-04-01T10:00:00+00:00",
			"current_state":   "COMPLETED",
		})
	})

	h := makeHandlerWithState(t, path)
	got := callExperiments(t, h)

	if len(got) != 1 {
		t.Fatalf("expected 1 row, got %d", len(got))
	}
	if got[0].VersionCount != 1 {
		t.Errorf("VersionCount: want 1 (empty version → 'v1' bucket), got %d",
			got[0].VersionCount)
	}
}

func TestHandleExperiments_RepresentativeIsNewestSubmit(t *testing.T) {
	// When versions arrive out-of-order chronologically (as in the
	// invoice backfill where v4 was created at insert-time but its
	// started_at is older than v3's), the row's State and Outcome
	// come from the submit with the newest started_at, NOT the
	// highest version label.
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-x",
			"version":         "v1",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			"started_at":      "2026-05-10T10:00:00+00:00",
			"current_state":   "FAILED",
			"outcome":         "failure",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-x",
			"version":         "v2",
			"submitted_by":    "nathan",
			"backend":         "lambda",
			// older started_at than v1 — represents a backfill of an
			// earlier-in-time submit added later.
			"started_at":    "2026-05-05T10:00:00+00:00",
			"current_state": "COMPLETED",
			"outcome":       "success",
		})
	})

	h := makeHandlerWithState(t, path)
	got := callExperiments(t, h)

	if len(got) != 1 {
		t.Fatalf("expected 1 row, got %d", len(got))
	}
	// v1's started_at is newer, so v1 is the representative —
	// not v2 despite the higher version label.
	if got[0].State != "FAILED" {
		t.Errorf("State: want FAILED (v1, the newest-started), got %q", got[0].State)
	}
	if got[0].Outcome != "failure" {
		t.Errorf("Outcome: want failure (v1), got %q", got[0].Outcome)
	}
	if got[0].VersionCount != 2 {
		t.Errorf("VersionCount: want 2, got %d", got[0].VersionCount)
	}
}
