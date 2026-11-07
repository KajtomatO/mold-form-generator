#!/usr/bin/env bash
# Installs everything the project needs. Safe to run repeatedly.
#
# Without any option it only writes to node_modules and to ~/.cache/ms-playwright,
# and never needs root. Set WITH_SYSTEM_DEPS=1 to also install the system libraries
# Chromium needs (runs apt-get through sudo). This server does not need them.
set -euo pipefail
cd "$(dirname "$0")/.."

node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' || {
  echo "Node 24 or newer is required, found $(node --version 2>/dev/null || echo none)." >&2
  exit 1
}

npm ci --no-audit --no-fund

if [ "${WITH_SYSTEM_DEPS:-0}" = "1" ]; then
  npx playwright install-deps chromium
fi

npx playwright install chromium

echo "Installed. Run scripts/ci.sh to test, scripts/serve.sh to start the app."
