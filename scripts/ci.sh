#!/usr/bin/env bash
# Quick suite by default (typecheck, unit tests, smoke browser tests).
#   --full    every test, on all example models
#   --soak    the soak tests (M5 and M11): 300 rebuilds, 3 million triangles, the large parameter fuzz
#   --record  also rewrite docs/BENCHMARKS.md
# --full --soak runs both.
set -euo pipefail
cd "$(dirname "$0")/.."

full=0
soak=0
for arg in "$@"; do
  case "$arg" in
    --full) full=1 ;;
    --soak) soak=1 ;;
    --record) export CFG_RECORD=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Firefox has no WebGL unless it has a display, so give it a virtual one when possible.
playwright=(npx playwright test)
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then
  playwright=(xvfb-run -a -s "-screen 0 1366x768x24" "${playwright[@]}")
fi

# The soak's unit tests are the quick suite's at their large sizes, and its browser tests are tagged @soak.
if [ "$soak" = "1" ]; then export CFG_SOAK=1; fi

npm run --silent typecheck
if [ "$full" = "1" ]; then
  CFG_FULL=1 npx vitest run
  CFG_FULL=1 "${playwright[@]}"
elif [ "$soak" = "1" ]; then
  npx vitest run
  "${playwright[@]}" --grep @soak
else
  npx vitest run
  "${playwright[@]}" --grep @smoke
fi
echo "CI passed."
if [ -z "${DISPLAY:-}" ] && ! command -v xvfb-run >/dev/null; then
  echo "Firefox WebGL tests were skipped: xvfb is not installed. To run them: WITH_SYSTEM_DEPS=1 scripts/install.sh"
fi
