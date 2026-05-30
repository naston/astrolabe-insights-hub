package api

// Tests for HandleRunEvals — the eval-discovery endpoint.
//
// Contract being verified (from plans/eval-runs.md, not from the
// implementation):
//
//   * Returns the set of eval Aim runs that score a given model run,
//     keyed by ``astrolabe.kind == "eval"`` AND
//     ``astrolabe.model_run_hash == <hash>``.
//   * Dedups by ``task_set`` keeping the newest by creation_time —
//     re-eval over time leaves older runs in Aim for forensics; the
//     dashboard shows the latest by default.
//   * Returns deterministic ordering: newest first, ties broken by
//     task_set.
//   * Rejects requests without a run hash with HTTP 400.
//   * Skips eval runs missing a ``task_set`` tag (a section can't be
//     rendered without a label).
//   * Skips non-eval runs (training, metadata) even when they happen
//     to share the eval Aim experiment.
//
// Uses the same fakeAim httptest fixture as cost_test.go so the SDK
// layer (param-shape parsing, ListExperimentRuns paging quirks) goes
// through real code.

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

// makeEvalFakeRun creates an eval-tagged fakeRun.
func makeEvalFakeRun(hash, taskSet, modelRunHash string, createdAt time.Time) fakeRun {
	return fakeRun{
		// Eval runs are filed under ``eval/<task_set>`` per the
		// log_eval_table helper's convention.
		experiment:   "eval/" + taskSet,
		hash:         hash,
		creationTime: unixSecs(createdAt),
		endTime:      unixSecs(createdAt.Add(time.Minute)),
		tags: map[string]any{
			"astrolabe.kind":           "eval",
			"astrolabe.task_set":       taskSet,
			"astrolabe.model_run_hash": modelRunHash,
		},
	}
}

func callEvals(t *testing.T, h *Handler, modelRunHash string) []EvalManifestEntry {
	t.Helper()
	url := "/api/runs/" + modelRunHash + "/evals"
	req := httptest.NewRequest("GET", url, nil)
	rr := httptest.NewRecorder()
	h.HandleRunEvals(rr, req)
	if rr.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp []EvalManifestEntry
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

// --- Empty/edge cases ---

func TestHandleRunEvalsNoEvals(t *testing.T) {
	aim := fakeAim(t, nil)
	h := makeHandlerWithAim(t, aim, "")
	got := callEvals(t, h, "model-1")
	if len(got) != 0 {
		t.Fatalf("expected empty manifest, got %v", got)
	}
}

func TestHandleRunEvalsMissingHashReturns400(t *testing.T) {
	aim := fakeAim(t, nil)
	h := makeHandlerWithAim(t, aim, "")
	// URL with /api/runs//evals — empty path segment — must 400.
	req := httptest.NewRequest("GET", "/api/runs//evals", nil)
	rr := httptest.NewRecorder()
	h.HandleRunEvals(rr, req)
	if rr.Code != 400 {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

// --- Filtering by tag contract ---

func TestHandleRunEvalsFiltersByModelRunHash(t *testing.T) {
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		makeEvalFakeRun("e1", "glue", "model-1", t0),
		makeEvalFakeRun("e2", "glue", "model-2", t0),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d: %v", len(got), got)
	}
	if got[0].AimRunHash != "e1" {
		t.Errorf("expected e1, got %s", got[0].AimRunHash)
	}
}

func TestHandleRunEvalsSkipsNonEvalKind(t *testing.T) {
	// Training and metadata runs filed under eval/glue (an accident or
	// misconfigured producer) must NOT surface in the eval manifest.
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		{
			experiment:   "eval/glue",
			hash:         "training-run",
			creationTime: unixSecs(t0),
			tags: map[string]any{
				"astrolabe.kind":           "training",
				"astrolabe.model_run_hash": "model-1",
				"astrolabe.task_set":       "glue",
			},
		},
		{
			experiment:   "eval/glue",
			hash:         "metadata-run",
			creationTime: unixSecs(t0),
			tags: map[string]any{
				"astrolabe.kind":           "metadata",
				"astrolabe.model_run_hash": "model-1",
				"astrolabe.task_set":       "glue",
			},
		},
		makeEvalFakeRun("eval-run", "glue", "model-1", t0),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d: %v", len(got), got)
	}
	if got[0].AimRunHash != "eval-run" {
		t.Errorf("expected eval-run, got %s", got[0].AimRunHash)
	}
}

func TestHandleRunEvalsSkipsEmptyTaskSet(t *testing.T) {
	// A section can't render without a label; drop these from the
	// manifest rather than display a blank-titled section.
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		{
			experiment:   "eval/glue",
			hash:         "no-tag",
			creationTime: unixSecs(t0),
			tags: map[string]any{
				"astrolabe.kind":           "eval",
				"astrolabe.model_run_hash": "model-1",
				// astrolabe.task_set missing
			},
		},
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 0 {
		t.Errorf("expected empty manifest, got %v", got)
	}
}

func TestHandleRunEvalsSkipsRunsOutsideEvalExperimentPrefix(t *testing.T) {
	// Pre-filter: only experiments named ``eval/...`` are scanned.
	// An eval-tagged run filed under a wrong experiment (e.g., the
	// model's training experiment) won't be discovered. This is the
	// price of the cheap pre-filter — producers who use the helpers
	// always file correctly.
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		{
			experiment:   "my-training-experiment",
			hash:         "misfiled",
			creationTime: unixSecs(t0),
			tags: map[string]any{
				"astrolabe.kind":           "eval",
				"astrolabe.task_set":       "glue",
				"astrolabe.model_run_hash": "model-1",
			},
		},
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 0 {
		t.Errorf("expected misfiled run to be ignored, got %v", got)
	}
}

// --- Re-eval / dedup semantics ---

func TestHandleRunEvalsDedupsByTaskSetKeepingNewest(t *testing.T) {
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	older := t0
	newer := t0.Add(2 * time.Hour)
	runs := []fakeRun{
		makeEvalFakeRun("eval-old", "glue", "model-1", older),
		makeEvalFakeRun("eval-new", "glue", "model-1", newer),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 1 {
		t.Fatalf("expected dedup to one row, got %d: %v", len(got), got)
	}
	if got[0].AimRunHash != "eval-new" {
		t.Errorf("expected newer eval-new, got %s", got[0].AimRunHash)
	}
}

func TestHandleRunEvalsMultipleTaskSets(t *testing.T) {
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		makeEvalFakeRun("e-glue", "glue", "model-1", t0),
		makeEvalFakeRun("e-mmlu", "mmlu", "model-1", t0.Add(time.Hour)),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d: %v", len(got), got)
	}
	taskSets := map[string]bool{got[0].TaskSet: true, got[1].TaskSet: true}
	if !taskSets["glue"] || !taskSets["mmlu"] {
		t.Errorf("expected glue and mmlu, got %v", taskSets)
	}
}

// --- Ordering ---

func TestHandleRunEvalsOrdersNewestFirst(t *testing.T) {
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		// Out-of-order on purpose — the handler must sort.
		makeEvalFakeRun("e-old", "mmlu", "model-1", t0),
		makeEvalFakeRun("e-new", "glue", "model-1", t0.Add(2*time.Hour)),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].AimRunHash != "e-new" {
		t.Errorf("expected newest first, got %s", got[0].AimRunHash)
	}
}

func TestHandleRunEvalsTaskSetBreaksTimeTies(t *testing.T) {
	// Two eval runs created at the same instant — deterministic order
	// requires a secondary key. Plan says task_set ascending.
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		makeEvalFakeRun("e-mmlu", "mmlu", "model-1", t0),
		makeEvalFakeRun("e-glue", "glue", "model-1", t0),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0].TaskSet != "glue" {
		t.Errorf("expected glue first (alphabetical tiebreak), got %s", got[0].TaskSet)
	}
}

// --- Happy path summary ---

func TestHandleRunEvalsHappyPath(t *testing.T) {
	t0 := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	runs := []fakeRun{
		makeEvalFakeRun("e1", "glue", "model-1", t0.Add(2*time.Hour)),
		makeEvalFakeRun("e2", "mmlu", "model-1", t0.Add(time.Hour)),
		// Older re-eval of glue — should NOT surface.
		makeEvalFakeRun("e3", "glue", "model-1", t0),
		// Different model — should NOT surface.
		makeEvalFakeRun("e4", "glue", "model-2", t0.Add(time.Hour)),
	}
	aim := fakeAim(t, runs)
	h := makeHandlerWithAim(t, aim, "")

	got := callEvals(t, h, "model-1")
	if len(got) != 2 {
		t.Fatalf("expected 2 entries (glue-newest, mmlu), got %d: %v",
			len(got), got)
	}
	// glue newer than mmlu, so glue first.
	if got[0].TaskSet != "glue" || got[0].AimRunHash != "e1" {
		t.Errorf("expected glue/e1 first, got %s/%s",
			got[0].TaskSet, got[0].AimRunHash)
	}
	if got[1].TaskSet != "mmlu" || got[1].AimRunHash != "e2" {
		t.Errorf("expected mmlu/e2 second, got %s/%s",
			got[1].TaskSet, got[1].AimRunHash)
	}
}
