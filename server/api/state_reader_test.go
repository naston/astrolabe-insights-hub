package api

// Tests for the SQLite-backed StateReader. Contract:
//
//   - Missing DB file → NewStateReader returns an error; caller must
//     soft-fail (the handler does in cmd/main.go).
//   - Valid DB with no rows → ListAll returns nil, no error.
//   - One submit + child rows → ListAll returns the joined shape
//     matching the legacy JSON layout.
//   - GetState picks the most recent submit per experiment name
//     (versioning: v1, v2 same name → returns v2).
//   - GetIncludes returns the most recent submit's include specs.
//   - NULL columns surface as empty strings, not "<nil>" or panics.

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// makeStateDBWith inserts the provided rows into a fresh test DB and
// returns the path the handler should open.
func makeStateDBWith(t *testing.T, fn func(*sql.DB)) string {
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
	return path
}

func TestNewStateReader_MissingFile(t *testing.T) {
	r, err := NewStateReader(filepath.Join(t.TempDir(), "does-not-exist.db"))
	// modernc.org/sqlite's behavior on a missing read-only file: Open
	// succeeds, Ping fails. Either way the constructor must surface
	// the failure so cmd/main.go can soft-fail.
	if err == nil && r != nil {
		t.Fatal("expected error for missing DB; got nil")
	}
}

func TestStateReader_EmptyDB(t *testing.T) {
	path := makeStateDBWith(t, func(db *sql.DB) {})
	r, err := NewStateReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	states, err := r.ListAll()
	if err != nil {
		t.Fatalf("ListAll on empty DB: %v", err)
	}
	if len(states) != 0 {
		t.Fatalf("want 0 states, got %d", len(states))
	}
}

func TestStateReader_ListAllShape(t *testing.T) {
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-a",
			"version":         "v3",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"gpu_type":        "gpu_8x_a100",
			"started_at":      "2026-05-30T10:00:00+00:00",
			"finished_at":     "2026-05-30T11:30:00+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
			"repo":            "git@github.com:org/repo.git",
		})
		// Child tables — verify they hydrate correctly.
		if _, err := db.Exec(
			`INSERT INTO git_tags (submit_id, tag) VALUES (?, ?), (?, ?)`,
			"test-exp-a-v3", "astrolabe/exp-a/v3-active",
			"test-exp-a-v3", "promoted",
		); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(
			`INSERT INTO includes (submit_id, spec) VALUES (?, ?)`,
			"test-exp-a-v3", "abc123",
		); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(
			`INSERT INTO state_transitions (submit_id, state, at) VALUES (?, ?, ?), (?, ?, ?)`,
			"test-exp-a-v3", "PENDING", "2026-05-30T10:00:00+00:00",
			"test-exp-a-v3", "COMPLETED", "2026-05-30T11:30:00+00:00",
		); err != nil {
			t.Fatal(err)
		}
	})

	r, err := NewStateReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	states, err := r.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 {
		t.Fatalf("want 1 state, got %d", len(states))
	}
	s := states[0]
	if s.Name != "exp-a" {
		t.Errorf("Name: want exp-a, got %q", s.Name)
	}
	if s.State != "COMPLETED" {
		t.Errorf("State: want COMPLETED, got %q", s.State)
	}
	if s.Version != "v3" {
		t.Errorf("Version: want v3, got %q", s.Version)
	}
	if s.Outcome != "success" {
		t.Errorf("Outcome: want success, got %q", s.Outcome)
	}
	if s.Repo != "git@github.com:org/repo.git" {
		t.Errorf("Repo: want git@..., got %q", s.Repo)
	}
	if len(s.GitTags) != 2 || s.GitTags[0] != "astrolabe/exp-a/v3-active" {
		t.Errorf("GitTags: %v", s.GitTags)
	}
	if len(s.IncludeRuns) != 1 || s.IncludeRuns[0] != "abc123" {
		t.Errorf("IncludeRuns: %v", s.IncludeRuns)
	}
	if len(s.StateHistory) != 2 || s.StateHistory[1].State != "COMPLETED" {
		t.Errorf("StateHistory: %v", s.StateHistory)
	}
}

func TestStateReader_GetStateReturnsLatestVersion(t *testing.T) {
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-b",
			"version":         "v1",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-05-30T09:00:00+00:00",
			"finished_at":     "2026-05-30T10:00:00+00:00",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-b",
			"version":         "v2",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-05-30T11:00:00+00:00",
			"finished_at":     "2026-05-30T12:00:00+00:00",
		})
	})
	r, err := NewStateReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	s, err := r.GetState("exp-b")
	if err != nil {
		t.Fatal(err)
	}
	if s.Version != "v2" {
		t.Errorf("GetState should pick latest by started_at: want v2, got %q", s.Version)
	}
}

func TestStateReader_GetIncludesLatestSubmit(t *testing.T) {
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-c",
			"version":         "v1",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-05-30T09:00:00+00:00",
		})
		insertSubmit(t, db, map[string]any{
			"experiment_name": "exp-c",
			"version":         "v2",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-05-30T11:00:00+00:00",
		})
		// Includes attached to v2 only.
		if _, err := db.Exec(
			`INSERT INTO includes (submit_id, spec) VALUES (?, ?), (?, ?)`,
			"test-exp-c-v2", "abc123",
			"test-exp-c-v2", "deadbeef",
		); err != nil {
			t.Fatal(err)
		}
	})
	r, err := NewStateReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	specs, err := r.GetIncludes("exp-c")
	if err != nil {
		t.Fatal(err)
	}
	if len(specs) != 2 {
		t.Fatalf("want 2 specs from v2, got %d (%v)", len(specs), specs)
	}
}

func TestStateReader_GetIncludesUnknownExperimentReturnsNil(t *testing.T) {
	path := makeStateDBWith(t, func(db *sql.DB) {})
	r, err := NewStateReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	specs, err := r.GetIncludes("nope")
	if err != nil {
		t.Fatalf("want nil error for unknown experiment, got %v", err)
	}
	if specs != nil {
		t.Fatalf("want nil specs, got %v", specs)
	}
}

func TestStateReader_NullColumnsBecomeEmptyStrings(t *testing.T) {
	path := makeStateDBWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "minimal",
			"version":         "v1",
			"submitted_by":    "bob",
			"backend":         "lambda",
			"started_at":      "2026-05-30T10:00:00+00:00",
			// Deliberately omit gpu_type, finished_at, outcome, repo.
		})
	})
	r, err := NewStateReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	states, err := r.ListAll()
	if err != nil {
		t.Fatal(err)
	}
	s := states[0]
	// NULL columns must surface as zero values, not panic or stringified <nil>.
	if s.GPUType != "" {
		t.Errorf("NULL gpu_type: want \"\", got %q", s.GPUType)
	}
	if s.FinishedAt != "" {
		t.Errorf("NULL finished_at: want \"\", got %q", s.FinishedAt)
	}
	if s.Outcome != "" {
		t.Errorf("NULL outcome: want \"\", got %q", s.Outcome)
	}
	if s.Repo != "" {
		t.Errorf("NULL repo: want \"\", got %q", s.Repo)
	}
}

func TestStateReader_TransitionsAreChronological(t *testing.T) {
	// Regression: the state-file importer back-fills a synthetic
	// current-state row at migration time, which gets a LOW id (it was
	// inserted before the originals during the bulk import) but a
	// RECENT timestamp. ORDER BY id would put the synthetic row first,
	// breaking the FSM history strip on the dashboard and producing
	// 30+ day cost windows on legacy rows. Pin the chronological-order
	// contract.
	reader := makeStateReaderWith(t, func(db *sql.DB) {
		insertSubmit(t, db, map[string]any{
			"experiment_name": "history-order-test",
			"version":         "v1",
			"submitted_by":    "alice",
			"backend":         "lambda",
			"started_at":      "2026-04-27T21:18:00+00:00",
			"finished_at":     "2026-04-27T21:25:33+00:00",
			"outcome":         "success",
			"current_state":   "COMPLETED",
		})
		sid := "test-history-order-test-v1"
		// Insert SYNTHETIC migration row FIRST (low id, recent timestamp)
		// to reproduce the bug. Then the legitimate older transitions
		// (high id, older timestamps).
		for _, tr := range []struct {
			state, at string
		}{
			{"COMPLETED", "2026-05-30T22:49:35+00:00"}, // synthetic, low id
			{"ACQUIRING", "2026-04-27T21:16:31+00:00"},
			{"SETUP", "2026-04-27T21:20:34+00:00"},
			{"RUNNING", "2026-04-27T21:20:41+00:00"},
			{"SUMMARIZING", "2026-04-27T21:25:33+00:00"},
			{"COMPLETED", "2026-04-27T21:25:35+00:00"}, // legitimate, high id
		} {
			if _, err := db.Exec(
				`INSERT INTO state_transitions (submit_id, state, at) VALUES (?, ?, ?)`,
				sid, tr.state, tr.at,
			); err != nil {
				t.Fatal(err)
			}
		}
	})

	state, err := reader.GetState("history-order-test")
	if err != nil {
		t.Fatalf("GetState: %v", err)
	}
	if len(state.StateHistory) == 0 {
		t.Fatal("StateHistory empty")
	}
	// The earliest transition by timestamp is ACQUIRING; the synthetic
	// 2026-05-30 COMPLETED is the latest. Anything else means we're
	// still ordering by id.
	if state.StateHistory[0].State != "ACQUIRING" {
		t.Fatalf("first transition: want ACQUIRING (chronological), got %q (likely ordering by id)",
			state.StateHistory[0].State)
	}
	last := state.StateHistory[len(state.StateHistory)-1]
	if last.At != "2026-05-30T22:49:35+00:00" {
		t.Fatalf("last transition: want the 2026-05-30 synthetic row, got %s @ %s",
			last.State, last.At)
	}
}
