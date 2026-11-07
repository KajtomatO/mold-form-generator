# Casting Form Generator

A browser app that takes an STL and generates a printable base and cover for pouring a silicone casting mold, using as little silicone as a demoldable shape allows. All geometry runs in your browser, and the server only hands out files.

- `docs/REQUIREMENTS.md`: requirements and decisions
- `docs/PLAN.md`: how it is built, milestone by milestone

## Run it

```sh
scripts/install.sh   # Node 24+ required; no root needed
scripts/serve.sh     # then browse to http://<server-ip>:5173
```

## Test it

```sh
scripts/ci.sh         # typecheck, unit tests, browser smoke tests
scripts/ci.sh --full  # everything, on all example models
```

Browser tests run against the LAN address on purpose, because `127.0.0.1` counts as a secure context and would hide problems that only appear over plain http. Set `CFG_LAN_IP` if this machine's address is not `192.168.0.153`.

They run in Chromium and Firefox. Firefox has no WebGL without a display, so its WebGL tests skip themselves unless `xvfb` is installed, and `scripts/ci.sh` says so when that happens. `WITH_SYSTEM_DEPS=1 scripts/install.sh` installs it, using sudo.
