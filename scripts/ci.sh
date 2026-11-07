#!/usr/bin/env bash
# Quick suite by default (typecheck, unit tests, smoke browser tests).
#   --full    every test, on all example models
#   --record  also rewrite docs/BENCHMARKS.md
set -euo pipefail
cd "$(dirname "$0")/.."

full=0
for arg in "$@"; do
  case "$arg" in
    --full) full=1 ;;
    --record) export CFG_RECORD=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Firefox has no WebGL unless it has a display, so give it a virtual one when possible.
playwright=(npx playwright test)
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then
  playwright=(xvfb-run -a -s "-screen 0 1366x768x24" "${playwright[@]}")
fi

npm run --silent typecheck
if [ "$full" = "1" ]; then
  CFG_FULL=1 npx vitest run
  CFG_FULL=1 "${playwright[@]}"
else
  npx vitest run
  "${playwright[@]}" --grep @smoke
fi
echo "CI passed."
if [ -z "${DISPLAY:-}" ] && ! command -v xvfb-run >/dev/null; then
  echo "Firefox WebGL tests were skipped: xvfb is not installed. To run them: WITH_SYSTEM_DEPS=1 scripts/install.sh"
fi
