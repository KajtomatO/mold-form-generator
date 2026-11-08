import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BORROWED_TABLE, classifyLicence, DEV_TABLE, INSTALLED_TABLE, installedPackages, needsGpl, readBundle, scanLicences, SHIPPED_TABLE, WASM_TABLE, type Bundle, type Installed, type NpmNode, type ScanInput } from '../fixtures/licences';
import { MIT_TERMS } from '../fixtures/licenceTexts';

const root = join(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const thirdParty = readFileSync(join(root, 'docs', 'THIRD_PARTY.md'), 'utf8');
const noticeBytes = readFileSync(join(root, 'public', 'third-party-notices.txt'));
const notices = noticeBytes.toString('utf8');
const wasm = readFileSync(join(root, 'node_modules', 'manifold-3d', 'manifold.wasm'));

/**
 * The plan's command. npm ls reads node_modules only; offline and with no update check, it asks no
 * registry either. NODE_ENV=production or an npm setting that omits dev would drop the development
 * tree, so neither is passed on.
 */
function npmTree(extra: Record<string, string> = {}): NpmNode {
  const { NODE_ENV: _, ...env } = process.env;
  const out = execFileSync('npm', ['ls', '--all', '--long', '--json', '--include=dev'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, npm_config_omit: '', npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', ...extra },
  });
  return JSON.parse(out) as NpmNode;
}

const byLicence = (packages: Installed[]): string => {
  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.licence || '(none)', (counts.get(p.licence || '(none)') ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([licence, n]) => `${licence} ${n}`).join(', ');
};
const notPermissive = (packages: Installed[]): string => packages.filter((p) => classifyLicence(p.licence) !== 'permissive').map((p) => `${p.name} ${p.version} (${p.licence})`).join(', ') || 'none';

/** The notices with one entry's text changed, the entry found by the start of its heading. */
function inEntry(text: string, title: string, from: string | RegExp, to: string): string {
  const head = text.indexOf(`\n${title}`);
  const next = text.indexOf(`\n${'-'.repeat(78)}\n`, text.indexOf(`\n${'-'.repeat(78)}\n`, head + 1) + 1);
  const end = next < 0 ? text.length : next;
  const changed = text.slice(head, end).replace(from, to);
  expect(changed, `${title}: ${String(from)}`).not.toBe(text.slice(head, end));
  return text.slice(0, head) + changed + text.slice(end);
}
/** The doc with one table row changed or, with `to` empty, taken out. */
function inDoc(from: RegExp, to: string): string {
  const changed = thirdParty.replace(from, to);
  expect(changed, String(from)).not.toBe(thirdParty);
  return changed;
}

describe('the licence scan on the real tree and bundle', () => {
  let tree: NpmNode;
  let bundle: Bundle;
  let input: ScanInput;
  beforeAll(async () => {
    tree = npmTree();
    bundle = await readBundle(root);
    input = { tree, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, bundle, thirdParty, notices, wasm };
  }, 60_000);

  it('ships only reviewed permissive licences, each package and version in docs/THIRD_PARTY.md, with its licence text in the notices the app serves', () => {
    const result = scanLicences(input);
    console.log(
      [
        `Shipped (${result.shipped.length}): ${result.shipped.map((p) => `${p.name} ${p.version} ${p.licence}`).join(', ')}`,
        `Installed for production, not in the bundle (${result.installedOnly.length}): ${byLicence(result.installedOnly)}; not permissive: ${notPermissive(result.installedOnly)}`,
        `Development only (${result.devOnly.length}): ${byLicence(result.devOnly)}; not permissive: ${notPermissive(result.devOnly)}`,
      ].join('\n'),
    );
    expect(result.problems).toEqual([]);
    // The bundle read is the real one: every dependency is in it, with the build tools' runtime.
    expect(result.shipped.map((p) => p.name)).toEqual(expect.arrayContaining([...Object.keys(pkg.dependencies), 'vite', 'rolldown']));
    // The plan's own check, as it reads: no GPL or AGPL anywhere in the production tree.
    expect([...result.shipped, ...result.installedOnly].filter((p) => needsGpl(p.licence))).toEqual([]);
  });

  it('the notices are plain ASCII, as vite preview serves text with no charset', () => {
    expect([...noticeBytes].filter((byte) => byte > 0x7f)).toEqual([]);
  });

  it('reads the development tree whatever NODE_ENV or npm settings say', () => {
    const count = installedPackages(tree).size;
    expect(count).toBeGreaterThan(80);
    expect(installedPackages(npmTree({ NODE_ENV: 'production', npm_config_omit: 'dev' })).size).toBe(count);
  });

  it('negative controls on the real tree: the doc without a package, at another version, licence or copyright, and its other tables changed, each fail', () => {
    const problems = (change: Partial<ScanInput>): string[] => scanLicences({ ...input, ...change }).problems;
    expect(problems({ thirdParty: inDoc(/^\| `?three`? \|.*\n/m, '') })).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table lacks three 0.187.0, which ships in the built app.`]);
    expect(problems({ thirdParty: inDoc(/^(\| `?fflate`? \| )0\.8\.3/m, '$10.8.2') })).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives fflate as 0.8.2, but 0.8.3 is installed.`]);
    expect(problems({ thirdParty: inDoc(/^(\| `three` \| 0\.187\.0 \| )MIT/m, '$1ISC') })).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives three's licence as ISC, but its package says MIT.`]);
    expect(problems({ thirdParty: inDoc(/Copyright \(c\) 2010-2026 three\.js authors/, 'Copyright (c) Nobody') })).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives three's copyright as "Copyright (c) Nobody", but its licence says "Copyright (c) 2010-2026 three.js authors".`]);
    expect(problems({ thirdParty: inDoc(/^\| `vitest` \|.*\n/m, '') })).toEqual([`docs/THIRD_PARTY.md's "${DEV_TABLE}" table lacks vitest 5.1.0, which is a direct devDependency.`]);
    expect(problems({ thirdParty: inDoc(/^(\| `vitest` \| )5\.1\.0/m, '$15.0.0') })).toEqual([`docs/THIRD_PARTY.md's "${DEV_TABLE}" table gives vitest as 5.0.0, but 5.1.0 is installed.`]);
    expect(problems({ thirdParty: inDoc(/^(\| `vitest` \|.*\n)/m, '$1| `jest` | 30.0.0 | MIT | tests |\n') })).toEqual([`docs/THIRD_PARTY.md's "${DEV_TABLE}" table lists jest 30.0.0, which is no direct devDependency.`]);
    expect(problems({ thirdParty: inDoc(/^\| `sharp` \|.*\n/m, '') })).toEqual([`docs/THIRD_PARTY.md's "${INSTALLED_TABLE}" table lacks sharp 0.35.5, which is installed for production outside the bundle.`]);
  });

  it('negative controls on the real notices: a licence text, a Licence line or a copyright line wrong or missing each fail', () => {
    const problems = (text: string): string[] => scanLicences({ ...input, notices: text }).problems;
    expect(problems(notices.replace('Permission to use, copy, modify, and/or distribute this software for any purpose', 'Permission to use this software'))).toEqual(["public/third-party-notices.txt's entry for delatin lacks the text of its LICENSE."]);
    expect(problems(inEntry(notices, 'three 0.187.0', /^Licence: MIT$/m, 'Licence: GPL-3.0'))).toEqual(["public/third-party-notices.txt's entry for three does not say \"Licence: MIT\"."]);
    expect(problems(inEntry(notices, 'three 0.187.0', /^Copyright \(c\) 2010-2026 three\.js authors$/m, 'Copyright (c) Nobody'))).toEqual(['public/third-party-notices.txt\'s entry for three does not head its text with "Copyright (c) 2010-2026 three.js authors".']);
  });

  it('negative controls on the WebAssembly: its table and notices are held to the fixed list, in full, and to the names in the binary', () => {
    const problems = (change: Partial<ScanInput>): string[] => scanLicences({ ...input, ...change }).problems;
    // A row and its entry taken out together still fail, as the list is the test's own.
    const noClipperEntry = notices.replace(/^-{78}\nClipper2 [\s\S]*?(?=^-{78}\nlinalg\.h )/m, '');
    expect(noClipperEntry).not.toBe(notices);
    expect(problems({ thirdParty: inDoc(/^\| Clipper2 \|.*\n/m, ''), notices: noClipperEntry })).toEqual([`docs/THIRD_PARTY.md's "${WASM_TABLE}" table lacks Clipper2, which manifold.wasm holds.`, 'public/third-party-notices.txt has no entry for Clipper2.']);
    expect(problems({ thirdParty: inDoc(/^(\| PhysX \|.*\n)/m, '$1| Eigen | 3.4 | MPL-2.0 | Eigen authors | https://eigen.tuxfamily.org | nowhere |\n') })).toEqual([`docs/THIRD_PARTY.md's "${WASM_TABLE}" table lists Eigen, which the scan does not know: add it to WASM_COMPONENTS.`]);
    expect(problems({ thirdParty: inDoc(/^(\| dset \| [^|]+\| )Zlib/m, '$1MIT') })).toEqual(['docs/THIRD_PARTY.md gives dset the licence MIT, where the scan knows it as Zlib.']);
    // One sentence of the licence, or the terms without the copyright line, is not the notice.
    const oneSentence = inEntry(notices, 'Emscripten runtime', /Permission is hereby granted, free of charge[\s\S]*SOFTWARE\.\n/, 'Permission is hereby granted, free of charge.\n');
    expect(problems({ notices: oneSentence })).toEqual(["public/third-party-notices.txt's entry for Emscripten lacks the MIT text in full."]);
    expect(problems({ notices: inEntry(notices, 'musl libc', /\nCopyright \(c\) 2005-2020 Rich Felker, et al\.\n/g, '\n') })).toEqual(['public/third-party-notices.txt\'s entry for musl libc lacks "Copyright (c) 2005-2020 Rich Felker, et al.".']);
    expect(problems({ notices: inEntry(notices, 'PhysX', /Redistributions in binary form must reproduce[^*]*\*/, '*') })).toEqual(["public/third-party-notices.txt's entry for PhysX lacks the BSD-3-Clause text in full."]);
    expect(problems({ notices: inEntry(notices, 'Clipper2', 'Boost Software License - Version 1.0', 'Some licence') })).toEqual(["public/third-party-notices.txt's entry for Clipper2 lacks the BSL-1.0 text in full."]);
    expect(problems({ notices: inEntry(notices, 'dset', /^Licence: Zlib$/m, 'Licence: MIT') })).toEqual(["public/third-party-notices.txt's entry for dset does not say \"Licence: Zlib\"."]);
    // The binary: a name gone that a component is seen by, and a library's name that no row covers.
    const binary = Buffer.from(wasm.toString('latin1').replaceAll('Clipper2Lib', 'Clipper9Lib'), 'latin1');
    expect(problems({ wasm: binary })).toEqual(['manifold.wasm no longer holds "Clipper2Lib", by which Clipper2 was found in it: check what the new build holds.']);
    expect(problems({ wasm: Buffer.concat([wasm, Buffer.from('N3tbb4taskE')]) })).toEqual(['manifold.wasm holds "N3tbb", which is oneTBB, and no notice covers it.']);
  });

  it('negative controls on code the shipped packages take from others: in the bundle without its notice, or missing from the doc, each fail', () => {
    const problems = (change: Partial<ScanInput>): string[] => scanLicences({ ...input, ...change }).problems;
    // earcut is left out of the build today. Were its code in the bundle, its notice would be needed.
    expect(/\bfunction earcutLinked\b/.test(input.bundle.code)).toBe(false);
    expect(problems({ bundle: { ...input.bundle, code: `${input.bundle.code}\nfunction earcutLinked() {}` } })).toEqual(['public/third-party-notices.txt has no entry for earcut.']);
    expect(problems({ notices: notices.replace(/^-{78}\nUZIP\.js [\s\S]*?(?=^-{78}\nMathGeoLib )/m, '') })).toEqual(['public/third-party-notices.txt has no entry for UZIP.js.']);
    expect(problems({ thirdParty: inDoc(/^\| MathGeoLib \|.*\n/m, '') })).toEqual([`The bundle holds MathGeoLib's code, inside three-mesh-bvh, which docs/THIRD_PARTY.md's "${BORROWED_TABLE}" table lacks.`]);
    expect(problems({ notices: inEntry(notices, 'gl-matrix', /\nCopyright \(c\) 2015-2025, Brandon Jones, Colin MacKenzie IV\.\n/g, '\n') })).toEqual(['public/third-party-notices.txt\'s entry for gl-matrix lacks "Copyright (c) 2015-2025, Brandon Jones, Colin MacKenzie IV.".']);
    expect(problems({ thirdParty: inDoc(/^(\| earcut \|.*\n)/m, '$1| delaunator | `three` | ISC | Mapbox | https://github.com/mapbox/delaunator | no |\n') })).toEqual([`docs/THIRD_PARTY.md's "${BORROWED_TABLE}" table lists delaunator, which the scan does not know: add it to BORROWED_CODE.`]);
  });
});

/** A small tree in npm ls's own shape, with each package's folder where npm would put it. */
const at = (name: string, version: string, license: string, dependencies: Record<string, NpmNode> = {}, base = '/fx'): NpmNode => ({ name, version, license, path: `${base}/node_modules/${name}`, dependencies });
/** Each row as "name version licence", where the licence may hold spaces, and an optional copyright after a bar. */
const docOf = (shipped: string[], installed: string[] = [], dev: string[] = ['tool 3.0.0 MIT']): string => {
  const cells = (row: string): string[] => {
    const [main, copyright = ''] = row.split(' | ');
    const [name, version, ...licence] = main.split(' ');
    return [name, version, licence.join(' '), copyright];
  };
  const table = (heading: string, rows: string[]): string => `## ${heading}\n\n| Package | Version | Licence | Copyright |\n|---|---|---|---|\n${rows.map((r) => `| ${cells(r).join(' | ')} |`).join('\n')}\n`;
  return [table(SHIPPED_TABLE, shipped), table(INSTALLED_TABLE, installed), table(DEV_TABLE, dev)].join('\n');
};
const scanFixture = (tree: NpmNode, ids: string[], thirdPartyDoc: string, dependencies: Record<string, string> = { lib: '1.0.0' }, virtual: string[] = []) =>
  scanLicences({ tree, dependencies, devDependencies: { tool: '3.0.0' }, bundle: { ids, virtual, code: '' }, thirdParty: thirdPartyDoc, notices: null, wasm: null });
const tool = (): NpmNode => at('tool', '3.0.0', 'MIT');

describe('the licence scan on fixture trees', () => {
  it('passes a permissive tree that the doc lists, and leaves a dev tool out of what ships', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT', { helper: at('helper', '1.2.0', 'ISC') }), tool: tool() } };
    const result = scanFixture(tree, ['/fx/node_modules/lib/index.js', '/fx/node_modules/helper/index.js', '/fx/src/main.ts'], docOf(['lib 1.0.0 MIT', 'helper 1.2.0 ISC']));
    expect(result.problems).toEqual([]);
    expect(result.shipped.map((p) => p.name)).toEqual(['helper', 'lib']);
    expect(result.devOnly.map((p) => p.name)).toEqual(['tool']);
  });

  it('fails on a GPL package that ships, even one the doc lists', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT', { gpl: at('gpl', '2.0.0', 'GPL-3.0-only') }), tool: tool() } };
    const result = scanFixture(tree, ['/fx/node_modules/lib/index.js', '/fx/node_modules/gpl/index.js'], docOf(['lib 1.0.0 MIT', 'gpl 2.0.0 GPL-3.0-only']));
    expect(result.problems).toEqual(['gpl 2.0.0 ships under GPL-3.0-only, a copyleft licence this app must not ship.']);
  });

  it('fails on GPL or AGPL anywhere in the production tree, as the plan says, even outside the bundle and listed', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT', { evil: at('evil', '1.0.0', 'AGPL-3.0-only'), lesser: at('lesser', '2.0.0', 'LGPL-3.0-or-later') }), tool: tool() } };
    const result = scanFixture(tree, ['/fx/node_modules/lib/index.js'], docOf(['lib 1.0.0 MIT'], ['evil 1.0.0 AGPL-3.0-only', 'lesser 2.0.0 LGPL-3.0-or-later']));
    expect(result.problems).toEqual(['evil 1.0.0 is installed for production under AGPL-3.0-only: the plan allows no GPL or AGPL in the production tree, even outside the bundle.']);
    expect(result.installedOnly.map((p) => p.name)).toEqual(['evil', 'lesser']);
    // A dev tool under the GPL is no production package, so the plan's check leaves it alone.
    const dev = { dependencies: { lib: at('lib', '1.0.0', 'MIT'), tool: at('tool', '3.0.0', 'GPL-2.0-only') } };
    expect(scanFixture(dev, ['/fx/node_modules/lib/index.js'], docOf(['lib 1.0.0 MIT'], [], ['tool 3.0.0 GPL-2.0-only'])).problems).toEqual([]);
  });

  it('fails on a shipped package missing from the doc, on another version or licence there, and on a row for what does not ship', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT', { helper: at('helper', '1.2.0', 'ISC') }), tool: tool() } };
    const ids = ['/fx/node_modules/lib/index.js', '/fx/node_modules/helper/index.js'];
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT'])).problems).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table lacks helper 1.2.0, which ships in the built app.`]);
    expect(scanFixture(tree, ids, docOf(['lib 0.9.0 MIT', 'helper 1.2.0 ISC'])).problems).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives lib as 0.9.0, but 1.0.0 is installed.`]);
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 ISC', 'helper 1.2.0 ISC'])).problems).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives lib's licence as ISC, but its package says MIT.`]);
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT', 'helper 1.2.0 ISC', 'gone 1.0.0 MIT'])).problems).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table lists gone 1.0.0, which does not ship.`]);
  });

  it('matches rows by name and version, so two shipped versions of a package each need their own row', () => {
    const tree = { dependencies: { dup: at('dup', '1.0.0', 'MIT'), lib: at('lib', '1.0.0', 'MIT', { dup: { name: 'dup', version: '2.0.0', license: 'MIT', path: '/fx/node_modules/lib/node_modules/dup' } }), tool: tool() } };
    const ids = ['/fx/node_modules/lib/index.js', '/fx/node_modules/dup/index.js', '/fx/node_modules/lib/node_modules/dup/index.js'];
    const deps = { lib: '1.0.0', dup: '1.0.0' };
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT', 'dup 1.0.0 MIT', 'dup 2.0.0 MIT']), deps).problems).toEqual([]);
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT', 'dup 1.0.0 MIT']), deps).problems).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table lacks dup 2.0.0, which ships in the built app.`]);
  });

  it('fails on the development table lacking a tool, giving another version, or listing one that is no devDependency', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT'), tool: tool() } };
    const ids = ['/fx/node_modules/lib/index.js'];
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT'], [], [])).problems).toEqual([`docs/THIRD_PARTY.md's "${DEV_TABLE}" table lacks tool 3.0.0, which is a direct devDependency.`]);
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT'], [], ['tool 2.0.0 MIT'])).problems).toEqual([`docs/THIRD_PARTY.md's "${DEV_TABLE}" table gives tool as 2.0.0, but 3.0.0 is installed.`]);
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT'], [], ['tool 3.0.0 MIT', 'other 1.0.0 MIT'])).problems).toEqual([`docs/THIRD_PARTY.md's "${DEV_TABLE}" table lists other 1.0.0, which is no direct devDependency.`]);
  });

  it('fails on a licence nobody reviewed, or none at all, in what ships', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'SEE LICENSE IN LICENSE.txt', { bare: at('bare', '0.1.0', '') }), tool: tool() } };
    const result = scanFixture(tree, ['/fx/node_modules/lib/a.js', '/fx/node_modules/bare/b.js'], docOf(['lib 1.0.0 SEE LICENSE IN LICENSE.txt', 'bare 0.1.0 ']));
    expect(result.problems).toEqual([
      'bare 0.1.0 ships under no stated licence, which has not been reviewed: check it by hand before shipping.',
      'lib 1.0.0 ships under "SEE LICENSE IN LICENSE.txt", which has not been reviewed: check it by hand before shipping.',
    ]);
  });

  it('a copyleft package the production tree installs but the bundle never holds is listed, not shipped, as manifold-3d\'s libvips is', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT', { native: at('native', '1.3.4', 'LGPL-3.0-or-later') }), tool: tool() } };
    const ids = ['/fx/node_modules/lib/index.js'];
    const result = scanFixture(tree, ids, docOf(['lib 1.0.0 MIT'], ['native 1.3.4 LGPL-3.0-or-later']));
    expect(result.problems).toEqual([]);
    expect(result.installedOnly.map((p) => p.name)).toEqual(['native']);
    // The same package in the bundle fails, and so does leaving it out of the doc's list.
    expect(scanFixture(tree, [...ids, '/fx/node_modules/native/index.js'], docOf(['lib 1.0.0 MIT', 'native 1.3.4 LGPL-3.0-or-later'])).problems).toEqual(['native 1.3.4 ships under LGPL-3.0-or-later, a copyleft licence this app must not ship.']);
    expect(scanFixture(tree, ids, docOf(['lib 1.0.0 MIT'])).problems).toEqual([`docs/THIRD_PARTY.md's "${INSTALLED_TABLE}" table lacks native 1.3.4, which is installed for production outside the bundle.`]);
  });

  it('fails when the bundle holds a dev-only package, or none of a dependency, which would mean the bundle was misread', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT'), tool: tool() } };
    expect(scanFixture(tree, ['/fx/node_modules/lib/index.js', '/fx/node_modules/tool/x.js'], docOf(['lib 1.0.0 MIT', 'tool 3.0.0 MIT'])).problems).toEqual(['tool 3.0.0 is in the bundle but is no production dependency: move it to "dependencies" or stop importing it.']);
    expect(scanFixture(tree, ['/fx/src/main.ts'], docOf([], ['lib 1.0.0 MIT'])).problems).toEqual(["lib is in package.json's dependencies but the bundle holds none of it."]);
  });

  it('fails on a dependency not installed, a bundled file no package owns, and build tool code it does not know', () => {
    const tree = { dependencies: { lib: at('lib', '1.0.0', 'MIT'), tool: tool() } };
    const doc = docOf(['lib 1.0.0 MIT']);
    expect(scanFixture(tree, ['/fx/node_modules/lib/index.js'], doc, { lib: '1.0.0', missing: '2.0.0' }).problems).toEqual(["missing is in package.json's dependencies but not installed: run scripts/install.sh."]);
    expect(scanFixture(tree, ['/fx/node_modules/lib/index.js', '/fx/node_modules/ghost/index.js'], doc).problems).toEqual(['The bundle holds /fx/node_modules/ghost/index.js, which no installed package owns.']);
    expect(scanFixture(tree, ['/fx/node_modules/lib/index.js'], doc, undefined, ['\0some-plugin/x.js']).problems).toEqual([
      'The bundle holds the build tool module "\\u0000some-plugin/x.js", which the scan does not know: find out whose code it is and under which licence, then add it to BUILD_TOOL_MODULES with the package it comes from.',
    ]);
    // Vite's module preload polyfill is off in vite.config.ts; were it back, it would need a review.
    expect(scanFixture(tree, ['/fx/node_modules/lib/index.js'], doc, undefined, ['\0vite/modulepreload-polyfill.js']).problems).toHaveLength(1);
  });
});

describe('the licence scan on packages with real folders', () => {
  const base = mkdtempSync(join(tmpdir(), 'cfg-licences-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const RULE = '-'.repeat(78);
  /** A package folder holding the given files. */
  const folder = (name: string, files: Record<string, string>): void => {
    mkdirSync(join(base, 'node_modules', name), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(base, 'node_modules', name, file), text);
  };
  const mit = (holder: string): string => `MIT License\n\nCopyright (c) 2020 ${holder}\n\n${MIT_TERMS}\n`;
  folder('lib', { 'LICENSE': mit('Lib Author') });
  folder('dual', { 'LICENSE-MIT': mit('Dual Author'), 'index.js': '' });
  folder('bare', { 'README.md': 'MIT, see package.json' });
  const entry = (title: string, licence: string, copyright: string, text: string): string => `${RULE}\n${title}\nLicence: ${licence}\n${copyright}\n${RULE}\n\n${text}\n\n`;
  const scan = (names: string[], noticesText: string, doc = docOf(names.map((n) => `${n} 1.0.0 MIT | Copyright (c) 2020 ${n === 'lib' ? 'Lib' : n === 'dual' ? 'Dual' : 'Bare'} Author`))) => {
    const tree = { dependencies: { ...Object.fromEntries(names.map((n) => [n, at(n, '1.0.0', 'MIT', {}, base)])), tool: tool() } };
    const ids = names.map((n) => `${base}/node_modules/${n}/index.js`);
    return scanLicences({ tree, dependencies: Object.fromEntries(names.map((n) => [n, '1.0.0'])), devDependencies: { tool: '3.0.0' }, bundle: { ids, virtual: [], code: '' }, thirdParty: doc, notices: noticesText, wasm: null }).problems;
  };

  it('passes a package whose entry holds its licence, and reads a LICENSE-MIT as well as a LICENSE', () => {
    expect(scan(['lib'], entry('lib 1.0.0', 'MIT', 'Copyright (c) 2020 Lib Author', mit('Lib Author')))).toEqual([]);
    expect(scan(['dual'], entry('dual 1.0.0', 'MIT', 'Copyright (c) 2020 Dual Author', mit('Dual Author')))).toEqual([]);
    expect(scan(['dual'], entry('dual 1.0.0', 'MIT', 'Copyright (c) 2020 Dual Author', '(nothing)'))).toEqual(["public/third-party-notices.txt's entry for dual lacks the text of its LICENSE-MIT."]);
  });

  it('fails on a shipped package with no entry, with no licence file, or whose doc row gives another copyright', () => {
    expect(scan(['lib'], '')).toEqual(['public/third-party-notices.txt has no entry headed "lib 1.0.0".']);
    expect(scan(['bare'], entry('bare 1.0.0', 'MIT', 'Copyright (c) 2020 Bare Author', mit('Bare Author')))).toEqual(['bare 1.0.0 has no licence file in its folder: read its licence by hand, and add its text to the notices and a reviewed exception to the scan.']);
    expect(scan(['lib'], entry('lib 1.0.0', 'MIT', 'Copyright (c) 2020 Lib Author', mit('Lib Author')), docOf(['lib 1.0.0 MIT | Someone else']))).toEqual([`docs/THIRD_PARTY.md's "${SHIPPED_TABLE}" table gives lib's copyright as "Someone else", but its licence says "Copyright (c) 2020 Lib Author".`]);
  });
});

describe('licence expressions', () => {
  it.each([
    ['MIT', 'permissive'],
    ['Apache-2.0 WITH LLVM-exception', 'permissive'],
    ['(MIT OR GPL-3.0-only)', 'permissive'],
    ['MIT AND ISC', 'permissive'],
    ['GPL-2.0-only', 'copyleft'],
    ['AGPL-3.0-or-later', 'copyleft'],
    ['LGPL-3.0-or-later', 'copyleft'],
    ['SSPL-1.0', 'copyleft'],
    ['MIT AND GPL-2.0-only', 'copyleft'],
    ['GPL-3.0-only AND (MIT OR ISC)', 'copyleft'],
    ['MPL-2.0', 'unknown'],
    ['UNLICENSED', 'unknown'],
    ['SEE LICENSE IN LICENSE.txt', 'unknown'],
    ['', 'unknown'],
  ])('%j is %s', (expression, kind) => {
    expect(classifyLicence(expression)).toBe(kind);
  });

  it.each([
    ['GPL-3.0-only', true],
    ['AGPL-3.0-or-later', true],
    ['GPL-2.0 WITH Classpath-exception-2.0', true],
    ['MIT AND GPL-2.0-only', true],
    ['GPL-2.0-only OR AGPL-3.0-only', true],
    ['(MIT OR GPL-3.0-only) AND ISC', true],
    ['LGPL-3.0-or-later', false],
    ['MIT OR GPL-3.0-only', false],
    ['MPL-2.0', false],
    ['', false],
  ])('%j binds to GPL or AGPL: %s', (expression, gpl) => {
    expect(needsGpl(expression)).toBe(gpl);
  });
});
