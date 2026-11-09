# Running the server

This is for whoever runs the app on the local network. The app runs entirely in each visitor's browser: the server only hands out the built files. Nothing is uploaded to it, and it keeps no data.

## What you need

- **On the server:** Linux, Node 24 or newer, and npm. The browsers for the tests come with `scripts/install.sh`, below. Building takes about half a GB of memory for a few seconds, and serving takes little.
- **On each computer that uses the app:** a recent browser with WebGL2 and module workers. It is tested in Chromium 153 and Firefox 155 on the server, and used in Firefox 158 on Windows. Other browsers are untested.
- **Memory in the browser:** an ordinary model, up to a few hundred thousand triangles, needs no more than any web app. A very large one needs much more: while it previewed and exported the 3 million triangle test model (a 150 MB STL), the browser took about 2.3 to 2.5 GB (2.1 to 2.3 GiB) in Chromium and 2.9 to 3.0 GB (2.7 to 2.8 GiB) in Firefox, counting each page its processes share once. Adding up each process's memory, as a system monitor does, counts shared pages more than once and reads up to 3.3 GB in Firefox. So for models of that size, leave about 3.5 GB of memory free on the computer running the browser.

## Install

```sh
scripts/install.sh
```

It checks for Node 24, runs `npm ci` when the packages in `package-lock.json` differ from what is installed, and downloads Chromium and Firefox for the browser tests into `~/.cache`. Run like this, it never needs root, and it is safe to run again. `npm ci` deletes `node_modules` and installs every package again, from npm's cache or from the registry, so it can need the network, and it must not run while the tests or the server are running. A change of the app's own version number alone installs nothing.

Firefox needs a display for its WebGL tests. To install the system libraries the browsers need, and `xvfb`, a virtual display, run it once as:

```sh
WITH_SYSTEM_DEPS=1 scripts/install.sh
```

That is the only part that uses `sudo` (through `apt-get`). Without it, where the system lacks Firefox's GTK libraries, the script unpacks them into `~/.cache` instead, with no root, and without `xvfb` the Firefox WebGL tests skip themselves; `scripts/ci.sh` says so.

## Serve

```sh
scripts/serve.sh
```

It builds the app into `dist/`, then serves `dist/` on port 5173 on every network address of the server. Browse to `http://192.168.0.153:5173` (or the server's own address). It refuses to start if port 5173 is already taken, rather than pick another port. Leave it running in a terminal, or start it in the background:

```sh
nohup scripts/serve.sh > serve.log 2>&1 &
```

If another computer cannot reach the page, check that the server's firewall lets port 5173 in.

## Update

New versions are made in this checkout and arrive as commits in it. It has no git remote, so there is nothing to pull; a copy cloned from it elsewhere gets them with `git pull`. After new commits, with the tests stopped:

```sh
scripts/install.sh
```

Then stop the running server (Ctrl+C in its terminal, or end its process) and run `scripts/serve.sh` again: it builds the new version into `dist/` before it serves it. Reload the page in the browser.

The server serves whatever `dist/` holds, reading it from disk on every request, and only `scripts/serve.sh` builds into it. So until it is restarted it serves the old build, and nothing else should build into `dist/` while it runs: a page already open would lose files it still loads, such as the workers of the next export.

## Serving `dist/` from another web server

The build is a plain folder of static files, so any static web server can serve it instead of `scripts/serve.sh`. Build a copy into a folder of its own, beside the checkout, so `dist/` and the server on 5173 are left alone:

```sh
npx vite build --outDir ../cfg-static --emptyOutDir
```

Then:

- **Serve the folder at the root** of a host and port, such as `http://192.168.0.153:8080/`. The pages load their files from `/assets/...`, so the app does not work from a subfolder such as `/mold/`.
- **Module workers:** the app's geometry runs in module workers, which the browser only starts from files sent as JavaScript. Check that `.js` files are sent as `text/javascript` (or `application/javascript`).
- **WebAssembly:** send `.wasm` files as `application/wasm`, the right type. The app reads `manifold.wasm` as plain bytes, so it also works with a server that sends a generic type.
- **No special headers** are needed: the app uses no SharedArrayBuffer, so it needs no cross-origin isolation headers.

This was checked with Python's built-in server (`python3 -m http.server 8080 --directory ../cfg-static`, on a spare port), serving a build of its own, in Chromium: it sends `.wasm` as `application/wasm` and `.js` as `text/javascript`, `diag.html`'s worker loaded Manifold and answered, and the app opened. With `.wasm` sent as `application/octet-stream` it worked the same. Try another server on a spare port first, and leave the one on 5173 alone while you do.

## Plain http is enough

The app is served over plain `http`, which on a network address is not a secure context. Browsers keep some features for secure contexts only, and the app uses none of them: no SharedArrayBuffer or WebAssembly threads, no WebGPU, no OPFS, no service workers, no Web Crypto (the SHA-256 of project files is computed in plain JavaScript), no `showSaveFilePicker` and no async clipboard. Files are saved by a Blob and a download link. A unit test refuses any of those APIs in the source, and the browser tests run against the network address, not `localhost`, which would count as secure and hide such a problem.

## Saving files over plain http

The user confirmed on 2026-11-07 that Firefox 158 saves STL and ZIP files from `diag.html` without a problem. Chrome has not been tried. Chromium's source suggests it may ask to keep or discard these files on an http address, so if you use Chrome, check `diag.html` first (Advanced, Developer pages, Browser check, in the app).

### If Chrome blocks the download

Chrome may count a file saved from a plain-http network address as an insecure download. Then, from the simplest:

- **Choose Keep** where Chrome asks, in its download bubble or its list of downloads.
- **Use Firefox,** which saves the files without asking.
- **Tunnel to localhost,** which Chrome counts as a secure address. On the computer with the browser, with an SSH login to the server, run `ssh -N -L 5173:127.0.0.1:5173 user@192.168.0.153`, leave it open, and browse to `http://localhost:5173`. Nothing changes on the server: `scripts/serve.sh` listens on every address, its own `127.0.0.1` included. Windows 10 and 11 have `ssh` in their command prompt.
- **Tell Chrome the address is safe:** open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.0.153:5173`, set it to Enabled, and relaunch Chrome. This holds only in that browser and only for that address.

## Client measured so far

From `bench.html` on 2026-11-07, on the user's machine: Firefox 158 on Windows, 16 logical cores.

| Test | User's Firefox (ms) | Server Chromium (ms) | Server is slower by |
|---|---|---|---|
| js: splat 512x512 r=14 | 284 | 536.3 | 1.9x |
| wasm: sphere minus sphere, 128 segments | 17 | 29.4 | 1.7x |
| wasm: sphere minus sphere, 256 segments | 56 | 98.6 | 1.8x |
| wasm: sphere minus sphere, 512 segments | 218 | 391 | 1.8x |

Manifold's WASM booted in 9 ms. Firefox does not report device memory, so the app can't read how much RAM the client has. It has to adapt from measured stage timings instead.

## Running the tests

```sh
scripts/ci.sh                  # the quick suite: about 11 minutes
scripts/ci.sh --full           # everything, on all seven example models: about 23 minutes
scripts/ci.sh --soak           # the long runs: about 35 minutes
scripts/ci.sh --full --record  # also rewrites docs/BENCHMARKS.md
```

- **The quick suite** (`scripts/ci.sh`) runs the type check, the unit tests in Node (Vitest, with 2 workers), and the browser smoke tests in Chromium, on the development server and on the build, and in Firefox on the build.
- **`scripts/ci.sh --full`** runs every test, the unit tests and the browser tests on all seven example models. Run it before each commit.
- **`scripts/ci.sh --soak`** runs 300 rebuilds on two models, the 3 million triangle STL in both browsers, and the large parameter fuzz. It needs about 3.5 GB of free memory for the browser, as above, and is run before a release rather than before every commit. Its 150 MB STL is made by the test in the system's temporary folder and deleted afterwards.
- **`CFG_SHOTS=1`** adds the review screenshots of the app, written to `test-results/shots`, or to the folder `CFG_SHOTS_DIR` names: `CFG_SHOTS=1 npx playwright test e2e/shots.spec.ts` takes them alone, and `CFG_SHOTS=1 scripts/ci.sh --full` with everything else. The quick suite runs smoke tests only, so it takes none.
- **Firefox needs a display** for its WebGL tests. When `DISPLAY` is not set and `xvfb` is installed, `scripts/ci.sh` starts the tests under `xvfb-run`. With a virtual display already running, point the tests at it instead, for example `DISPLAY=:97 scripts/ci.sh --full`. Without either, Firefox's WebGL tests skip themselves and `scripts/ci.sh` says so at the end.

The browser tests build the app into `dist-ci/` and serve it on ports 5183 (development server) and 5184 (the build), on the network address `192.168.0.153`. Set `CFG_LAN_IP` if the server's address is another. They never touch `dist/` or port 5173, so they can run while the app is being served.
