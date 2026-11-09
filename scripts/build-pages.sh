#!/usr/bin/env bash
# Builds the GitHub Pages site: a release at <out-dir>/ and, unless the beta ref is "-", the beta site at
# <out-dir>/beta/, each stamped with its channel, commit and the commit's date. .github/workflows/pages.yml
# runs this same script, and docs/RELEASING.md says which refs it is given.
#
#   scripts/build-pages.sh <stable-ref> <beta-ref or -> <out-dir>
#
# Each ref is checked out in a temporary git worktree outside the repository, which is removed afterwards,
# also when a step fails. Nothing is written into dist/, dist-ci/ or the working tree: the out-dir must be
# a new or empty folder outside the repository. If the release fails to build, nothing is built. If only
# the beta fails, the release is still built, beta/ holds a page that says so, and the script says why and
# exits 0, so a broken beta never keeps a release from being published.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: scripts/build-pages.sh <stable-ref> <beta-ref or -> <out-dir>" >&2
  exit 2
fi
stable_ref=$1
beta_ref=$2
repo=$(cd "$(dirname "$0")/.." && pwd -P)
out=$(realpath -m "$3")

case "$out/" in
  "$repo/"*) echo "The output folder must be outside the repository, not $out." >&2; exit 2 ;;
esac
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
  echo "The output folder must be new or empty, so nothing old is published with the site: $out" >&2
  exit 2
fi

# A commit for each ref, or a clear stop before anything is built.
commit_of() {
  git -C "$repo" rev-parse --verify --quiet "$1^{commit}" || { echo "No commit is named $1 in $repo." >&2; return 1; }
}
# The app's version is package.json's alone (vite.config.ts reads it), so this is what the page will show.
version_at() {
  git -C "$repo" show "$1:package.json" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).version));'
}

stable_commit=$(commit_of "$stable_ref")
stable_version=$(version_at "$stable_commit")
# A release tag must be the version its package.json says, so the root never shows a number it is not.
tag=${stable_ref#refs/tags/}
if [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] && git -C "$repo" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  if [ "${BASH_REMATCH[1]}" != "$stable_version" ]; then
    echo "Tag $tag does not match package.json at that tag, which says $stable_version. Tag the version package.json has." >&2
    exit 1
  fi
fi
if [ "$beta_ref" != "-" ]; then
  beta_commit=$(commit_of "$beta_ref")
  beta_version=$(version_at "$beta_commit")
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/cfg-pages.XXXXXX")
worktrees=()
cleanup() {
  for tree in "${worktrees[@]}"; do git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1 || true; done
  rm -rf "$tmp"
  git -C "$repo" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Whether two lockfiles pin the same packages. The root entry carries the app's own name and version,
# which differ between the release and beta after every release, and change nothing that is installed.
same_packages() {
  node -e '
    const { readFileSync } = require("node:fs");
    const read = (path) => { const lock = JSON.parse(readFileSync(path, "utf8")); delete lock.name; delete lock.version; delete lock.packages?.[""]?.name; delete lock.packages?.[""]?.version; return JSON.stringify(lock); };
    process.exit(read(process.argv[1]) === read(process.argv[2]) ? 0 : 1);
  ' "$1" "$2"
}

# build <commit> <channel> <dest>. Every step checks its own result, as the beta build runs where a failure
# must not stop the script, and bash ignores set -e inside a function called from an if.
build() {
  local commit=$1 channel=$2 dest=$3
  local short date tree=$tmp/$channel/tree vite
  short=$(git -C "$repo" rev-parse --short=7 "$commit") || return 1
  # The commit's date, not the time of the build: the same commit then builds the same files with the same
  # names, so rebuilding the release for a push to beta never takes away a worker an open page still loads.
  date=$(git -C "$repo" show -s --format=%cI "$commit") || return 1
  mkdir -p "$tmp/$channel" || return 1
  worktrees+=("$tree")
  git -C "$repo" worktree add --quiet --detach "$tree" "$commit" || return 1
  if [ -d "$repo/node_modules" ] && same_packages "$tree/package-lock.json" "$repo/package-lock.json"; then
    echo "The $channel site uses this checkout's packages, as its package-lock.json pins the same ones."
    # Node also looks for packages in the folder above the tree, where git never sees the link.
    ln -s "$repo/node_modules" "$tmp/$channel/node_modules" || return 1
    vite=$tmp/$channel/node_modules/.bin/vite
  else
    echo "The $channel site pins other packages than this checkout, so npm ci installs them."
    (cd "$tree" && npm ci --no-audit --no-fund) || return 1
    vite=$tree/node_modules/.bin/vite
  fi
  # The runner loads the config without writing a bundled copy of it into node_modules.
  (cd "$tree" && CFG_CHANNEL=$channel CFG_COMMIT=$short CFG_BUILD_DATE=$date "$vite" build --configLoader runner --logLevel warn --outDir "$dest" --emptyOutDir) || return 1
  [ -f "$dest/index.html" ] || { echo "The $channel build made no index.html." >&2; return 1; }
  echo "Built the $channel site from $short into $dest."
}

mkdir -p "$out"
# The stable site first: its build empties the folder that beta/ goes into.
if ! build "$stable_commit" stable "$out"; then
  echo "The release $stable_ref did not build, so nothing was built." >&2
  exit 1
fi
summary="$stable_version at the root"
if [ "$beta_ref" != "-" ]; then
  if build "$beta_commit" beta "$out/beta"; then
    summary="$summary, $beta_version beta at beta/"
  else
    beta_short=$(git -C "$repo" rev-parse --short=7 "$beta_commit")
    rm -rf "$out/beta"
    mkdir -p "$out/beta"
    # A page of its own, so /beta/ says what happened instead of a 404, and search engines leave it out.
    cat > "$out/beta/index.html" <<EOF
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <title>Beta not available</title>
  </head>
  <body style="font: 16px/1.5 system-ui, sans-serif; max-width: 40em; margin: 2em auto; padding: 0 1em">
    <h1>The beta version is not available</h1>
    <p>The newest beta change (commit $beta_short) could not be built, so there is no beta version to show right now.</p>
    <p><a href="../">Open the released version</a>.</p>
  </body>
</html>
EOF
    # The GitHub workflow shows a line starting ::error:: on the run's page, also when the run succeeds.
    echo "::error::The beta site did not build from $beta_ref ($beta_short), so /beta/ says it is not available. The release was built and is published."
    summary="$summary, and at beta/ a page saying the beta did not build"
  fi
fi
# A workflow's deploy skips Jekyll anyway, but a copy served from a branch would lose the files starting with _.
touch "$out/.nojekyll"
echo "The site is in $out: $summary."
