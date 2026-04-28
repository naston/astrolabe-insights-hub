package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// AimClient talks to the Aim REST API served by `aim up`.
type AimClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewAimClient creates a client pointing at the Aim REST API.
func NewAimClient(baseURL string) *AimClient {
	return &AimClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// --- Response types (match Aim's JSON shapes) ---

type Experiment struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	RunCount     int     `json:"run_count"`
	Archived     bool    `json:"archived"`
	CreationTime float64 `json:"creation_time"`
}

type ExperimentRuns struct {
	ID   string    `json:"id"`
	Runs []AimRun  `json:"runs"`
}

type AimRun struct {
	RunID        string  `json:"run_id"`
	Name         string  `json:"name"`
	CreationTime float64 `json:"creation_time"`
	EndTime      float64 `json:"end_time"`
	Archived     bool    `json:"archived"`
}

type RunInfo struct {
	Params map[string]interface{} `json:"params"`
	Traces RunTraces              `json:"traces"`
	Props  RunProps               `json:"props"`
}

type RunTraces struct {
	Metric []MetricInfo `json:"metric"`
}

type MetricInfo struct {
	Name      string                 `json:"name"`
	Context   map[string]interface{} `json:"context"`
	LastValue float64                `json:"last_value"`
}

type RunProps struct {
	Name         string          `json:"name"`
	Description  *string         `json:"description"`
	Experiment   RunExperiment   `json:"experiment"`
	Tags         []interface{}   `json:"tags"`
	CreationTime float64         `json:"creation_time"`
	EndTime      float64         `json:"end_time"`
	Archived     bool            `json:"archived"`
	Active       bool            `json:"active"`
}

type RunExperiment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MetricData struct {
	Name    string                 `json:"name"`
	Context map[string]interface{} `json:"context"`
	Values  []float64              `json:"values"`
	Iters   []int                  `json:"iters"`
}

// --- Client methods ---

// ListExperiments returns all experiments.
func (c *AimClient) ListExperiments() ([]Experiment, error) {
	resp, err := c.httpClient.Get(c.baseURL + "/api/experiments/")
	if err != nil {
		return nil, fmt.Errorf("aim API unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("aim API returned %d", resp.StatusCode)
	}

	var experiments []Experiment
	if err := json.NewDecoder(resp.Body).Decode(&experiments); err != nil {
		return nil, fmt.Errorf("decoding experiments: %w", err)
	}
	return experiments, nil
}

// ListExperimentRuns returns all runs for a given experiment ID.
func (c *AimClient) ListExperimentRuns(experimentID string) (*ExperimentRuns, error) {
	url := fmt.Sprintf("%s/api/experiments/%s/runs/", c.baseURL, experimentID)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("aim API unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("aim API returned %d for experiment %s", resp.StatusCode, experimentID)
	}

	var result ExperimentRuns
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding experiment runs: %w", err)
	}
	return &result, nil
}

// GetRunInfo returns full info for a run (props, metric names, etc.).
func (c *AimClient) GetRunInfo(runHash string) (*RunInfo, error) {
	url := fmt.Sprintf("%s/api/runs/%s/info/", c.baseURL, runHash)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("aim API unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("aim API returned %d for run %s", resp.StatusCode, runHash)
	}

	var info RunInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, fmt.Errorf("decoding run info: %w", err)
	}
	return &info, nil
}

// AstrolabeTags is the set of astrolabe.* tags written by the
// astrolabe-composer-callback. Returned by AstrolabeTagsFromParams as
// a struct so adding new tags doesn't require renaming a positional
// return at every call site.
type AstrolabeTags struct {
	Version        string
	SubmitID       string
	ExperimentName string
	// SubmittedBy was added in v1.2.1; legacy runs have it empty and
	// the dashboard's filter dropdown surfaces them as "unknown".
	SubmittedBy string
}

// AstrolabeTagsFromParams extracts the astrolabe.* tags the
// astrolabe-composer-callback writes to an Aim run. The callback does
// ``run["astrolabe.version"] = "v3"`` etc., which Aim may serialize
// either as a flat key (``params["astrolabe.version"]``) or nested
// under a top-level "astrolabe" mapping (``params["astrolabe"]["version"]``)
// depending on the Aim version. Try both before giving up.
//
// Any field may be empty if the run wasn't tagged or the params shape
// is unexpected; callers are responsible for the legacy fallback.
func AstrolabeTagsFromParams(params map[string]interface{}) AstrolabeTags {
	if params == nil {
		return AstrolabeTags{}
	}
	tags := AstrolabeTags{
		Version:        stringFromAny(params["astrolabe.version"]),
		SubmitID:       stringFromAny(params["astrolabe.submit_id"]),
		ExperimentName: stringFromAny(params["astrolabe.experiment"]),
		SubmittedBy:    stringFromAny(params["astrolabe.user"]),
	}

	// Nested layout — fall back if any key is empty above.
	if tags.Version == "" || tags.SubmitID == "" ||
		tags.ExperimentName == "" || tags.SubmittedBy == "" {
		if nested, ok := params["astrolabe"].(map[string]interface{}); ok {
			if tags.Version == "" {
				tags.Version = stringFromAny(nested["version"])
			}
			if tags.SubmitID == "" {
				tags.SubmitID = stringFromAny(nested["submit_id"])
			}
			if tags.ExperimentName == "" {
				tags.ExperimentName = stringFromAny(nested["experiment"])
			}
			if tags.SubmittedBy == "" {
				tags.SubmittedBy = stringFromAny(nested["user"])
			}
		}
	}
	return tags
}

func stringFromAny(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// GetMetric fetches metric data (step/value pairs) for a run.
func (c *AimClient) GetMetric(runHash string, metricName string, context map[string]interface{}) (*MetricData, error) {
	url := fmt.Sprintf("%s/api/runs/%s/metric/get-batch/", c.baseURL, runHash)

	if context == nil {
		context = map[string]interface{}{}
	}

	reqBody := []map[string]interface{}{
		{"name": metricName, "context": context},
	}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshalling request: %w", err)
	}

	resp, err := c.httpClient.Post(url, "application/json", strings.NewReader(string(bodyBytes)))
	if err != nil {
		return nil, fmt.Errorf("aim API unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("aim API returned %d: %s", resp.StatusCode, string(body))
	}

	var results []MetricData
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
		return nil, fmt.Errorf("decoding metric data: %w", err)
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("no data for metric %s", metricName)
	}
	return &results[0], nil
}
