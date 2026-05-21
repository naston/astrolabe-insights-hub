# Building your own frontend

A practitioner's cookbook for surfacing astrolabe's data outside the bundled dashboard. Aimed at someone who wants to display experiments / runs / metrics in Linear, Notion, a Slack bot, a Streamlit dashboard, an internal tool — without forking this repo.

> **Status as of v1.6.x**: the canonical UI (this dashboard) covers training-time scalar metrics and orchestration metadata. Anything richer (attention maps, gradient histograms, sample outputs) is out of first-class scope by design — astrolabe owns the lifecycle and comparison story; Aim owns the data-lake. The escape hatches below let you build whatever surface you want without us being in the way.
>
> We'll revisit the scope question around v3, when external usage gives signal on what people actually want.

---

## Pick a lane

| Goal | Lane |
|---|---|
| "Display experiments / runs / version groups in my own UI" | **Lane 1**: read from this dashboard's Go API. |
| "Display non-scalar Aim data (images, histograms) with astrolabe's grouping" | **Lane 2**: talk to Aim directly, use our tag conventions. |
| "Log from training code without the `astrolabe-callbacks` library" | **Lane 3**: mimic the callback's env-var-to-tag wiring. |

Lanes 1 and 2 compose — a custom UI can read both this dashboard's API for orchestration data and Aim's API for the rich metric types we don't surface.

---

## Lane 1: read from this dashboard's Go API

The simplest path. The Go server runs on the NUC at `http://<nuc>:43801` and exposes a JSON API with everything the bundled React frontend reads. No auth model — designed for single-tenant trusted-network access (typically over SSH tunnel or LAN).

### Endpoint reference

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/experiments` | List of all experiments with state, GPU type, run count, version count, submitter |
| `GET` | `/api/experiments/{name}/runs` | Detailed runs for one experiment (metrics list + final loss) |
| `GET` | `/api/experiments/{name}/includes` | Resolved `--include` directives for an experiment |
| `GET` | `/api/runs` | Flat list of all runs across all experiments, sorted by creation time desc |
| `GET` | `/api/runs/{hash}/info` | Full Aim metadata for a run (params, traces, props) |
| `GET` | `/api/runs/{hash}/metrics` | Available metric names for a run |
| `GET` | `/api/runs/{hash}/metrics/{name}` | Time-series for one metric (steps, values, wall_times) |
| `GET` | `/api/config/colors` | Color palette for chart rendering |
| `GET` | `/api/health` | Connectivity check against upstream Aim API |

Path params (`{name}`, `{hash}`) accept anything — metric names commonly contain slashes (`train/loss`, `eval/MaskedLanguagePerplexity`). URL-encode if your client doesn't.

### Response shapes (the durable contract)

**ExperimentSummary** — items in `/api/experiments`:

```json
{
  "name": "bert-pretrain",
  "state": "completed",
  "gpu_type": "8x A100",
  "started_at": "2026-04-15T10:23:00Z",
  "duration": "12h 34m",
  "outcome": "success",
  "run_count": 3,
  "repo": "github.com/myorg/training",
  "linear_doc_url": "https://linear.app/...",
  "version_count": 3,
  "state_history": [...],
  "submitted_by": "alice"
}
```

**RunSummary** — items in `/api/runs`:

```json
{
  "hash": "a1b2c3d4e5f60708090a0b0c",
  "name": "bert-tiny",
  "experiment": "bert-pretrain",
  "creation_time": 1745321780.5,
  "end_time": 1745367020.3,
  "active": false,
  "duration": "12h 34m",
  "version": "v3",
  "submit_id": "abc-123-def",
  "submitted_by": "alice"
}
```

**MetricResponse** — `/api/runs/{hash}/metrics/{name}`:

```json
{
  "name": "train/loss",
  "steps": [0, 10, 20, ...],
  "values": [4.2, 3.8, 3.5, ...],
  "wall_times": [0.0, 12.3, 24.5, ...]
}
```

`wall_times` is elapsed seconds since first training batch (not since run start) — see [astrolabe-callbacks contract](https://github.com/naston/astrolabe-callbacks/blob/main/docs/contract.md). Omitted if the run wasn't logged with our callback.

**IncludeEntry** — items in `/api/experiments/{name}/includes`:

```json
{
  "name": "bert-tiny",
  "type": "hash",
  "runs": ["a1b2c3d4e5f60708090a0b0c"]
}
```

`type` is one of `experiment` / `hash` / `run-name` / `unknown`. `name` is always the human-readable display string for the chip — even when type=hash, `name` is the resolved Aim run.name, not the input hash.

### Quick example: Streamlit dashboard

```python
import requests, streamlit as st

BASE = "http://nuc.local:43801"
exps = requests.get(f"{BASE}/api/experiments").json()

st.title("My astrolabe view")
for exp in exps:
    with st.expander(f"{exp['name']} — {exp['state']}"):
        st.write(f"Submitter: {exp.get('submitted_by', 'unknown')}")
        runs = requests.get(f"{BASE}/api/experiments/{exp['name']}/runs").json()
        st.dataframe([
            {"hash": r["hash"][:8], "version": r.get("version", "v1"), "loss": r.get("final_loss")}
            for r in runs
        ])
```

### Quick example: Slack daily-digest bot

```python
def daily_digest():
    exps = requests.get(f"{BASE}/api/experiments").json()
    today = [e for e in exps if e["state"] == "completed" and started_today(e["started_at"])]
    return "\n".join(
        f"• {e['name']} (by {e.get('submitted_by', 'unknown')}) — {e['outcome']}"
        for e in today
    )
```

### What this API doesn't give you

- **Auth.** No tokens, no per-user filtering. If your tool is shared, it sees everyone's runs.
- **Real-time push.** Polling only — typical cadence is 5–10s in our React frontend.
- **Non-scalar metrics.** No images, no distributions, no audio. Use Lane 2 for those.
- **Mutation.** Read-only. Run/experiment lifecycle is managed by `astrolabe submit` / `astrolabe stop`, not via API.
- **Pagination.** All list endpoints return the full set. Filter / paginate client-side. Fine through ~hundreds of experiments; if you have thousands, we'd need to add pagination here.

---

## Lane 2: talk to Aim directly

If you want to display non-scalar data (attention maps logged via `aim.Image`, gradient distributions via `aim.Distribution`, sample outputs via `aim.Text`), this dashboard's Go API won't surface them — by design. They're in Aim, queryable from anywhere.

### What's in Aim

Every astrolabe-orchestrated run lives in the Aim repo at `aim://localhost:43800` (gRPC) and `http://localhost:43802` (REST API). Each run carries our tag conventions:

| Tag | Meaning |
|---|---|
| `astrolabe.experiment` | The astrolabe experiment name (matches `/api/experiments`) |
| `astrolabe.version` | Submit version (`v1`, `v2`, …) — increments per re-submit |
| `astrolabe.submit_id` | UUID for this specific submit |
| `astrolabe.user` | Submitter identity (matches `submitted_by`) |
| `astrolabe.status` | `completed` / `failed` / `interrupted` (set on close) |

Use these to group runs across experiments / versions / submitters in your custom UI without re-implementing astrolabe's orchestration concepts.

### Example: pull an image metric out of Aim

```python
from aim import Repo

repo = Repo("aim://localhost:43800")
runs = repo.query_runs("run.astrolabe.experiment == 'bert-pretrain'").iter_runs()
for run in runs:
    for image_seq in run.iter_sequence_info_by_type("images"):
        # image_seq.values: list of aim.Image objects
        latest = image_seq.values[-1]
        save_to_disk(latest.image, f"{run.hash}-attention.png")
```

See [Aim's REST API docs](https://aimstack.readthedocs.io/) and [Python SDK reference](https://aimstack.readthedocs.io/en/latest/refs/sdk.html) for the full surface — runs, sequences, image/distribution/text/audio/figure/log-record types, parameter queries.

### Composing Lane 1 + Lane 2

For a custom UI showing both orchestration metadata and rich metric types:

```python
# Orchestration data → Lane 1 (our Go API)
exp = requests.get(f"{BASE}/api/experiments/bert-pretrain").json()

# For each run, pull rich metrics from Aim → Lane 2
from aim import Repo
repo = Repo("aim://localhost:43800")
for run_summary in exp["runs"]:
    aim_run = repo.get_run(run_summary["hash"])
    images = list(aim_run.iter_sequence_info_by_type("images"))
    distributions = list(aim_run.iter_sequence_info_by_type("distributions"))
    # render alongside the orchestration metadata
```

---

## Lane 3: log from training code without `astrolabe-callbacks`

If your training framework isn't one of the four we ship callbacks for (Composer, Lightning, HF Trainer, raw PyTorch), or you have reasons to roll your own, the contract is small. Read three env vars, set them on your Aim run:

```python
import os, aim

run = aim.Run(
    repo=os.environ.get("ASTROLABE_AIM_URL", "aim://localhost:43800"),
    experiment=os.environ.get("ASTROLABE_EXPERIMENT_NAME"),
)

# AIM_RUN_TAGS format: "key1=val1,key2=val2"
for kv in os.environ.get("AIM_RUN_TAGS", "").split(","):
    if "=" in kv:
        k, v = kv.split("=", 1)
        run[k.strip()] = v.strip()

# … your training loop, run.track(value, name="...", step=...) …

run["astrolabe.status"] = "completed"  # or "failed" on exception
run.close()
```

That's the entire contract. If you do this, every astrolabe feature works:

- ✅ Dashboard groups by experiment + version
- ✅ Dashboard attributes runs to submitter
- ✅ `--include` resolves your runs by hash, experiment, or run-name
- ✅ Reports (Linear / Outline) find your runs and aggregate metrics

If you skip the env-var wiring and just use `aim.Run()` with no astrolabe tags:

- ✅ Orchestration lifecycle (queue, status, stop, doctor) — **all unaffected**
- ✅ `--include <hash>` — works (hash is Aim's primary key, no tags needed)
- ✅ `--include <experiment>` and `--include <run-name>` — work (resolve via Aim's experiment/run.name fields)
- ❌ Dashboard version grouping
- ❌ Dashboard submitter attribution
- ❌ Reports finding runs by experiment

The orchestration layer doesn't care; the visualization layer does.

### What we recommend

If your framework has stable callback hooks, use [`astrolabe-callbacks`](https://github.com/naston/astrolabe-callbacks) — Composer, Lightning, and HF Trainer get framework integrations; raw loops get the `Run` context manager. The library is ~100 lines of boilerplate per framework, and you avoid drift on conventions like the `eval/` → `val/` flip planned for v1.0.

Roll your own only when (a) you're on a framework we don't support, or (b) you have a specific reason to keep dependencies minimal. The 10-line snippet above is the floor.

---

## Conventions to honor

If you're building anything that consumes astrolabe data, lock these in:

### Tag schema (durable across versions)

- `astrolabe.experiment` — string, the astrolabe experiment name
- `astrolabe.version` — string of shape `v<N>` where N is the submit count
- `astrolabe.submit_id` — string, UUID-shaped
- `astrolabe.user` — string, submitter identity (no enforced format; typically a username)
- `astrolabe.status` — enum: `completed` / `failed` / `interrupted`

### Metric namespace

Astrolabe-callbacks routes metrics into two top-level namespaces:

- `train/<name>` — per-batch / per-step training metrics
- `eval/<name>` — during-training validation metrics (renames to `val/<name>` in v1.0 alongside the eval-runs schema; pin against either if you can, or migrate at the same time we do)
- `wall_time` — elapsed training seconds (training-only, eval-paused) — see callback contract

User-named metrics pass through unchanged. `MaskedLanguagePerplexity`, `throughput/samples_per_sec`, custom names — no rewriting.

### Run name resolution order

When users reference runs via `--include`, the resolver tries (in order):

1. **Hash** — strict hex check, ≥16 chars; exact match against Aim run hashes.
2. **Aim experiment name** — exact match; pulls all runs in that experiment.
3. **Run name** — exact match against `run.name`; resolves to the **single most recent** matching run by creation time.
4. **Unknown** — returned as a struck-out chip in the UI rather than silently dropped.

Order matters: a hash-shaped string that doesn't resolve as a hash falls through, but most realistic experiment names won't collide with the hash-like detector.

---

## What's not in scope

Things we deliberately don't surface, and why:

- **Image / distribution / audio rendering in this dashboard.** Aim already handles these well; competing with Aim's UI for the rich types isn't worth the engineering cost or the divergence risk. Use Lane 2 (Aim directly) or Aim's own Web UI.
- **Per-user auth.** Single-tenant trusted-network deployment by design. If you need per-user filtering, gate at the network layer or build it into your custom UI.
- **Push / streaming.** Polling matches our research-team usage. We'll revisit if a real workflow demands it.
- **Mutation API.** Run lifecycle is owned by `astrolabe submit` / `stop` / state-file mutations on the NUC. Exposing mutation through this API would create two paths to the same state, and we don't want the consistency story.

We expect to revisit these around v3, when external usage signals what's actually load-bearing for users we don't already know. If you hit a wall, the cleanest signal is to file an issue describing what you tried to build and where you got stuck — that's the data that decides whether something becomes first-class.
