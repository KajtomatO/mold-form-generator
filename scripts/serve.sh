#!/usr/bin/env bash
# Builds the app and serves it to the local network on port 5173.
set -euo pipefail
cd "$(dirname "$0")/.."
npx vite build
exec npx vite preview --host 0.0.0.0 --port 5173 --strictPort
