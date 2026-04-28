"""Hatchling build hook: stage dist/ into astrolabe_dashboard/static/.

The wheel ships the contents of `dist/` (the result of `bun run
build`) under the importable name `astrolabe_dashboard.static`. This
hook copies dist/ into a staging dir at build time so the wheel
includes it without keeping a duplicate of the build output checked
into the source tree.

CI runs `bun run build` before `python -m build`; this hook then
copies the freshly-built dist/.

If dist/ is missing (a developer ran `python -m build` without
building the frontend first), the hook fails loudly so the resulting
wheel doesn't ship empty.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class StaticBundleBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        root = Path(self.root)
        dist = root / "dist"
        if not dist.exists():
            raise FileNotFoundError(
                f"dist/ not found at {dist}. Run `bun run build` before "
                "`python -m build` so the wheel has frontend assets to ship."
            )

        staging = root / "astrolabe_dashboard" / "static"
        # Wipe any prior staging so a stale build doesn't leak into a
        # new wheel. shutil.rmtree tolerates missing paths via missing_ok.
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(dist, staging)

        # Hatchling's wheel target requires every package to have an
        # __init__.py. Drop a minimal one so the package imports
        # cleanly; the actual content is the static dir.
        init = root / "astrolabe_dashboard" / "__init__.py"
        if not init.exists():
            init.write_text(
                '"""Astrolabe dashboard frontend bundle.\n\n'
                "The package contains no Python — `astrolabe_dashboard.static` "
                "holds the built React app served by the Go dashboard binary.\n"
                '"""\n'
            )

        # Hatchling's source tree is set up before this hook fires, so
        # the include-glob in pyproject.toml has already been resolved
        # against an empty astrolabe_dashboard/ tree (we just created
        # it). force_include puts the freshly-staged files into the
        # wheel directly, bypassing the include resolution that's
        # already happened. Pair this with NO include glob in
        # pyproject.toml — the glob produced duplicate-name warnings
        # when both mechanisms picked up the same files.
        build_data["force_include"] = {
            str(staging): "astrolabe_dashboard/static",
            str(init): "astrolabe_dashboard/__init__.py",
        }
