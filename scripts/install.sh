#!/usr/bin/env bash
# Installs everything the project needs. Safe to run repeatedly.
#
# Without any option it only writes to node_modules and to ~/.cache, and never needs root.
# That covers Chromium, and Firefox without WebGL.
#
# Set WITH_SYSTEM_DEPS=1 to also install the system libraries the browsers need, plus xvfb,
# which is the virtual display Firefox needs for WebGL. That runs apt-get through sudo.
set -euo pipefail
cd "$(dirname "$0")/.."

node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' || {
  echo "Node 24 or newer is required, found $(node --version 2>/dev/null || echo none)." >&2
  exit 1
}

# npm ci deletes node_modules and installs every package again, which breaks tests or a server that
# are running, so it runs only when the lockfile's packages differ from those npm recorded at the last
# install: not for a change of the project's own version alone. npm leaves out of its record the
# optional packages for other platforms, which the lockfile lists.
if ! node -e '
  const fs = require("fs");
  const want = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages;
  const have = JSON.parse(fs.readFileSync("node_modules/.package-lock.json", "utf8")).packages;
  const same = Object.keys(have).every((path) => path in want) && Object.entries(want).every(([path, entry]) =>
    path === "" || (path in have ? JSON.stringify(entry) === JSON.stringify(have[path]) : entry.optional === true));
  process.exit(same ? 0 : 1);
' 2>/dev/null; then
  npm ci --no-audit --no-fund
fi

if [ "${WITH_SYSTEM_DEPS:-0}" = "1" ]; then
  npx playwright install-deps chromium firefox
  sudo apt-get install -y xvfb
fi

npx playwright install chromium firefox

# Firefox needs GTK. Without root, unpack the packages into the user cache, and the
# browser tests point Firefox there. Nothing on the system changes.
if ! ldconfig -p | grep -q 'libgtk-3\.so\.0'; then
  libs="$HOME/.cache/casting-form-generator/firefox-libs"
  if [ ! -d "$libs/usr" ]; then
    debs="$(mktemp -d)"
    if (cd "$debs" && apt-get download libgtk-3-0t64 libpangocairo-1.0-0 libcairo-gobject2 \
        libepoxy0 libpangoft2-1.0-0 libwayland-cursor0 libwayland-egl1); then
      mkdir -p "$libs"
      for deb in "$debs"/*.deb; do dpkg -x "$deb" "$libs"; done
    else
      echo "Could not download GTK, so browser tests will skip Firefox." >&2
    fi
    rm -rf "$debs"
  fi
fi

if ! command -v xvfb-run >/dev/null; then
  echo "xvfb is not installed, so Firefox WebGL tests will be skipped."
  echo "To run them: WITH_SYSTEM_DEPS=1 scripts/install.sh"
fi

echo "Installed. Run scripts/ci.sh to test, scripts/serve.sh to start the app."
