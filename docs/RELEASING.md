# Releasing

This is for the owner of the repository. Mold Form Generator is published on GitHub Pages at two addresses:

- **https://kajtomato.github.io/mold-form-generator/** shows the newest release. Most people should only ever see this one.
- **https://kajtomato.github.io/mold-form-generator/beta/** shows the newest work, for trying it before it is released.

Both are built and published by `.github/workflows/pages.yml`, which runs `scripts/build-pages.sh`. Nothing is uploaded to a server of yours: GitHub serves the files, and the app runs in each visitor's browser as it does on the LAN server.

On 2026-11-09 you renamed the app "mold-from-generator", which these files read as Mold Form Generator, `mold-form-generator`. Confirm the spelling before the one-time setup below: the repository's name is the address, and it is hard to change once people use it.

## The two branches

- **`main` holds releases only.** Every commit that reaches `main` is a release, and each release is tagged `vX.Y.Z` on `main`, such as `v0.1.0`.
- **`beta` is where the work goes.** Every push to `beta` publishes it at `/beta/` within a few minutes.

The release address shows the newest tag `vX.Y.Z` that is on `main`, the highest version number. A tag on any other branch is never published there, and neither is a commit on `main` without a tag.

## The version number

The version is written in one place, `"version"` in `package.json`, and `package-lock.json` repeats it. One command sets both, without committing or tagging anything:

```sh
npm version 0.2.0 --no-git-tag-version
```

The build reads the version from `package.json`. The page shows it in its header, after the name. A release shows just its number, such as `v0.1.0`. Every other build adds where it comes from and its commit: the beta site shows an amber BETA label and `v0.2.0-beta+a1b2c3d`, and the LAN server and the tests show `v0.1.0-local+a1b2c3d` (with `-dirty` when the checkout had uncommitted changes). Hover over the version to read what kind of build it is, the date of its code and its commit. The same version text goes into every export ZIP's `README.txt`, `report.json` and `project.json`, so a mold made on beta can be traced to the commit that made it. The STL files carry no version, so the same mold gives the same STL bytes from every build.

Public versions started at 0.1.0. The internal builds before it were numbered 0.2.0, 0.3.0, 1.0.0 and 1.0.1, so those numbers are higher but older. The app never compares version numbers: a project file says what it holds by its format number.

## How to release

After each release, `beta` already carries the next version (step 5), such as 0.2.0, so its site shows `0.2.0-beta+...`.

1. On `beta`, check that `package.json` says the version you are releasing. To release another number, set it and commit:

   ```sh
   git checkout beta
   npm version 0.2.0 --no-git-tag-version
   git commit -am "Version 0.2.0"
   ```

2. Run `scripts/ci.sh --full` on the server and let it finish. It must end with "CI passed." It runs after the version is set, so it checks the very commit you release.
3. Merge `beta` into `main`:

   ```sh
   git checkout main
   git merge --ff-only beta
   ```

   If git answers "Not possible to fast-forward", `main` has a commit that `beta` lacks, such as a quick fix: merge `main` into `beta` first (below), run step 2 again, then this step.

4. Tag the release on `main` with the version `package.json` says, and push both in one command:

   ```sh
   git tag v0.2.0
   git push origin main v0.2.0
   ```

   The tag push starts the workflow, which publishes `v0.2.0` at the release address. If the tag is not the version `package.json` says at that commit, the build stops with a message and nothing is published. If the tag is not of the form `vX.Y.Z`, not on `main`, or lower than a release already on `main`, the run turns red with the reason and the address keeps the release it had.

5. Go back to `beta`, set the next version, and push, so the beta site shows `0.3.0-beta+...` from now on:

   ```sh
   git checkout beta
   npm version 0.3.0 --no-git-tag-version
   git commit -am "Start 0.3.0"
   git push origin beta
   ```

## Merging main back into beta

After a quick fix on `main`, `beta` needs it too, and the next release's `git merge --ff-only beta` needs `beta` to hold everything `main` has:

```sh
git checkout beta
git merge main
```

The version always conflicts, as `beta` has the next version (such as 0.3.0) and `main` the fix's (such as 0.2.1). Keep `beta`'s:

```sh
git checkout --ours package.json package-lock.json
git add package.json package-lock.json
git status
```

If `git status` lists any other file under "Unmerged paths" or "both modified", the fix and the work on `beta` changed the same lines: settle those files by hand, then `git add` them. Then:

```sh
git commit --no-edit
git push origin beta
```

`git checkout --ours` keeps `beta`'s whole `package.json` and `package-lock.json`. If the fix on `main` also added or updated a package, make that change on `beta` again.

## A quick fix on main

When a release needs a fix that cannot wait for the next one, for example 0.2.1 for 0.2.0:

```sh
git checkout main
# make the fix and commit it, then:
npm version 0.2.1 --no-git-tag-version
git commit -am "Version 0.2.1"
scripts/ci.sh --full
git tag v0.2.1
git push origin main v0.2.1
```

Then merge `main` back into `beta`, as above.

## Taking a bad release down

Tag a fixed version: the release address always shows the newest tag on `main`, so pushing `v0.2.1` replaces `v0.2.0` within minutes.

If the fix takes time, release the code of the last good release again under a new number. For example, with v0.1.0 good and v0.2.0 bad:

```sh
git checkout main
git restore --source=v0.1.0 --staged --worktree -- .
npm version 0.2.1 --no-git-tag-version
git commit -am "Version 0.2.1: the code of v0.1.0 again"
scripts/install.sh
scripts/ci.sh --full
git tag v0.2.1
git push origin main v0.2.1
```

`git restore` takes every file back to v0.1.0, and `scripts/install.sh` installs that release's packages in case they changed. Then record on `beta` that it has seen this commit, while keeping its own code, which still holds the work the bad release came from, to be fixed there:

```sh
git checkout beta
git merge -s ours --no-edit main
scripts/install.sh
git push origin beta
```

Without that merge the next `git merge --ff-only beta` stops with "Not possible to fast-forward". Do not use `-s ours` after a quick fix: it would leave the fix out of `beta`.

Deleting the bad tag alone (`git push origin :refs/tags/v0.2.0`) publishes nothing, as no workflow runs for a deleted tag. Run the workflow by hand afterwards (Actions, Pages, Run workflow) and it publishes the newest tag left on `main`.

## When a build fails

- **The release does not build:** nothing is published, the run is red, and both addresses keep what they had. Every later run fails the same way until a release that builds is tagged: fix it on `main` as a quick fix.
- **Only the beta does not build:** the release is still published, and `/beta/` shows a page saying the beta version is not available, with a link to the release. The run's page on GitHub shows the error. Fix `beta` and push again.
- **A pushed tag is not the one published:** the run is red and says why, as in step 4 above.

## One-time setup on GitHub

Do these in this order, and only after the decisions in the next section. Runs that start before step 4 is done fail at "Deploy"; they can be ignored.

1. On GitHub, create an empty repository named `mold-form-generator` under your account (KajtomatO), with no README, licence or `.gitignore`, so the first push is this history as it is.
2. Add it as the remote and push `main` alone. A push to `main` starts no workflow:

   ```sh
   git remote add origin git@github.com:KajtomatO/mold-form-generator.git
   git push -u origin main
   ```

3. **Settings, Pages, Build and deployment, Source: GitHub Actions.**
4. **Settings, Environments, `github-pages`** (if it is not listed, choose New environment and name it `github-pages`), **Deployment branches and tags:** choose "Selected branches and tags", keep `main`, and add the branch `beta` and the tag pattern `v*`. Without them GitHub refuses to deploy a release tag or a push to `beta`.
5. Create the branch `beta` and the first release tag on `main`, and push them:

   ```sh
   git branch beta
   git tag v0.1.0
   git push origin beta v0.1.0
   ```

   This starts two runs, one for `beta` and one for the tag. Each publishes both addresses.

6. Start the next version on `beta`, so its site no longer shows `0.1.0-beta+...`, which would read as older than the release:

   ```sh
   git checkout beta
   npm version 0.2.0 --no-git-tag-version
   git commit -am "Start 0.2.0"
   git push -u origin beta
   ```

7. Open both addresses: the release shows `v0.1.0` and no BETA label, `/beta/` shows BETA and `v0.2.0-beta+...` with a link back, and on each a model loads and exports (U8 in `docs/REQUIREMENTS.md`).

## Before the first push: the name, the source and the example models

Not decided yet, and yours to decide just before the first push:

- **The name:** whether Mold Form Generator, `mold-form-generator`, is the spelling you meant.
- **The source and the example models:** whether the source repository is public, and what happens to the third-party example models in `examples/`, which are also in the git history. They belong to their authors, and only `chick_mc.stl` is yours. Two ways stay open:
  - **Public without the models:** the repository is public, and the third-party models are taken out of it, history included, before the push. Some tests read them, so those would then need models that may be shared.
  - **Site only:** the source stays private and only the built site is public. This needs work that is not built yet. `pages.yml` publishes to its own repository's Pages, and a private repository on a free plan has none. The site would have to be pushed to a second, public repository instead, with a token allowed to write to it and a different last step in the workflow. Ask for that before the first push if you choose it.

The site itself never contains the example models: `scripts/build-pages.sh` builds the app's pages and nothing from `examples/`.

## No tests on GitHub yet

The workflow only builds and publishes. The tests run on the server with `scripts/ci.sh`, as before, because many of them read the example models, whose future is the question above. Once that is settled, the tests can run on GitHub too.

## What visitors see

- At the release address: the app as released, with its version in the header. Search engines may list it.
- At `/beta/`: the newest work, marked BETA in the header, with the version and commit, and a "Stable version" link back to the release. Its pages ask search engines not to list them (`noindex`).
- Both are served over HTTPS, so browsers save the STL and ZIP files without the warning Chrome may give for downloads over plain http on the LAN server.
- Both addresses share the browser's storage, as they are the same site to the browser, so a light or dark theme chosen on one holds on the other.
- A push to `beta` publishes the release again too, built from the same commit with the same date, so its files keep their names and a page already open on the release goes on working. A page open on `/beta/` while a new beta is published may fail to start its next export or save: reload it.

## Building the site yourself

`scripts/build-pages.sh <release-ref> <beta-ref or -> <out-dir>` builds what the workflow builds, from any two commits, into a new or empty folder outside the repository. For example:

```sh
scripts/build-pages.sh v0.1.0 beta /tmp/site
```

It checks each commit out in a temporary git worktree outside the repository, removed afterwards, so the working tree, `dist/` and `dist-ci/` are left alone and the LAN server keeps running. It uses this checkout's `node_modules` when a commit's `package-lock.json` pins the same packages, whatever version of the app it names, and otherwise runs `npm ci` for it. To look at the result, serve the folder at `/mold-form-generator/` on a spare port; `e2e/pages.spec.ts` does exactly that.
