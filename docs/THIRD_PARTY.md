# Third-party software

The app is built from its own code and the open-source packages below. This file lists every one that ships in the built app, the code those packages take from other projects, what manifold-3d compiles into its WebAssembly, what npm installs beside them without shipping it, and the tools used only to build and test.

The built app's files are minified, which drops the libraries' own licence comments. So the full notices ship as a file of their own, `public/third-party-notices.txt`, which the build copies next to `index.html`. The app links to it at the foot of the Advanced section, as "Third-party licences". It holds each shipped package's licence text as the package gives it, the notices of the code those packages take from other projects, the licence texts of what is compiled into the WebAssembly, and those of the build tools' runtime code, which meets the notice terms of MIT, ISC, BSD-3-Clause, BSL-1.0, Apache-2.0, Zlib and Sun's fdlibm notice for what the app serves. Apache-2.0 also asks for a package's NOTICE file: none of the shipped packages has one.

## In the built app

Everything the browser loads from the server, as the licence test reads it off a real build.

| Package | Version | Licence | Copyright | Source | What it does here |
|---|---|---|---|---|---|
| `@preact/signals` | 2.11.4 | MIT | Copyright (c) 2022-present Preact Team | https://github.com/preactjs/signals | the store the sidebar reads |
| `@preact/signals-core` | 1.14.5 | MIT | Copyright (c) 2022-present Preact Team | https://github.com/preactjs/signals | used by `@preact/signals` |
| `delatin` | 0.2.0 | ISC | Copyright (c) 2019, Michael Fogleman, Vladimir Agafonkin | https://github.com/mapbox/delatin | turns the cavity's height field into few triangles |
| `fflate` | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett | https://github.com/101arrowz/fflate | the export ZIP and the project file |
| `manifold-3d` | 3.5.4 | Apache-2.0 | Copyright The Manifold Authors (2022 to 2026 in the headers of its files) | https://github.com/elalish/manifold | the solid booleans, as WebAssembly |
| `meshoptimizer` | 1.3.0 | MIT | Copyright (c) 2016-2026 Arseny Kapoulkine | https://github.com/zeux/meshoptimizer | simplifies heavy meshes |
| `preact` | 10.29.8 | MIT | Copyright (c) 2015-present Jason Miller | https://github.com/preactjs/preact | the user interface |
| `three` | 0.187.0 | MIT | Copyright (c) 2010-2026 three.js authors | https://github.com/mrdoob/three.js | the 3D view, with its OrbitControls add-on |
| `three-mesh-bvh` | 0.9.18 | MIT | Copyright (c) 2018 Garrett Johnson | https://github.com/gkjohnson/three-mesh-bvh | picking a face with the pointer |
| `vite` | 8.3.6 | MIT | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors | https://github.com/vitejs/vite | a build tool; it adds an empty stand-in for Node modules |
| `rolldown` | 1.2.16 | MIT | Copyright (c) 2024-present VoidZero Inc. & Contributors | https://github.com/rolldown/rolldown | Vite's bundler; it adds its runtime helpers, and its third-party licence covers code it takes from Rollup and esbuild |

Vite and Rolldown are development tools, listed again below. Only those few helpers of theirs end up in the app, which is why they appear here too. Vite would also add a module preload polyfill for browsers that cannot preload modules themselves. That polyfill is adapted from es-module-shims (MIT, Guy Bedford), whose notice Vite does not carry, and every browser the app supports preloads modules itself, so `vite.config.ts` turns it off.

## Code the shipped packages take from others

The shipped packages' sources say where parts of their code come from another project. Those that the bundle holds, as the licence test finds them by a name each keeps in it, have their own notice in `public/third-party-notices.txt`.

| Code | In | Licence | Copyright | Source | In the bundle |
|---|---|---|---|---|---|
| UZIP.js | `fflate` | MIT | Copyright (c) 2018 Photopea | https://github.com/photopea/UZIP.js | yes: the Huffman tree code of fflate's DEFLATE, which its source marks "efficient algorithm from UZIP.js" (`hTree`) |
| MathGeoLib | `three-mesh-bvh` | Apache-2.0 | Copyright Jukka Jylanki | https://github.com/juj/MathGeoLib | yes: `closestPointLineToLine` and `closestPointsSegmentToSegment`, ported from its Line.cpp and LineSegment.cpp |
| Geometric Tools | `three` | BSL-1.0 | Copyright (c) 1998-2018 David Eberly, Geometric Tools | https://www.geometrictools.com | yes: `Ray.distanceSqToSegment`, from its GteDistRaySegment.h |
| gl-matrix | `three` | MIT | Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV. | https://github.com/toji/gl-matrix | yes: `Matrix4.invert`, which three.js says is based on it |
| earcut | `three` | ISC | Copyright (c) 2016, Mapbox | https://github.com/mapbox/earcut | no: the app never triangulates a shape with three.js, so the build leaves three.js's port of it out, and none of its functions (`earcutLinked`) is in the bundle |

If a later change makes the bundle hold earcut, the licence test fails until its notice is in `public/third-party-notices.txt`.

## Compiled into manifold-3d's WebAssembly

manifold-3d's authors build `manifold.wasm` and its loader `manifold.js` with Emscripten. Besides Manifold itself, the WebAssembly holds the components below. The npm package ships no C++ source and names none of them, so the list comes from Manifold 3.5.4's own sources at its `v3.5.4` tag: the libraries its build fetches (`cmake/manifoldDeps.cmake`), and the headers in its `src/` and `include/` folders that say they are taken from another project. Code compiled from a header into Manifold's own namespace leaves no name of its own in the binary, so only some of the components can be seen there too; the last column says which. The package does not record versions, so they are the ones Manifold 3.5.4's sources give.

| Component | Version | Licence | Copyright | Source | Where it is found |
|---|---|---|---|---|---|
| Clipper2 | commit 46f6391, which Manifold 3.5.4's build fetches | BSL-1.0 | Copyright (c) Angus Johnson | https://github.com/AngusJohnson/Clipper2 | Manifold's `cmake/manifoldDeps.cmake`; in the binary, the `Clipper2Lib` namespace and the message "There is an undefined error in Clipper2" |
| linalg.h | 2.2, adapted in Manifold's `include/manifold/linalg.h` | Unlicense | Sterling Orsten, public domain | https://github.com/sgorsten/linalg | that header; in the binary, the `linalg` namespace |
| PhysX | as of 2024, in Manifold's `src/tri_dist.h` | BSD-3-Clause | Copyright (c) 2008-2024 NVIDIA Corporation; (c) 2004-2008 AGEIA Technologies, Inc.; (c) 2001-2004 NovodeX AG | https://github.com/NVIDIA-Omniverse/PhysX | that header: the distance between two segments, which `minGap` uses |
| tbtSVD | modified in Manifold's `src/svd.h` | MIT | Copyright (c) 2019 wi-re | https://github.com/wi-re/tbtSVD | that header: the singular value decomposition every transform uses |
| quickhull | derived in Manifold's `src/quickhull.cpp` | public domain | Antti Kuukka | https://github.com/akuukka/quickhull | that file: `hull`, which the joint uses |
| dset | changed in Manifold's `src/disjoint_sets.h` | Zlib | Copyright (c) 2015 Wenzel Jakob | https://github.com/wjakob/dset | that header: the disjoint sets of `decompose` and the boolean operations |
| Emscripten | as built into manifold-3d 3.5.4 | MIT | Copyright (c) 2010-2014 Emscripten authors | https://github.com/emscripten-core/emscripten | in the binary, the `emscripten` namespace (embind), and the loader code in `manifold.js` |
| musl libc | as built into manifold-3d 3.5.4 | MIT | Copyright (c) 2005-2020 Rich Felker, et al. | https://musl.libc.org | not by name: Emscripten's C library is based on musl |
| fdlibm | the 1993 code, via musl | SunPro | Copyright (C) 1993 by Sun Microsystems, Inc. | https://git.musl-libc.org/cgit/musl/tree/src/math | Manifold's `include/manifold/math.h`, its trigonometry adapted from musl's, and musl's maths library |
| LLVM libc++ and libc++abi | as built into manifold-3d 3.5.4 | Apache-2.0 WITH LLVM-exception | the LLVM Project contributors | https://llvm.org | in the binary, the `std::__2` and `__cxxabiv1` namespaces, and libc++abi's own source path |

Emscripten is offered under both the MIT and the University of Illinois/NCSA licence; the notices use MIT. PhysX's BSD-3-Clause asks for its notice with a binary, and MIT for its notice in every copy. The BSL-1.0, the LLVM exception and the zlib licence ask for no notice in compiled code, and linalg.h and quickhull are public domain, but the notices carry their texts all the same. PhysX's newer releases put that file under Apache-2.0; the notices give the BSD-3-Clause text of the 2024 release, from which Manifold took it. `manifold.js` calls an `initTBB` function, yet the binary holds no `tbb` names, and Manifold's build fetches oneTBB only for its parallel build: this serial build has no oneTBB code in it.

## Installed with manifold-3d, not in the built app

manifold-3d's package also lists the dependencies of its manifoldCAD command-line tool and of its glTF and 3MF export code, which this app never imports. npm installs them with the app's own dependencies, so they are on the server after `scripts/install.sh`, but the app loads only `manifold.js` and `manifold.wasm` from that package, and the licence test, which builds the app, finds none of them in the bundle.

One of them is under a copyleft licence: `@img/sharp-libvips-linux-x64` holds libvips, LGPL-3.0-or-later, a native image library that sharp loads in Node. It is never served to a browser and never runs, as nothing here starts manifoldCAD or sharp. None of them is GPL or AGPL, which the licence test checks over this whole table as well as the built app. On another platform npm installs that platform's libvips package in its place, and the licence test then asks for this table to name it.

| Package | Version | Licence | Pulled in by |
|---|---|---|---|
| `@gltf-transform/core` | 4.5.1 | MIT | `manifold-3d` |
| `@gltf-transform/extensions` | 4.5.1 | MIT | `manifold-3d` |
| `@gltf-transform/functions` | 4.5.1 | MIT | `manifold-3d` |
| `@img/colour` | 1.1.0 | MIT | `sharp` |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later | `sharp` |
| `@img/sharp-linux-x64` | 0.35.5 | Apache-2.0 | `sharp` |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | `manifold-3d` |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | `@jridgewell/trace-mapping` |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | `manifold-3d` |
| `@jscadui/3mf-export` | 0.5.0 | MIT | `manifold-3d` |
| `@nodable/entities` | 3.1.0 | MIT | `fast-xml-parser` |
| `@types/ndarray` | 1.1.0 | MIT | `ndarray-lanczos` |
| `anynum` | 1.0.1 | MIT | `strnum` |
| `commander` | 13.1.0 | MIT | `manifold-3d` |
| `convert-source-map` | 2.0.0 | MIT | `manifold-3d` |
| `cwise-compiler` | 1.1.3 | MIT | `ndarray-ops` |
| `detect-libc` | 2.1.2 | Apache-2.0 | `sharp` |
| `esbuild-wasm` | 0.27.7 | MIT | `manifold-3d` |
| `fast-xml-builder` | 1.3.1 | MIT | `fast-xml-parser` |
| `fast-xml-parser` | 5.12.0 | MIT | `manifold-3d` |
| `iota-array` | 1.0.0 | MIT | `ndarray` |
| `is-buffer` | 1.1.6 | MIT | `ndarray` |
| `is-unsafe` | 2.0.3 | MIT | `fast-xml-parser` |
| `ktx-parse` | 1.1.0 | MIT | `@gltf-transform/extensions` |
| `magic-string` | 0.30.21 | MIT | `manifold-3d` |
| `ndarray` | 1.1.1 | MIT | `ndarray-lanczos` |
| `ndarray-lanczos` | 0.3.0 | MIT | `@gltf-transform/functions` |
| `ndarray-ops` | 1.2.2 | MIT | `ndarray-pixels` |
| `ndarray-pixels` | 5.2.0 | MIT | `@gltf-transform/functions` |
| `path-expression-matcher` | 1.6.2 | MIT | `fast-xml-builder` |
| `property-graph` | 4.1.0 | MIT | `@gltf-transform/core` |
| `semver` | 7.8.6 | ISC | `sharp` |
| `sharp` | 0.35.5 | Apache-2.0 | `ndarray-pixels` |
| `strnum` | 2.5.1 | MIT | `fast-xml-parser` |
| `uniq` | 1.0.1 | MIT | `cwise-compiler` |
| `xml-naming` | 0.3.0 | MIT | `fast-xml-builder` |

## Development tools, not in the built app

These build, check and test the app. None of their code is served, apart from the Vite and Rolldown helpers named above.

| Package | Version | Licence | Use |
|---|---|---|---|
| `@playwright/test` | 1.63.0 | Apache-2.0 | browser tests; it downloads its own Chromium and Firefox into `~/.cache` |
| `@types/node` | 24.10.1 | MIT | type definitions |
| `@types/three` | 0.187.0 | MIT | type definitions |
| `typescript` | 7.0.2 | Apache-2.0 | the type check |
| `vite` | 8.3.6 | MIT | the build and the development server |
| `vitest` | 5.1.0 | MIT | the unit tests |

With their own dependencies, and leaving out Vite and Rolldown, whose helpers ship, 43 packages are installed for development only, at version 0.1.0 of the app: 32 under MIT, 7 Apache-2.0, 1 ISC, 1 BSD-3-Clause and 2 MPL-2.0 (`lightningcss` and its Linux build, which Vite uses on stylesheets at build time). The licence test prints these counts on every run.

## How the list is checked

`test/unit/licences.test.ts` runs in the quick suite, in about a second:

1. It runs `npm ls --all --long --json`, offline, which reads `node_modules` and asks no registry, with development packages included whatever `NODE_ENV` or npm's settings say, and takes the production tree from it: the packages under `dependencies` in `package.json` and everything they depend on.
2. It builds the app in memory with the app's own Vite config, writing nothing, and lists every module and asset in the pages' and the workers' bundles. A package ships when the bundle holds any of its files. Each such package must be in the production tree; the build tools' own helpers are named, and any other code they add fails until someone has found out whose it is. Every dependency in `package.json` must be in the bundle, so a bundle read wrongly fails.
3. It fails on any shipped package whose licence is GPL, AGPL, LGPL, SSPL, missing, or not on its reviewed list (MIT, ISC, Apache-2.0, the BSD licences, BSL-1.0, 0BSD, Unlicense, CC0-1.0, Zlib), and on any GPL or AGPL package anywhere in the production tree, as the plan says. LGPL outside the bundle passes, as libvips does.
4. It fails when a shipped package, its version, its licence or its copyright line is missing from the "In the built app" table here or differs from the package's, when that table lists a package that does not ship, and when the other tables differ from what is installed. Rows match by name and version, so two versions of one package each need their own.
5. It fails when `public/third-party-notices.txt` lacks an entry for a shipped package, or the entry's "Licence:" line, its copyright line or any of the package's licence files is missing or differs. A shipped package with no licence file fails too.
6. It fails when the bundle holds code from the "Code the shipped packages take from others" table, by the name each keeps there, and the notices lack its entry, its copyright or its licence in full; and when that table, or the WebAssembly table, lists something the test does not know.
7. The WebAssembly table must be exactly the test's own list, and each component's entry in the notices must hold its "Licence:" line, its copyright lines and its licence text in full, as the upstream project gives it. `manifold.wasm` must still hold the names by which some components are seen in it, and a name of a library no row covers, such as oneTBB's, fails.
8. It prints the licences of what is installed for production outside the bundle and of the development tools.

Fixture trees and changed copies of the real files show each of these failing.

## BumpMesh

The original requirements asked for BumpMesh (bumpmesh.com) as the reference for the interface. BumpMesh is under the AGPL, so it served as a reference for layout conventions only: a header, a viewport, a sidebar on the right and a status strip. No code, markup, stylesheet, icon or other asset was copied from it. The app's CSS, markup, palette and icons were written for this project.

## This project's own licence

The project's own code and docs are under the MIT licence, chosen by its owner on 2026-11-09: see `LICENSE` at the top of the repository. `package.json` says `"license": "MIT"` and stays `"private": true`, which only keeps it from being published to npm by accident. The example models in `examples/` are not covered: they belong to their authors and keep their own terms.
