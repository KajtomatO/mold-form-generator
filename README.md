# Casting Form Generator

A browser app that takes an STL and generates a printable base and cover for pouring a silicone casting mold, using as little silicone as a demoldable shape allows. All geometry runs in your browser, and the server only hands out files.

- `docs/REQUIREMENTS.md`: requirements and decisions
- `docs/PLAN.md`: how it is built, milestone by milestone

## Run it

```sh
scripts/install.sh   # Node 24+ required; no root needed
scripts/serve.sh     # then browse to http://<server-ip>:5173
```

## Check your printer

The app's Fit test button, and `http://<server-ip>:5173/diag.html`, download fit-test pieces: small molds with the real joint, for finding the clearances that suit your printer and for a leak test. The README in the ZIP says how to read the result. Both build the groove pairs at the taper clearance set, so set the one you find and download again.

Port 5173 serves the last build, so a server started before you updated has an old page without this button. Stop it and run `scripts/serve.sh` again, which rebuilds first.

## Use it

`http://<server-ip>:5173/` is the app. Drop an STL on the view, or open one, and check the base face it found: the ranked candidates are listed with the best one chosen, and you can pick another face on the model. The preview follows every change: the silicone surface and the box first, then the real cover and base. The status strip shows the size, the box, the silicone and how long the last rebuild took.

Export ZIP, at the foot of the sidebar, builds the mold at full detail, measures the silicone clearance on the finished parts, and saves a ZIP named after the model: the cover, the base, the funnel, your model turned onto its base face (in glue mode), a README.txt on printing, pouring and demolding, and report.json and project.json with every number and setting. The buttons under it save the cover, the base or the funnel alone, or the fit-test pieces with your clearances; an option puts those pieces in the ZIP as well. A bar shows each step, with Cancel. After an export the status strip shows the clearance it measured, for as long as nothing changes the mold.

The Demold report, after Grid, estimates from the model's shape how the silicone comes off it: pulled out while the silicone stays in the cover, out of the cover first so it can stretch, or cut, with the places it holds and where to cut each one, which Show marks in the view. It lists where air may stay, such as a pocket under the model that no vent in the top reaches. Cover & joint says how much tape holds the cover down against the liquid silicone, and Diagnostics warns of a part larger than the bed and estimates the plastic. README.txt in the ZIP carries all of it.

`pipeline.html`, `diag.html` and `bench.html` are linked from the Advanced section: a bare page for the worker pipeline, the browser check with the fit-test download, and the benchmark.

## Test it

```sh
scripts/ci.sh         # typecheck, unit tests, browser smoke tests
scripts/ci.sh --full  # everything, on all example models
scripts/ci.sh --full --record  # also rewrites docs/BENCHMARKS.md
```

Browser tests run against the LAN address on purpose, because `127.0.0.1` counts as a secure context and would hide problems that only appear over plain http. Set `CFG_LAN_IP` if this machine's address is not `192.168.0.153`.

They run in Chromium and Firefox. `CFG_SHOTS=1` adds the review screenshots of the app, written to `test-results/shots` or to `CFG_SHOTS_DIR`. Firefox has no WebGL without a display, so its WebGL tests skip themselves unless `xvfb` is installed, and `scripts/ci.sh` says so when that happens. `WITH_SYSTEM_DEPS=1 scripts/install.sh` installs it, using sudo.
