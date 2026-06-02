package api

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// StateReader reads astrolabe submit state from the SQLite database that
// astrolabe v1.8+ writes (see ``plans/state-files-to-sqlite.md`` in the
// astrolabe repo). Replaces the prior directory-of-JSON-files reader.
//
// The exported method set (``ListAll``, ``GetIncludes``, ``GetState``)
// and the returned ``ExperimentState`` shape are unchanged so the
// existing handler / cost / include-resolver code keeps working without
// modification. Field-name translation between the SQLite schema and
// the legacy JSON shape happens here.
type StateReader struct {
	db *sql.DB
}

// NewStateReader opens (read-only) the astrolabe state DB at ``dbPath``.
//
// The connection string sets read-only mode + WAL so the dashboard can
// read while the engine writes from a different process without lock
// contention. Foreign keys are enabled per connection per SQLite
// convention — required so the joins below see referential integrity
// guarantees the engine relies on.
//
// Returns nil if the DB file does not exist. Callers tolerate a nil
// reader and degrade to an empty experiments list, matching the
// pre-SQLite behavior of an empty state directory.
func NewStateReader(dbPath string) (*StateReader, error) {
	if dbPath == "" {
		return nil, fmt.Errorf("empty db path")
	}
	// modernc.org/sqlite uses URI query params for PRAGMAs.
	// mode=ro: read-only (engine is the only writer)
	// _pragma=foreign_keys(1): turn FKs on per connection
	// _pragma=busy_timeout(5000): wait up to 5s if the engine has a
	//   write lock rather than failing immediately
	dsn := "file:" + dbPath + "?mode=ro&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open state DB %s: %w", dbPath, err)
	}
	// sql.Open is lazy; ping to surface "file doesn't exist" up front.
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping state DB %s: %w", dbPath, err)
	}
	// Cap connections: the dashboard reads, the engine writes. WAL
	// supports concurrent readers + a single writer; opening many
	// reader connections wastes file handles and adds nothing.
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	return &StateReader{db: db}, nil
}

// Close releases the underlying database connection pool.
func (r *StateReader) Close() error {
	if r == nil || r.db == nil {
		return nil
	}
	return r.db.Close()
}

// StateTransition is one entry in the FSM history. Shape preserved from
// the JSON era so the frontend's FSMHistory component keeps rendering.
type StateTransition struct {
	State string `json:"state"`
	At    string `json:"at"`
}

// ExperimentState mirrors the legacy state-file JSON shape so the
// handlers don't need to change. SQLite NULLs become zero values via
// sql.NullString unwrapping below.
type ExperimentState struct {
	Name                string            `json:"name"`
	State               string            `json:"state"`
	Backend             string            `json:"backend"`
	GPUType             string            `json:"gpu_type"`
	StartedAt           string            `json:"started_at"`
	FinishedAt          string            `json:"finished_at"`
	CurrentStep         int               `json:"current_step"`
	TotalSteps          int               `json:"total_steps"`
	CurrentStepLabel    string            `json:"current_step_label"`
	Outcome             string            `json:"outcome"`
	IncludeRuns         []string          `json:"include_runs"`
	Repo                string            `json:"repo"`
	Ref                 string            `json:"ref"`
	LinearDocURL        string            `json:"linear_doc_url"`
	Version             string            `json:"version"`
	SubmitID            string            `json:"submit_id"`
	StateHistory        []StateTransition `json:"state_history"`
	GitTags             []string          `json:"git_tags"`
	SubmittedBy         string            `json:"submitted_by"`
	GPURateCentsPerHour *int              `json:"gpu_rate_cents_per_hour"`
	EstimatedCostCents  *int              `json:"estimated_cost_cents"`
}

// submitColumns is the SELECT list used by every "load submit" query.
// Centralized so renames in the schema propagate to one place.
const submitColumns = `
	submit_id, experiment_name, version, submitted_by, backend, gpu_type,
	repo, ref, started_at, finished_at, outcome, current_state,
	instance_id, instance_ip, current_step, total_steps,
	current_step_label, healing_attempts, slack_thread_ts,
	linear_doc_id, linear_doc_url, aim_metadata_run_hash, pid,
	gpu_rate_cents_per_hour, estimated_cost_cents
`

// ListAll returns every submit in the DB.
//
// Sorted newest-first by ``started_at`` (with id as tiebreak) so the
// frontend doesn't have to re-sort. For each row we load the child
// tables (git_tags, includes, state_transitions) — N+1 in the worst
// case, but the per-row cost is one indexed lookup against a small
// table. At 50k submits this is microseconds per row; the home-page
// cache (2s TTL) absorbs the rare cold load.
func (r *StateReader) ListAll() ([]ExperimentState, error) {
	if r == nil || r.db == nil {
		return nil, nil
	}
	rows, err := r.db.Query(`SELECT ` + submitColumns + `
		FROM submits
		ORDER BY started_at DESC, id DESC`)
	if err != nil {
		return nil, fmt.Errorf("list submits: %w", err)
	}
	defer rows.Close()

	var out []ExperimentState
	for rows.Next() {
		s, submitID, err := scanSubmit(rows)
		if err != nil {
			return nil, err
		}
		if err := r.hydrateChildren(submitID, s); err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// GetState returns the most recent submit for the given experiment name.
func (r *StateReader) GetState(experimentName string) (*ExperimentState, error) {
	if r == nil || r.db == nil {
		return nil, fmt.Errorf("no state DB")
	}
	row := r.db.QueryRow(`SELECT `+submitColumns+`
		FROM submits
		WHERE experiment_name = ?
		ORDER BY started_at DESC, id DESC
		LIMIT 1`, experimentName)
	s, submitID, err := scanSubmit(row)
	if err != nil {
		return nil, err
	}
	if err := r.hydrateChildren(submitID, s); err != nil {
		return nil, err
	}
	return s, nil
}

// GetIncludes returns the include specs for the most recent submit of
// the given experiment name. Returns nil (not error) when the
// experiment is unknown — caller renders an empty includes list.
func (r *StateReader) GetIncludes(experimentName string) ([]string, error) {
	if r == nil || r.db == nil {
		return nil, nil
	}
	var submitID string
	err := r.db.QueryRow(`SELECT submit_id FROM submits
		WHERE experiment_name = ?
		ORDER BY started_at DESC, id DESC LIMIT 1`,
		experimentName).Scan(&submitID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.listIncludes(submitID)
}

// --- scanning helpers ---

// scanner abstracts ``*sql.Row`` and ``*sql.Rows`` so scanSubmit works
// for both single-row and multi-row queries without duplication.
type scanner interface {
	Scan(dest ...interface{}) error
}

// scanSubmit reads one ``submits`` row into an ExperimentState and
// returns the submit_id separately (the child-table loaders need it).
//
// All optional columns are scanned through ``sql.Null*`` types so a
// NULL in SQLite becomes the zero value of the legacy JSON shape —
// matches what an absent JSON key produced under StateReader-v1.
func scanSubmit(sc scanner) (*ExperimentState, string, error) {
	var (
		submitID, experimentName, version, submittedBy, backend, currentState string
		gpuType, repo, ref, finishedAt, outcome                                sql.NullString
		instanceID, instanceIP, currentStepLabel, slackThreadTS                sql.NullString
		linearDocID, linearDocURL, aimMetadataRunHash                          sql.NullString
		startedAt                                                              string
		currentStep, totalSteps, healingAttempts                               int
		pid                                                                    sql.NullInt64
		gpuRateCentsPerHour, estimatedCostCents                                sql.NullInt64
	)
	if err := sc.Scan(
		&submitID, &experimentName, &version, &submittedBy, &backend, &gpuType,
		&repo, &ref, &startedAt, &finishedAt, &outcome, &currentState,
		&instanceID, &instanceIP, &currentStep, &totalSteps,
		&currentStepLabel, &healingAttempts, &slackThreadTS,
		&linearDocID, &linearDocURL, &aimMetadataRunHash, &pid,
		&gpuRateCentsPerHour, &estimatedCostCents,
	); err != nil {
		return nil, "", err
	}
	_ = pid // not surfaced in the JSON shape
	_ = healingAttempts
	_ = aimMetadataRunHash
	_ = linearDocID
	_ = instanceID
	_ = instanceIP
	s := &ExperimentState{
		Name:             experimentName,
		State:            currentState,
		Backend:          backend,
		GPUType:          gpuType.String,
		StartedAt:        startedAt,
		FinishedAt:       finishedAt.String,
		CurrentStep:      currentStep,
		TotalSteps:       totalSteps,
		CurrentStepLabel: currentStepLabel.String,
		Outcome:          outcome.String,
		Repo:             repo.String,
		Ref:              ref.String,
		LinearDocURL:     linearDocURL.String,
		Version:          version,
		SubmitID:         submitID,
		SubmittedBy:      submittedBy,
	}
	if gpuRateCentsPerHour.Valid {
		v := int(gpuRateCentsPerHour.Int64)
		s.GPURateCentsPerHour = &v
	}
	if estimatedCostCents.Valid {
		v := int(estimatedCostCents.Int64)
		s.EstimatedCostCents = &v
	}
	return s, submitID, nil
}

// hydrateChildren populates IncludeRuns / GitTags / StateHistory from
// the child tables. Called once per row by ListAll and GetState; never
// in tight loops within the same request.
func (r *StateReader) hydrateChildren(submitID string, s *ExperimentState) error {
	includes, err := r.listIncludes(submitID)
	if err != nil {
		return err
	}
	s.IncludeRuns = includes

	tags, err := r.listGitTags(submitID)
	if err != nil {
		return err
	}
	s.GitTags = tags

	history, err := r.listTransitions(submitID)
	if err != nil {
		return err
	}
	s.StateHistory = history
	return nil
}

func (r *StateReader) listIncludes(submitID string) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT spec FROM includes WHERE submit_id = ? ORDER BY id`,
		submitID)
	if err != nil {
		return nil, fmt.Errorf("list includes for %s: %w", submitID, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var spec string
		if err := rows.Scan(&spec); err != nil {
			return nil, err
		}
		out = append(out, spec)
	}
	return out, rows.Err()
}

func (r *StateReader) listGitTags(submitID string) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT tag FROM git_tags WHERE submit_id = ? ORDER BY id`,
		submitID)
	if err != nil {
		return nil, fmt.Errorf("list git_tags for %s: %w", submitID, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		out = append(out, tag)
	}
	return out, rows.Err()
}

func (r *StateReader) listTransitions(submitID string) ([]StateTransition, error) {
	rows, err := r.db.Query(
		`SELECT state, at FROM state_transitions WHERE submit_id = ? ORDER BY id`,
		submitID)
	if err != nil {
		return nil, fmt.Errorf("list state_transitions for %s: %w", submitID, err)
	}
	defer rows.Close()
	var out []StateTransition
	for rows.Next() {
		var t StateTransition
		if err := rows.Scan(&t.State, &t.At); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

