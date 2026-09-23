#!/usr/bin/env bash
# Preview the bookmarklets page locally, exactly as culm.at renders it.
#
# The site is built by culm-at.github.io, which reads this repo from its sibling
# directory ../bookmarklets. This script clones that renderer next to this repo
# if it is missing, installs its dependencies and starts its dev server, which
# live-reloads when anything under site/ changes.
#
# Usage: ./preview.sh [extra astro dev args, e.g. --port 4322]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
site="$(dirname "$here")/culm-at.github.io"

if [ "$(basename "$here")" != "bookmarklets" ]; then
  echo "This checkout must be named 'bookmarklets' — the renderer looks for ../bookmarklets." >&2
  exit 1
fi

if ! command -v bun >/dev/null; then
  echo "bun is required: https://bun.sh" >&2
  exit 1
fi

if [ ! -d "$site" ]; then
  git clone https://github.com/culm-at/culm-at.github.io.git "$site"
fi

cd "$site"
[ -d node_modules ] || bun install

echo
echo "  Bookmarklets preview: http://localhost:4321/bookmarklets"
echo
exec bun run dev "$@"
