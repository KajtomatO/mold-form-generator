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

`http://<server-ip>:5173/diag.html` has a button that downloads fit-test pieces: small molds with the real joint, for finding the clearances that suit your printer and for a leak test. The README in the ZIP says how to read the result, and the page rebuilds the groove pairs at the taper clearance you find.

Port 5173 serves the last build, so a server started before you updated has an old page without this button. Stop it and run `scripts/serve.sh` again, which rebuilds first.

## Test it

```sh
scripts/ci.sh         # typecheck, unit tests, browser smoke tests
scripts/ci.sh --full  # everything, on all example models
scripts/ci.sh --full --record  # also rewrites docs/BENCHMARKS.md
```

Browser tests run against the LAN address on purpose, because `127.0.0.1` counts as a secure context and would hide problems that only appear over plain http. Set `CFG_LAN_IP` if this machine's address is not `192.168.0.153`.

They run in Chromium and Firefox. Firefox has no WebGL without a display, so its WebGL tests skip themselves unless `xvfb` is installed, and `scripts/ci.sh` says so when that happens. `WITH_SYSTEM_DEPS=1 scripts/install.sh` installs it, using sudo.
