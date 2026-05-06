package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Pin the "no data yet" contract: GetMetric must return an empty
// MetricData (not an error) when Aim's REST API returns an empty
// result set. The pre-fix behavior surfaced this as an HTTP 502 from
// our handler, which the frontend's withSeed wrapper interpreted as
// "backend is down" and silently substituted a synthetic
// exponential-decay curve — rendering filler traces for runs in the
// window between submit and the first batch_end hook.

func TestGetMetric_EmptyResultsReturnsEmptyData(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			// Aim's "no data yet" shape: HTTP 200 with an empty JSON array.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("[]"))
		},
	))
	defer upstream.Close()

	client := NewAimClient(upstream.URL)
	got, err := client.GetMetric("any-run-hash", "train/loss", nil)
	if err != nil {
		t.Fatalf("GetMetric returned error %v, want nil for empty-data case", err)
	}
	if got == nil {
		t.Fatal("GetMetric returned nil, want non-nil empty MetricData")
	}
	if got.Name != "train/loss" {
		t.Errorf("Name = %q, want %q", got.Name, "train/loss")
	}
	if len(got.Values) != 0 {
		t.Errorf("Values len = %d, want 0", len(got.Values))
	}
	if len(got.Iters) != 0 {
		t.Errorf("Iters len = %d, want 0", len(got.Iters))
	}
	// Crucially: Values/Iters must be non-nil empty slices so json.Marshal
	// emits `[]` rather than `null`. Frontend chart code paths assume the
	// arrays exist before checking their length.
	if got.Values == nil {
		t.Error("Values is nil; want non-nil empty slice (so JSON encodes as [], not null)")
	}
	if got.Iters == nil {
		t.Error("Iters is nil; want non-nil empty slice (so JSON encodes as [], not null)")
	}
}

func TestGetMetric_PopulatedResultsPassesThrough(t *testing.T) {
	// Sanity: when Aim returns real data, we still propagate it
	// unchanged. Guards against an over-eager refactor that turns
	// every response into the empty stub.
	upstream := httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[{
				"name": "train/loss",
				"context": {},
				"values": [4.2, 3.8, 3.5],
				"iters": [0, 10, 20]
			}]`))
		},
	))
	defer upstream.Close()

	client := NewAimClient(upstream.URL)
	got, err := client.GetMetric("any-run-hash", "train/loss", nil)
	if err != nil {
		t.Fatalf("GetMetric returned error: %v", err)
	}
	if len(got.Values) != 3 || got.Values[0] != 4.2 {
		t.Errorf("Values = %v, want [4.2 3.8 3.5]", got.Values)
	}
	if len(got.Iters) != 3 || got.Iters[2] != 20 {
		t.Errorf("Iters = %v, want [0 10 20]", got.Iters)
	}
}

func TestGetMetric_UpstreamErrorStillSurfacesAsError(t *testing.T) {
	// Distinct from the empty-data case: if Aim itself returns a
	// non-2xx, that's a real failure and must propagate. The frontend's
	// withSeed will pass HTTP errors through (post-v1.6.x), surfacing
	// them in the UI instead of papering over with seed data.
	upstream := httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "internal aim error", http.StatusInternalServerError)
		},
	))
	defer upstream.Close()

	client := NewAimClient(upstream.URL)
	_, err := client.GetMetric("any-run-hash", "train/loss", nil)
	if err == nil {
		t.Fatal("GetMetric returned nil error for upstream 500; expected an error")
	}
}
