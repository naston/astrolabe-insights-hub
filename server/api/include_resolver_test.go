package api

import (
	"testing"
)

// resolveInclude is the load-bearing pure function for v1.4.x include
// resolution. These tests pin its behavior across the four resolution
// shapes (hash / experiment / run-name / unknown) and the conservative
// hash-like detector that prevents short hex-shaped experiment names
// from being misinterpreted as Aim run hashes.
//
// Run-name matches resolve to the single most recent matching run by
// CreationTime — pulling every match across experiments flooded the
// comparison set with stuff the researcher didn't ask for.

func makeIndexes() (
	map[string][]RunSummary,
	map[string]RunSummary,
	map[string][]RunSummary,
) {
	// CreationTime ordering matters for run-name "latest" tests:
	// r1 < r2 < r3 < r4. So among bert-tiny matches (r1, r2), r2 is
	// the latest; among all four uniqueRun-named runs, r4 wins.
	r1 := RunSummary{Hash: "a1b2c3d4e5f60708090a0b0c", Name: "bert-tiny", ExperimentName: "exp-A", CreationTime: 1.0}
	r2 := RunSummary{Hash: "b2c3d4e5f60708090a0b0c0d", Name: "bert-tiny", ExperimentName: "exp-B", CreationTime: 2.0}
	r3 := RunSummary{Hash: "c3d4e5f60708090a0b0c0d0e", Name: "latent-bert", ExperimentName: "exp-A", CreationTime: 3.0}
	r4 := RunSummary{Hash: "d4e5f60708090a0b0c0d0e0f", Name: "uniqueRun", ExperimentName: "exp-C", CreationTime: 4.0}

	byExp := map[string][]RunSummary{
		"exp-A": {r1, r3},
		"exp-B": {r2},
		"exp-C": {r4},
	}
	byHash := map[string]RunSummary{
		r1.Hash: r1, r2.Hash: r2, r3.Hash: r3, r4.Hash: r4,
	}
	byRunName := map[string][]RunSummary{
		"bert-tiny":   {r1, r2},
		"latent-bert": {r3},
		"uniqueRun":   {r4},
	}
	return byExp, byHash, byRunName
}

func TestResolveInclude_Hash(t *testing.T) {
	byExp, byHash, byRunName := makeIndexes()
	got := resolveInclude("a1b2c3d4e5f60708090a0b0c", byExp, byHash, byRunName)

	if got.Type != "hash" {
		t.Errorf("Type = %q, want %q", got.Type, "hash")
	}
	if len(got.Runs) != 1 || got.Runs[0] != "a1b2c3d4e5f60708090a0b0c" {
		t.Errorf("Runs = %v, want single hash", got.Runs)
	}
}

func TestResolveInclude_ExperimentName(t *testing.T) {
	byExp, byHash, byRunName := makeIndexes()
	got := resolveInclude("exp-A", byExp, byHash, byRunName)

	if got.Type != "experiment" {
		t.Errorf("Type = %q, want %q", got.Type, "experiment")
	}
	if len(got.Runs) != 2 {
		t.Errorf("Runs len = %d, want 2", len(got.Runs))
	}
}

func TestResolveInclude_RunName_SingleMatch(t *testing.T) {
	// "latent-bert" only exists once in the corpus → resolves to that
	// one run with type="run-name".
	byExp, byHash, byRunName := makeIndexes()
	got := resolveInclude("latent-bert", byExp, byHash, byRunName)

	if got.Type != "run-name" {
		t.Errorf("Type = %q, want %q", got.Type, "run-name")
	}
	if len(got.Runs) != 1 {
		t.Errorf("Runs len = %d, want 1", len(got.Runs))
	}
}

func TestResolveInclude_RunName_PicksLatestAcrossExperiments(t *testing.T) {
	// "bert-tiny" exists in both exp-A (CreationTime 1.0) and exp-B
	// (CreationTime 2.0). Old behavior pulled both; new behavior
	// resolves to the SINGLE most recent matching run — r2 — so the
	// comparison set isn't flooded with every prior version that
	// happens to share the inner run-name.
	byExp, byHash, byRunName := makeIndexes()
	got := resolveInclude("bert-tiny", byExp, byHash, byRunName)

	if got.Type != "run-name" {
		t.Errorf("Type = %q, want %q (no more run-name-multi)", got.Type, "run-name")
	}
	if len(got.Runs) != 1 {
		t.Fatalf("Runs len = %d, want 1 (latest only)", len(got.Runs))
	}
	if got.Runs[0] != "b2c3d4e5f60708090a0b0c0d" {
		t.Errorf("Runs[0] = %q, want r2's hash (the later CreationTime)", got.Runs[0])
	}
}

func TestResolveInclude_UnknownString(t *testing.T) {
	// Nothing matches — returned entry has type="unknown", empty Runs.
	// The frontend renders this as a struck-out chip rather than
	// silently dropping the include from the response.
	byExp, byHash, byRunName := makeIndexes()
	got := resolveInclude("does-not-exist", byExp, byHash, byRunName)

	if got.Type != "unknown" {
		t.Errorf("Type = %q, want %q", got.Type, "unknown")
	}
	if len(got.Runs) != 0 {
		t.Errorf("Runs = %v, want empty", got.Runs)
	}
	if got.Name != "does-not-exist" {
		t.Errorf("Name = %q, want input preserved", got.Name)
	}
}

func TestResolveInclude_UnknownHashShape(t *testing.T) {
	// Looks like a hash (24 hex chars) but isn't in the index — falls
	// all the way through. Empty hash-shaped strings shouldn't match
	// experiment-name or run-name lookups either, so this must end as
	// "unknown" rather than coincidentally matching something else.
	byExp, byHash, byRunName := makeIndexes()
	got := resolveInclude("ffffffffffffffffffffffff", byExp, byHash, byRunName)

	if got.Type != "unknown" {
		t.Errorf("Type = %q, want %q", got.Type, "unknown")
	}
}

func TestResolveInclude_ExperimentBeforeRunName(t *testing.T) {
	// If a string matches both an experiment and a run.name, the
	// experiment match wins per resolution order — pulls all runs of
	// that experiment, not just the runs whose name matches.
	exp := RunSummary{Hash: "h1aaaaaaaaaaaaaaaa", Name: "shared-name", ExperimentName: "shared-name"}
	other := RunSummary{Hash: "h2bbbbbbbbbbbbbbbb", Name: "shared-name", ExperimentName: "other-exp"}

	byExp := map[string][]RunSummary{
		"shared-name": {exp},
		"other-exp":   {other},
	}
	byHash := map[string]RunSummary{exp.Hash: exp, other.Hash: other}
	byRunName := map[string][]RunSummary{
		"shared-name": {exp, other},
	}

	got := resolveInclude("shared-name", byExp, byHash, byRunName)

	if got.Type != "experiment" {
		t.Fatalf("Type = %q, want %q (experiment match wins)", got.Type, "experiment")
	}
	if len(got.Runs) != 1 || got.Runs[0] != exp.Hash {
		t.Errorf("Runs = %v, want exactly the matching experiment's runs", got.Runs)
	}
}

func TestIsHashLike(t *testing.T) {
	cases := []struct {
		input string
		want  bool
	}{
		// Lowercase hex, ≥16 chars: yes.
		{"a1b2c3d4e5f60708", true},
		{"a1b2c3d4e5f60708090a0b0c", true},
		// Below threshold: no, even if hex.
		{"a1b2c3d4", false},
		{"abc123", false},
		// Non-hex characters anywhere: no.
		{"a1b2c3d4e5f60708g", false},
		// Uppercase hex isn't accepted — Aim's hashes are lowercase
		// in practice, and rejecting upper-case lets short ALL-CAPS
		// experiment names like "ABCDEF1234" not get caught.
		{"A1B2C3D4E5F60708", false},
		// Empty: no.
		{"", false},
		// Looks like an experiment name: no.
		{"astrolabe-infra-test", false},
	}
	for _, c := range cases {
		got := isHashLike(c.input)
		if got != c.want {
			t.Errorf("isHashLike(%q) = %v, want %v", c.input, got, c.want)
		}
	}
}
