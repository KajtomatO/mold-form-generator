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

npm run --silent typecheck
if [ "$full" = "1" ]; then
  CFG_FULL=1 npx vitest run
  CFG_FULL=1 npx playwright test
else
  npx vitest run
  npx playwright test --grep @smoke
fi
echo "CI passed."
