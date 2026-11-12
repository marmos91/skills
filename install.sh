#!/usr/bin/env bash
# marmos91/skills install for a dev clone: link every skill and CLI to this working tree.
# It is the npm installer with --link, so the CLIs come from "bin" in package.json.
# Idempotent; re-run after pulling. --rm removes what it installed. Needs node.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--rm" ]; then exec node "$REPO/bin/skills.mjs" uninstall; fi
exec node "$REPO/bin/skills.mjs" install --link
