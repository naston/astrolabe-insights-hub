# astrolabe-insights-hub

The dashboard for [astrolabe](https://github.com/naston/astrolabe). A
Go API server (`server/`) backing a React + ECharts frontend (`src/`),
shipped as a single self-contained binary plus a static asset bundle.

## What this repo ships

On every `vX.Y.Z` tag push, CI builds and attaches three artifacts to
the GitHub release:

- `astrolabe-dashboard-vX.Y.Z-linux-amd64.tar.gz` — the Go binary
- `astrolabe_dashboard-X.Y.Z-py3-none-any.whl` — Python wheel
  containing the static frontend bundle (no Python code; just a
  bundled directory of HTML/JS/CSS)
- `SHA256SUMS` — checksums for both

[`astrolabe admin dashboard install`](https://github.com/naston/astrolabe/blob/main/docs/Installation.md#17-install-the-dashboard-v150)
on a NUC consumes these to deploy the dashboard as a system service
without any local build step.

## Local development

Frontend:

```bash
bun install
bun run dev      # http://localhost:5173, talks to a running NUC API
```

Go API:

```bash
cd server
make run         # http://localhost:43801, expects Aim on :43802
```

Tests:

```bash
cd server && make test
```

## Releases

Tag → push → CI attaches artifacts:

```bash
git tag v0.4.0
git push origin v0.4.0
```

The astrolabe repo's `astrolabe admin dashboard upgrade` resolves the
latest tag from this repo automatically; pin a specific version with
`--version=v0.4.0`.
