package api

// Shared test helpers for state-DB tests. ``_test.go`` suffix keeps
// them out of the production binary while still being usable from
// every test file in the package.

import (
	"database/sql"
	"fmt"
	"testing"
)

// testSchemaSQL mirrors astrolabe/db.py migration 0001 exactly. Kept
// verbatim so accidental drift between the two repos surfaces as a
// schema-version test failure rather than a silent column rename. The
// CHECK constraints are dropped here on purpose: tests reach in with
// raw INSERTs and we don't want to re-encode the FSM here.
const testSchemaSQL = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO schema_migrations VALUES (2, '2026-06-02T00:00:00+00:00');

CREATE TABLE submits (
	id                      INTEGER PRIMARY KEY,
	submit_id               TEXT NOT NULL UNIQUE,
	experiment_name         TEXT NOT NULL,
	version                 TEXT NOT NULL,
	submitted_by            TEXT NOT NULL,
	repo                    TEXT,
	ref                     TEXT,
	backend                 TEXT NOT NULL,
	gpu_type                TEXT,
	started_at              TEXT NOT NULL,
	finished_at             TEXT,
	outcome                 TEXT,
	current_state           TEXT NOT NULL,
	instance_id             TEXT,
	instance_ip             TEXT,
	current_step            INTEGER NOT NULL DEFAULT 0,
	total_steps             INTEGER NOT NULL DEFAULT 0,
	current_step_label      TEXT,
	healing_attempts        INTEGER NOT NULL DEFAULT 0,
	slack_thread_ts         TEXT,
	linear_doc_id           TEXT,
	linear_doc_url          TEXT,
	aim_metadata_run_hash   TEXT,
	pid                     INTEGER,
	gpu_rate_cents_per_hour INTEGER,
	estimated_cost_cents    INTEGER,
	created_at              TEXT NOT NULL,
	updated_at              TEXT NOT NULL,
	UNIQUE (experiment_name, version)
);

CREATE TABLE state_transitions (
	id INTEGER PRIMARY KEY,
	submit_id TEXT NOT NULL REFERENCES submits(submit_id),
	state TEXT NOT NULL,
	at TEXT NOT NULL
);
CREATE TABLE git_tags (
	id INTEGER PRIMARY KEY,
	submit_id TEXT NOT NULL REFERENCES submits(submit_id),
	tag TEXT NOT NULL
);
CREATE TABLE includes (
	id INTEGER PRIMARY KEY,
	submit_id TEXT NOT NULL REFERENCES submits(submit_id),
	spec TEXT NOT NULL
);
`

// insertSubmit drops one row into a test state DB. ``fields`` accepts
// the new schema's column names; missing optionals are written as
// NULL. ``submit_id`` defaults to a deterministic ``test-<name>-<version>``
// synthesis so test child-row inserts can reference it without an
// extra round-trip to read it back.
func insertSubmit(t *testing.T, db *sql.DB, fields map[string]any) {
	t.Helper()
	name, _ := fields["experiment_name"].(string)
	version, _ := fields["version"].(string)
	if version == "" {
		version = "v1"
	}
	submitID, _ := fields["submit_id"].(string)
	if submitID == "" {
		submitID = fmt.Sprintf("test-%s-%s", name, version)
	}
	now := "2026-05-30T00:00:00+00:00"
	if _, err := db.Exec(`INSERT INTO submits (
		submit_id, experiment_name, version, submitted_by, backend, gpu_type,
		started_at, finished_at, outcome, current_state, repo,
		gpu_rate_cents_per_hour, estimated_cost_cents,
		created_at, updated_at
	) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		submitID,
		name,
		version,
		strOrEmpty(fields["submitted_by"]),
		strOrEmpty(fields["backend"]),
		nullableString(fields["gpu_type"]),
		strOrEmpty(fields["started_at"]),
		nullableString(fields["finished_at"]),
		nullableString(fields["outcome"]),
		fallback(fields["current_state"], "COMPLETED"),
		nullableString(fields["repo"]),
		nullableInt(fields["gpu_rate_cents_per_hour"]),
		nullableInt(fields["estimated_cost_cents"]),
		now, now,
	); err != nil {
		t.Fatal(err)
	}
}

func nullableInt(v any) sql.NullInt64 {
	switch n := v.(type) {
	case int:
		return sql.NullInt64{Int64: int64(n), Valid: true}
	case int64:
		return sql.NullInt64{Int64: n, Valid: true}
	default:
		return sql.NullInt64{Valid: false}
	}
}

func strOrEmpty(v any) string {
	s, _ := v.(string)
	return s
}

func nullableString(v any) sql.NullString {
	s, _ := v.(string)
	return sql.NullString{String: s, Valid: s != ""}
}

func fallback(v any, def string) string {
	s, _ := v.(string)
	if s == "" {
		return def
	}
	return s
}
