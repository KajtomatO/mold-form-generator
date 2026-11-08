import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { APACHE_2_0_HEADER, BSD_3_CLAUSE_PHYSX, BSL_1_0, LLVM_EXCEPTION, MIT_TERMS, QUICKHULL_PUBLIC_DOMAIN, SUNPRO, UNLICENSE, ZLIB_DSET } from './licenceTexts';

/** One entry of `npm ls --all --long --json`, as far as the scan reads it. A missing optional package is `{}`. */
export interface NpmNode {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  path?: string;
  dependencies?: Record<string, NpmNode>;
}

export interface Installed {
  name: string;
  version: string;
  licence: string;
  /** The package's folder, which npm ls gives absolute. */
  path: string;
  /** The folders of the packages its own dependencies resolved to. */
  deps: string[];
}

/** An SPDX id or expression from package.json, which old packages give as an object or a list. */
function licenceOf(node: NpmNode): string {
  if (typeof node.license === 'string') return node.license.trim();
  const type = (value: unknown): string => (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string' ? (value as { type: string }).type : '');
  if (node.license) return type(node.license);
  if (Array.isArray(node.licenses)) return node.licenses.map(type).filter(Boolean).join(' OR ');
  return '';
}

/**
 * Every package the tree has installed, once, by its folder. npm ls repeats a package under each
 * package that needs it, and lists its own dependencies under one of those only, so they are merged.
 */
export function installedPackages(tree: NpmNode): Map<string, Installed> {
  const found = new Map<string, Installed>();
  const walk = (node: NpmNode): void => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (!child.version || !child.path) continue; // an optional package for another platform, not installed
      const entry = found.get(child.path) ?? { name, version: child.version, licence: licenceOf(child), path: child.path, deps: [] };
      for (const dep of Object.values(child.dependencies ?? {})) if (dep.path && dep.version && !entry.deps.includes(dep.path)) entry.deps.push(dep.path);
      found.set(child.path, entry);
      walk(child);
    }
  };
  walk(tree);
  return found;
}

/**
 * The production tree: the root's own "dependencies", not its devDependencies, and everything they
 * depend on in turn. npm ls lists a package's dependencies, optional and peer ones but never its
 * devDependencies, so walking it from those roots gives what `npm ci --omit=dev` installs.
 */
export function productionTree(tree: NpmNode, installed: Map<string, Installed>, dependencies: string[]): Set<string> {
  const seen = new Set<string>();
  const todo = dependencies.map((name) => tree.dependencies?.[name]?.path).filter((path): path is string => !!path && installed.has(path));
  while (todo.length > 0) {
    const path = todo.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    todo.push(...installed.get(path)!.deps);
  }
  return seen;
}

/** Licences reviewed as fine to ship. Anything else, GPL-like or not, needs a person to look at it first. */
const PERMISSIVE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', '0BSD', 'Unlicense', 'CC0-1.0', 'Zlib']);
const COPYLEFT = /\b(A|L)?GPL|\bSSPL\b/i;
/** The plan's own line, for the whole production tree: GPL or AGPL. LGPL starts with no word boundary before its G, so it is not matched. */
const GPL_OR_AGPL = /\bA?GPL/i;

export type LicenceClass = 'permissive' | 'copyleft' | 'unknown';

/**
 * An SPDX expression's class. OR lets the user pick one side, AND needs every part, WITH adds an
 * exception to the licence before it. Nested brackets are left to a person, as reading them wrongly
 * could pass "GPL-3.0 AND (MIT OR ISC)".
 */
export function classifyLicence(expression: string): LicenceClass {
  let text = expression.trim();
  if (/^\(.*\)$/.test(text)) text = text.slice(1, -1).trim();
  const ids = text.split(/\s+(?:OR|AND|WITH)\s+/);
  if (!text || /[()]/.test(text)) return ids.some((id) => COPYLEFT.test(id)) ? 'copyleft' : 'unknown';
  const allowed = (part: string): boolean => PERMISSIVE.has(part.split(/\s+WITH\s+/)[0].trim());
  const passes = text.split(/\s+OR\s+/).some((choice) => choice.split(/\s+AND\s+/).every(allowed));
  if (passes) return 'permissive';
  return ids.some((id) => COPYLEFT.test(id)) ? 'copyleft' : 'unknown';
}

/**
 * Whether an SPDX expression binds the user to GPL or AGPL: every choice an OR offers has a GPL or AGPL
 * part. Nested brackets are read the safe way, so any GPL in them counts.
 */
export function needsGpl(expression: string): boolean {
  let text = expression.trim();
  if (/^\(.*\)$/.test(text)) text = text.slice(1, -1).trim();
  if (/[()]/.test(text)) return GPL_OR_AGPL.test(text);
  return text.split(/\s+OR\s+/).every((choice) => choice.split(/\s+AND\s+/).some((part) => GPL_OR_AGPL.test(part.split(/\s+WITH\s+/)[0])));
}

/** What the browser bundle holds, read from an in-memory build with the app's own config. */
export interface Bundle {
  /** Absolute ids of every module in a chunk, main and workers, and the source files of every asset. */
  ids: string[];
  /** Virtual modules the build tools add, such as `\0rolldown/runtime.js`. */
  virtual: string[];
  /** Every chunk's code, unminified, so code taken from other projects can be looked for by name. */
  code: string;
}

/**
 * Builds the app as `vite build` does, without writing anything, and lists every module and asset
 * in the result, in the pages' chunks and the workers' alike. Rolldown makes this take about half a
 * second, and the same sources give the same list.
 */
export async function readBundle(root: string): Promise<Bundle> {
  const { build } = await import('vite');
  const ids = new Set<string>();
  const code: string[] = [];
  const collect = (): Plugin => ({
    name: 'licence-scan-collect',
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          for (const id of Object.keys(file.modules)) ids.add(id);
          code.push(file.code);
        } else for (const name of file.originalFileNames ?? []) ids.add(join(root, name));
      }
    },
  });
  // Vitest sets NODE_ENV to test, and Vite builds for production only when it says production.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({
      root,
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'silent',
      plugins: [collect()],
      worker: { plugins: () => [collect()] },
      // Nothing is written, and an outDir of its own keeps dist/ and dist-ci/ out of it in any case.
      build: { write: false, minify: false, copyPublicDir: false, emptyOutDir: false, outDir: join(tmpdir(), 'cfg-licence-scan') },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  const all = [...ids];
  return { ids: all.filter((id) => id.startsWith('/')), virtual: all.filter((id) => !id.startsWith('/')), code: code.join('\n') };
}

/**
 * The build tools' own code in the bundle: Vite's empty stand-in for Node modules, and Rolldown's
 * runtime. Vite's module preload polyfill is turned off in vite.config.ts, as it is adapted from
 * es-module-shims, whose notice Vite does not carry; should it come back, the scan fails on it here.
 */
export const BUILD_TOOL_MODULES: Record<string, string> = {
  '__vite-browser-external': 'vite',
  '\0rolldown/runtime.js': 'rolldown',
};

/** A markdown table under a `## heading`, as rows of cells, with backticks taken off. Null if there is no such heading. */
export function markdownTable(markdown: string, heading: string): string[][] | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim().replace(/`/g, ''));
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows.slice(1); // the header row
}

/** Whitespace folded, and the copyright sign written as the notices file writes it. */
const folded = (text: string): string => text.replace(/©/g, '(c)').replace(/\s+/g, ' ').trim();

/** A package's licence files: LICENSE, LICENCE and COPYING with any suffix, such as LICENSE-MIT or LICENSE.md. */
const MAIN_LICENCE = /^(licen[cs]e|copying)([-._][\w.-]*)?$/i;
/** Its notices besides: NOTICE, as Apache-2.0 asks, and a third-party licence file, as Rolldown has. */
const OTHER_NOTICE = /^(notice|third[-_]party[-_]licen[cs]es?)([-._][\w.-]*)?$/i;
const CODE_FILE = /\.(js|cjs|mjs|ts|json)$/i;

/**
 * The licence texts a package carries, as the notices must hold them: every licence, NOTICE and
 * third-party licence file in its folder. Vite's LICENSE.md goes on to list what Vite bundles into its
 * own Node code, none of which reaches the browser, so it is read up to that list.
 */
export function licenceTexts(folder: string): { name: string; main: boolean; text: string }[] {
  return readdirSync(folder)
    .filter((name) => (MAIN_LICENCE.test(name) || OTHER_NOTICE.test(name)) && !CODE_FILE.test(name))
    .map((name) => ({ name, main: MAIN_LICENCE.test(name), text: readFileSync(join(folder, name), 'utf8').split('\n# Licenses of bundled dependencies')[0] }));
}

/** The first copyright line of a package's own licence file, such as "Copyright (c) 2018 Garrett Johnson", or null. */
export function copyrightLine(texts: { main: boolean; text: string }[]): string | null {
  for (const { main, text } of texts) {
    if (!main) continue;
    const line = text.split('\n').find((l) => /^\s*Copyright\s+(\(c\)|©|\d)/i.test(l));
    if (line) return folded(line);
  }
  return null;
}

export interface ScanInput {
  tree: NpmNode;
  /** package.json's own "dependencies" and "devDependencies", by name. */
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  bundle: Bundle;
  /** docs/THIRD_PARTY.md */
  thirdParty: string;
  /** public/third-party-notices.txt, or null when the scan should not check it, as on fixture trees. */
  notices: string | null;
  /** manifold.wasm as bytes, or null on fixture trees, which then skip the WebAssembly and its table. */
  wasm: Uint8Array | null;
}

export interface ScanResult {
  /** Each reason the scan fails, in words that say what to change. Empty when it passes. */
  problems: string[];
  shipped: Installed[];
  /** In the production tree but not in the bundle: manifold-3d's command-line tool's own dependencies. */
  installedOnly: Installed[];
  devOnly: Installed[];
}

export const SHIPPED_TABLE = 'In the built app';
export const WASM_TABLE = "Compiled into manifold-3d's WebAssembly";
export const BORROWED_TABLE = 'Code the shipped packages take from others';
export const INSTALLED_TABLE = 'Installed with manifold-3d, not in the built app';
export const DEV_TABLE = 'Development tools, not in the built app';

/** Third-party code whose notice the app must carry although no npm package records it. */
export interface Component {
  /** As the doc's table names it, and as the notices' entry heading starts. */
  name: string;
  /** As the doc's table and the entry's "Licence:" line give it. */
  licence: string;
  /** Copyright lines the entry must hold. */
  copyright: string[];
  /** The licence terms the entry must hold in full. */
  terms: string;
}

/**
 * What manifold.wasm holds besides Manifold, read off Manifold 3.5.4's own sources and build files
 * (its src/ and include/ headers, and cmake/manifoldDeps.cmake), as the npm package ships no C++ and its
 * README names none. Header-only code compiled into the manifold namespace leaves no name of its own in
 * the binary, so `binary` lists only the names that do survive, which the binary must still hold.
 */
export const WASM_COMPONENTS: (Component & { binary: string[] })[] = [
  { name: 'Clipper2', licence: 'BSL-1.0', copyright: [], terms: BSL_1_0, binary: ['Clipper2Lib', 'There is an undefined error in Clipper2'] },
  { name: 'linalg.h', licence: 'Unlicense', copyright: [], terms: UNLICENSE, binary: ['linalg'] },
  { name: 'PhysX', licence: 'BSD-3-Clause', copyright: ['Copyright (c) 2008-2024 NVIDIA Corporation. All rights reserved.', 'Copyright (c) 2004-2008 AGEIA Technologies, Inc. All rights reserved.', 'Copyright (c) 2001-2004 NovodeX AG. All rights reserved.'], terms: BSD_3_CLAUSE_PHYSX, binary: [] },
  { name: 'tbtSVD', licence: 'MIT', copyright: ['Copyright (c) 2019 wi-re'], terms: MIT_TERMS, binary: [] },
  { name: 'quickhull', licence: 'public domain', copyright: [], terms: QUICKHULL_PUBLIC_DOMAIN, binary: [] },
  { name: 'dset', licence: 'Zlib', copyright: ['Copyright (c) 2015 Wenzel Jakob'], terms: ZLIB_DSET, binary: [] },
  { name: 'Emscripten', licence: 'MIT', copyright: ['Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.'], terms: MIT_TERMS, binary: ['emscripten'] },
  { name: 'musl libc', licence: 'MIT', copyright: ['Copyright (c) 2005-2020 Rich Felker, et al.'], terms: MIT_TERMS, binary: [] },
  { name: 'fdlibm', licence: 'SunPro', copyright: [], terms: SUNPRO, binary: [] },
  { name: 'LLVM libc++ and libc++abi', licence: 'Apache-2.0 WITH LLVM-exception', copyright: [], terms: LLVM_EXCEPTION, binary: ['__cxxabiv1', '/emsdk/emscripten/system/lib/libcxxabi/'] },
];

/** Names of libraries a WebAssembly build could take in, each with the component it would be. A name in the binary with no component listed fails. */
export const KNOWN_WASM_NAMES: Record<string, string> = {
  Clipper2Lib: 'Clipper2',
  N6linalg: 'linalg.h',
  N10emscripten: 'Emscripten',
  __cxxabiv1: 'LLVM libc++ and libc++abi',
  N3tbb: 'oneTBB',
  N5boost: 'Boost',
  N5Eigen: 'Eigen',
};

/**
 * Code that a shipped package took from another project, under that project's licence. It needs a
 * notice of its own when its package ships and its marker, a name it keeps in the unminified bundle, is
 * there; a marker of null means it ships whenever its package does.
 */
export const BORROWED_CODE: (Component & { within: string; marker: RegExp | null })[] = [
  { name: 'earcut', within: 'three', marker: /\bfunction earcutLinked\b/, licence: 'ISC', copyright: ['Copyright (c) 2016, Mapbox'], terms: 'Permission to use, copy, modify, and/or distribute this software for any purpose' },
  { name: 'UZIP.js', within: 'fflate', marker: /\bhTree\b/, licence: 'MIT', copyright: ['Copyright (c) 2018 Photopea'], terms: MIT_TERMS },
  { name: 'MathGeoLib', within: 'three-mesh-bvh', marker: /\bclosestPointsSegmentToSegment\b/, licence: 'Apache-2.0', copyright: ['Copyright Jukka Jylanki'], terms: APACHE_2_0_HEADER },
  { name: 'Geometric Tools', within: 'three', marker: /\bdistanceSqToSegment\b/, licence: 'BSL-1.0', copyright: ['David Eberly, Geometric Tools, Redmond WA 98052 Copyright (c) 1998-2018'], terms: BSL_1_0 },
  { name: 'gl-matrix', within: 'three', marker: null, licence: 'MIT', copyright: ['Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV.'], terms: MIT_TERMS },
];

/**
 * The licence scan. A package ships when the browser bundle holds any of its files, and every such
 * package must come from the production tree, except the build tools' own runtime code, which is
 * named. It fails on a shipped licence that is copyleft or unreviewed, on GPL or AGPL anywhere in the
 * production tree, on a package, version, licence or copyright that docs/THIRD_PARTY.md gives otherwise,
 * and on notices that lack a shipped package's licence text or a component's.
 */
export function scanLicences(input: ScanInput): ScanResult {
  const problems: string[] = [];
  const installed = installedPackages(input.tree);
  const production = productionTree(input.tree, installed, Object.keys(input.dependencies));
  // The root's own entry where it has one, else the copy nearest the top, as Rolldown sits under Vite.
  const byName = (name: string): Installed | undefined => {
    const own = input.tree.dependencies?.[name]?.path;
    if (own) return installed.get(own);
    return [...installed.values()].filter((pkg) => pkg.name === name).sort((a, b) => a.path.length - b.path.length)[0];
  };

  // Each bundled file belongs to the installed package whose folder holds it most closely.
  const folders = [...installed.keys()].sort((a, b) => b.length - a.length);
  const shippedPaths = new Set<string>();
  for (const id of input.bundle.ids) {
    if (!id.includes('/node_modules/')) continue;
    const folder = folders.find((path) => id.startsWith(`${path}/`));
    if (folder) shippedPaths.add(folder);
    else problems.push(`The bundle holds ${id}, which no installed package owns.`);
  }
  for (const path of shippedPaths) {
    if (!production.has(path)) problems.push(`${installed.get(path)!.name} ${installed.get(path)!.version} is in the bundle but is no production dependency: move it to "dependencies" or stop importing it.`);
  }
  for (const id of input.bundle.virtual) {
    const tool = BUILD_TOOL_MODULES[id];
    const pkg = tool ? byName(tool) : undefined;
    if (pkg) shippedPaths.add(pkg.path);
    else problems.push(`The bundle holds the build tool module ${JSON.stringify(id)}, which the scan does not know: find out whose code it is and under which licence, then add it to BUILD_TOOL_MODULES with the package it comes from.`);
  }
  // A dependency the bundle never reaches means the bundle was read wrong, or the dependency is not needed.
  for (const name of Object.keys(input.dependencies)) {
    const pkg = byName(name);
    if (!pkg) problems.push(`${name} is in package.json's dependencies but not installed: run scripts/install.sh.`);
    else if (!shippedPaths.has(pkg.path)) problems.push(`${name} is in package.json's dependencies but the bundle holds none of it.`);
  }

  const shipped = [...shippedPaths].map((path) => installed.get(path)!).sort((a, b) => a.name.localeCompare(b.name));
  for (const pkg of shipped) {
    const kind = classifyLicence(pkg.licence);
    if (kind === 'copyleft') problems.push(`${pkg.name} ${pkg.version} ships under ${pkg.licence}, a copyleft licence this app must not ship.`);
    if (kind === 'unknown') problems.push(`${pkg.name} ${pkg.version} ships under ${pkg.licence ? `"${pkg.licence}"` : 'no stated licence'}, which has not been reviewed: check it by hand before shipping.`);
  }

  const installedOnly = [...production].filter((path) => !shippedPaths.has(path)).map((path) => installed.get(path)!).sort((a, b) => a.name.localeCompare(b.name));
  const devOnly = [...installed.values()].filter((pkg) => !production.has(pkg.path) && !shippedPaths.has(pkg.path)).sort((a, b) => a.name.localeCompare(b.name));
  // The plan's check, as it reads, over the whole production tree. LGPL outside the bundle is allowed.
  for (const pkg of installedOnly) {
    if (needsGpl(pkg.licence)) problems.push(`${pkg.name} ${pkg.version} is installed for production under ${pkg.licence}: the plan allows no GPL or AGPL in the production tree, even outside the bundle.`);
  }

  // docs/THIRD_PARTY.md: each table must say what the tree and the bundle say, no more and no less.
  const table = (heading: string): string[][] => {
    const rows = markdownTable(input.thirdParty, heading);
    if (!rows) problems.push(`docs/THIRD_PARTY.md has no "## ${heading}" table.`);
    return rows ?? [];
  };
  /** Rows are matched by name and version, so two versions of one package can each have theirs. */
  const compare = (heading: string, packages: Installed[], is: string, isNot: string): Map<Installed, string[]> => {
    const rows = table(heading);
    const matched = new Map<Installed, string[]>();
    const used = new Set<string[]>();
    const exact = (pkg: Installed): string[] | undefined => rows.find((cells) => cells[0] === pkg.name && cells[1] === pkg.version);
    for (const pkg of packages) {
      // A row of the same name whose version nothing installed has is this package's, at a wrong version.
      const row = exact(pkg) ?? rows.find((cells) => cells[0] === pkg.name && !used.has(cells) && !packages.some((other) => other.name === cells[0] && other.version === cells[1]));
      if (!row) {
        problems.push(`docs/THIRD_PARTY.md's "${heading}" table lacks ${pkg.name} ${pkg.version}, which ${is}.`);
        continue;
      }
      used.add(row);
      matched.set(pkg, row);
      if (row[1] !== pkg.version) problems.push(`docs/THIRD_PARTY.md's "${heading}" table gives ${pkg.name} as ${row[1]}, but ${pkg.version} is installed.`);
      else if (row[2] !== pkg.licence) problems.push(`docs/THIRD_PARTY.md's "${heading}" table gives ${pkg.name}'s licence as ${row[2]}, but its package says ${pkg.licence}.`);
    }
    for (const row of rows) if (!used.has(row)) problems.push(`docs/THIRD_PARTY.md's "${heading}" table lists ${row[0]} ${row[1]}, which ${isNot}.`);
    return matched;
  };
  const shippedRows = compare(SHIPPED_TABLE, shipped, 'ships in the built app', 'does not ship');
  compare(INSTALLED_TABLE, installedOnly, 'is installed for production outside the bundle', 'is not installed for production outside the bundle');
  const tools = Object.keys(input.devDependencies).map(byName).filter((pkg): pkg is Installed => !!pkg);
  compare(DEV_TABLE, tools, 'is a direct devDependency', 'is no direct devDependency');

  // Code that shipped packages took from others, by a name it keeps in the bundle.
  const shippedNames = new Set(shipped.map((pkg) => pkg.name));
  const borrowed = BORROWED_CODE.filter((c) => shippedNames.has(c.within) && (c.marker === null || c.marker.test(input.bundle.code)));
  // Fixture trees ship none of these packages, and need not have the table.
  const borrowedRows = borrowed.length > 0 ? table(BORROWED_TABLE) : (markdownTable(input.thirdParty, BORROWED_TABLE) ?? []);
  for (const c of borrowed) {
    const row = borrowedRows.find((cells) => cells[0] === c.name);
    if (!row) problems.push(`The bundle holds ${c.name}'s code, inside ${c.within}, which docs/THIRD_PARTY.md's "${BORROWED_TABLE}" table lacks.`);
    else if (row[2] !== c.licence) problems.push(`docs/THIRD_PARTY.md gives ${c.name} the licence ${row[2]}, where the scan knows it as ${c.licence}.`);
  }
  for (const row of borrowedRows) if (!BORROWED_CODE.some((c) => c.name === row[0])) problems.push(`docs/THIRD_PARTY.md's "${BORROWED_TABLE}" table lists ${row[0]}, which the scan does not know: add it to BORROWED_CODE.`);

  // The WebAssembly: the doc's table is the fixed list, and the binary holds the names it should.
  const components = input.wasm === null ? [] : WASM_COMPONENTS;
  if (input.wasm !== null) {
    const wasmRows = table(WASM_TABLE);
    for (const c of WASM_COMPONENTS) {
      const row = wasmRows.find((cells) => cells[0] === c.name);
      if (!row) problems.push(`docs/THIRD_PARTY.md's "${WASM_TABLE}" table lacks ${c.name}, which manifold.wasm holds.`);
      else if (row[2] !== c.licence) problems.push(`docs/THIRD_PARTY.md gives ${c.name} the licence ${row[2]}, where the scan knows it as ${c.licence}.`);
    }
    for (const row of wasmRows) if (!WASM_COMPONENTS.some((c) => c.name === row[0])) problems.push(`docs/THIRD_PARTY.md's "${WASM_TABLE}" table lists ${row[0]}, which the scan does not know: add it to WASM_COMPONENTS.`);
    const binary = Buffer.from(input.wasm).toString('latin1');
    for (const c of WASM_COMPONENTS) for (const name of c.binary) if (!binary.includes(name)) problems.push(`manifold.wasm no longer holds "${name}", by which ${c.name} was found in it: check what the new build holds.`);
    for (const [name, component] of Object.entries(KNOWN_WASM_NAMES)) {
      if (binary.includes(name) && !WASM_COMPONENTS.some((c) => c.name === component)) problems.push(`manifold.wasm holds "${name}", which is ${component}, and no notice covers it.`);
    }
  }

  // The notices, and each shipped package's licence files, which fixture trees without real folders skip.
  if (input.notices !== null) {
    const entries = noticeEntries(input.notices);
    for (const pkg of shipped) {
      const own = licenceTexts(pkg.path);
      if (!own.some((t) => t.main)) problems.push(`${pkg.name} ${pkg.version} has no licence file in its folder: read its licence by hand, and add its text to the notices and a reviewed exception to the scan.`);
      const line = copyrightLine(own);
      const row = shippedRows.get(pkg);
      if (line && row && !folded(row[3] ?? '').includes(line)) problems.push(`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives ${pkg.name}'s copyright as "${row[3] ?? ''}", but its licence says "${line}".`);
      const entry = entries.find((e) => e.title === `${pkg.name} ${pkg.version}` || e.title.startsWith(`${pkg.name} ${pkg.version} (`));
      if (!entry) {
        problems.push(`public/third-party-notices.txt has no entry headed "${pkg.name} ${pkg.version}".`);
        continue;
      }
      if (!new RegExp(`^Licence: ${literal(pkg.licence)}(\\s|$)`, 'm').test(entry.header)) problems.push(`public/third-party-notices.txt's entry for ${pkg.name} does not say "Licence: ${pkg.licence}".`);
      if (line && !folded(entry.header).includes(line)) problems.push(`public/third-party-notices.txt's entry for ${pkg.name} does not head its text with "${line}".`);
      for (const { name, text } of own) if (!folded(entry.text).includes(folded(text))) problems.push(`public/third-party-notices.txt's entry for ${pkg.name} lacks the text of its ${name}.`);
    }
    for (const c of [...components, ...borrowed]) {
      const entry = entries.find((e) => e.title.startsWith(c.name));
      if (!entry) {
        problems.push(`public/third-party-notices.txt has no entry for ${c.name}.`);
        continue;
      }
      if (!new RegExp(`^Licence: ${literal(c.licence)}(\\s|$)`, 'm').test(entry.header)) problems.push(`public/third-party-notices.txt's entry for ${c.name} does not say "Licence: ${c.licence}".`);
      for (const line of c.copyright) if (!folded(entry.text).includes(folded(line))) problems.push(`public/third-party-notices.txt's entry for ${c.name} lacks "${line}".`);
      if (!folded(entry.text).includes(folded(c.terms))) problems.push(`public/third-party-notices.txt's entry for ${c.name} lacks the ${c.licence} text in full.`);
    }
  }
  return { problems, shipped, installedOnly, devOnly };
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The notices file's entries: a heading between two rules of 78 dashes, then the text up to the next
 * rule. The header is the heading's block, with the Licence and Copyright lines; the text is the licence.
 */
export function noticeEntries(notices: string): { title: string; header: string; text: string }[] {
  const parts = notices.split(/^-{78}$/m);
  const entries: { title: string; header: string; text: string }[] = [];
  for (let k = 1; k + 1 < parts.length; k += 2) entries.push({ title: parts[k].trim().split('\n')[0], header: parts[k], text: parts[k + 1] });
  return entries;
}
