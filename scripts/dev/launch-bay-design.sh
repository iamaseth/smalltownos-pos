#!/usr/bin/env bash
# Safe design-branch launch: never touches SQLite databases, user profiles, or backups.
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
echo "FloPOS Bay design launcher"
branch="$(git branch --show-current)"
if [[ "$branch" != "test-bay-design" && "$branch" != "design/the-bay-exact-html-integration" ]]; then
  echo "ERROR: wrong branch ($branch). Expected test-bay-design." >&2; exit 1
fi
if [[ ! -f frontend/src/components/pos/PosTopbar.tsx ]] || ! grep -q 'SmallTownPOS' frontend/src/components/pos/PosTopbar.tsx; then
  echo "ERROR: Bay design topbar source missing." >&2; exit 1
fi
if pgrep -f '/node_modules/electron/dist/electron' >/dev/null; then
  echo "ERROR: Electron is already running. Close all FloPOS windows and retry." >&2
  pgrep -af '/node_modules/electron/dist/electron' || true
  exit 1
fi
echo "Commit: $(git rev-parse --short HEAD)"
echo "Building fresh frontend..."
npm run build:frontend
page='frontend/.next/server/app/(dashboard)/pos/page.js'
if [[ ! -f "$page" ]] || ! grep -q 'Quick-Tap Grid' "$page"; then
  echo "ERROR: built register page does not contain Quick-Tap Grid." >&2; exit 1
fi
if ! grep -R -q --include='*.js' 'Quick-Tap Grid' frontend/.next/static/chunks; then
  echo "ERROR: browser JavaScript does not contain Quick-Tap Grid." >&2; exit 1
fi
echo "Frontend verified. Building Electron..."
npm run build
echo "Starting verified build (commit $(git rev-parse --short HEAD))"
./node_modules/.bin/electron .
