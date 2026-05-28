package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// StateReader reads astrolabe experiment state files from disk.
type StateReader struct {
	stateDir string
}

// NewStateReader creates a reader for the given state directory.
func NewStateReader(stateDir string) *StateReader {
	return &StateReader{stateDir: stateDir}
}

// StateTransition is one entry in the FSM history (engine.py:_transition).
// The dashboard renders these as the FSMHistory strip on the detail page.
type StateTransition struct {
	State string `json:"state"`
	At    string `json:"at"`
}

// ExperimentState represents fields from an astrolabe state JSON file.
//
// Fields that newer astrolabe versions write but older ones don't (Repo,
// LinearDocURL, Version, SubmitID, StateHistory, GitTags) zero-value
// silently when missing — the JSON decoder tolerates absent keys. The
// dashboard's frontend has matching fallbacks for empty values.
type ExperimentState struct {
	Name             string            `json:"name"`
	State            string            `json:"state"`
	Backend          string            `json:"backend"`
	GPUType          string            `json:"gpu_type"`
	StartedAt        string            `json:"started_at"`
	FinishedAt       string            `json:"finished_at"`
	CurrentStep      int               `json:"current_step"`
	TotalSteps       int               `json:"total_steps"`
	CurrentStepLabel string            `json:"current_step_label"`
	Outcome          string            `json:"outcome"`
	IncludeRuns      []string          `json:"include_runs"`
	// v1.2.0 fields — present on records the engine wrote post-versioning.
	Repo         string            `json:"repo"`
	Ref          string            `json:"ref"`
	LinearDocURL string            `json:"linear_doc_url"`
	Version      string            `json:"version"`
	SubmitID     string            `json:"submit_id"`
	StateHistory []StateTransition `json:"state_history"`
	GitTags      []string          `json:"git_tags"`
	// v1.2.1+ — submitter identity. Empty for state files that
	// pre-date v1.2.1; the dashboard buckets those under "unknown" in
	// the home-page Submitter filter dropdown.
	SubmittedBy string `json:"submitted_by"`
	// Cost-tracking fields, added with the cost-tracking work
	// (astrolabe v1.7.x+ on the engine side). Pointer types so we can
	// distinguish "0" (free, local backend) from "absent / pre-cost-
	// tracking record" (renders as "—" in the cost UI). Records
	// written before the engine started persisting these decode as
	// nil pointers; backfilled records show the rate that was
	// recovered via the legacy alias map.
	GPURateCentsPerHour *int `json:"gpu_rate_cents_per_hour"`
	EstimatedCostCents  *int `json:"estimated_cost_cents"`
}

// ListAll returns all experiment states from the state directory.
func (r *StateReader) ListAll() ([]ExperimentState, error) {
	entries, err := os.ReadDir(r.stateDir)
	if err != nil {
		return nil, err
	}
	var states []ExperimentState
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || entry.Name() == "daemon.pid" {
			continue
		}
		state, err := r.loadFile(filepath.Join(r.stateDir, entry.Name()))
		if err != nil {
			continue
		}
		states = append(states, *state)
	}
	return states, nil
}

// GetIncludes returns the include_runs list for a given experiment name.
func (r *StateReader) GetIncludes(experimentName string) ([]string, error) {
	state, err := r.loadState(experimentName)
	if err != nil {
		return nil, err
	}
	return state.IncludeRuns, nil
}

// GetState returns the full experiment state for a given name.
func (r *StateReader) GetState(experimentName string) (*ExperimentState, error) {
	return r.loadState(experimentName)
}

func (r *StateReader) loadState(name string) (*ExperimentState, error) {
	safeName := strings.ReplaceAll(strings.ReplaceAll(name, "/", "_"), " ", "_")
	path := filepath.Join(r.stateDir, safeName+".json")
	return r.loadFile(path)
}

func (r *StateReader) loadFile(path string) (*ExperimentState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var state ExperimentState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}
