import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoldSteps, VERDICT_WORDS } from '../../src/core/analysis/reports';
import { SPRUE_RULE, VACUUM_NOTE } from '../../src/core/report/readme';
import { defaultParams } from '../../src/core/params/defaults';
import { mapProblems, REQUIREMENT_IDS, section, tableRows } from '../fixtures/requirementMap';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string | null => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
const doc = (path: string): string => readFileSync(join(root, path), 'utf8');
const requirements = doc('docs/REQUIREMENTS.md');
/** Lower case with whitespace folded, so a phrase may wrap or start a sentence. */
const folded = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');
const missing = (text: string, phrases: string[]): string[] => phrases.filter((phrase) => !folded(text).includes(folded(phrase)));

describe('the requirement map in docs/REQUIREMENTS.md', () => {
  it('maps every requirement R01 to R31 to test files and titles that exist, or to user checks section 10 lists', () => {
    expect(mapProblems(requirements, read)).toEqual([]);
  });

  it('negative controls: no check, a missing file, a renamed title, one left only in a comment or a message, a file outside the tests or no test file, a file with no title, an unknown user check and the two tables disagreeing each fail', () => {
    // A regular expression with quotes in it comes first, so the scan of string literals must step over it.
    const files: Record<string, string> = {
      'test/unit/a.test.ts': [
        "const re = /it\\('x'/;",
        "// it('old words', ...) was renamed",
        "it('reads the field at the export cell', () => {",
        "  expect(cells, 'words in a message').toBe(2);",
        "  check('words in a fixture');",
        "});",
        "const CHECKS: [string, (n: number) => void][] = [['the box is closed', check]];",
        "it.each(CHECKS)('%s', () => {});",
        "test.describe.serial('@smoke a group of tests', () => {});",
      ].join('\n'),
      'test/fixtures/helper.ts': "export const TITLE = 'reads the field';",
    };
    const fake = (change: (rows: Map<string, string>) => void, users = '| U1 | Print it | R02 | here |'): string => {
      const rows = new Map(REQUIREMENT_IDS.map((id) => [id, '`test/unit/a.test.ts` "reads the field"']));
      rows.set('R02', '`test/unit/a.test.ts` "the box is closed"; U1');
      change(rows);
      const table = [...rows].map(([id, check]) => `| ${id} | text | kept | | ${check} |`).join('\n');
      return `## 3. Requirement table\n\n| ID | Requirement | Status | Decision | Check |\n|---|---|---|---|---|\n${table}\n\n## 10. Verification matrix\n\n| ID | Check | Requirements | How |\n|---|---|---|---|\n${users}\n`;
    };
    const problems = (change: (rows: Map<string, string>) => void, users?: string): string[] => mapProblems(fake(change, users), (path) => files[path] ?? null);
    expect(problems(() => {})).toEqual([]);
    expect(problems((rows) => rows.set('R05', ''))).toEqual(['R05 names no check: give it a test file or a user check from section 10.']);
    expect(problems((rows) => rows.set('R06', '`test/unit/gone.test.ts` "reads the field"'))).toEqual(['R06: test/unit/gone.test.ts does not exist.']);
    expect(problems((rows) => rows.set('R07', '`test/unit/a.test.ts` "renamed words"'))).toEqual(['R07: no test title or check name in test/unit/a.test.ts holds "renamed words".']);
    expect(problems((rows) => rows.set('R07', '`test/unit/a.test.ts` "old words"'))).toEqual(['R07: no test title or check name in test/unit/a.test.ts holds "old words".']);
    expect(problems((rows) => rows.set('R07', '`test/unit/a.test.ts` "words in a message"'))).toEqual(['R07: no test title or check name in test/unit/a.test.ts holds "words in a message".']);
    expect(problems((rows) => rows.set('R07', '`test/unit/a.test.ts` "words in a fixture"'))).toEqual(['R07: no test title or check name in test/unit/a.test.ts holds "words in a fixture".']);
    expect(problems((rows) => rows.set('R07', '`test/unit/a.test.ts` "a group of tests"'))).toEqual([]);
    expect(problems((rows) => rows.set('R08', '`test/fixtures/helper.ts` "reads the field"'))).toEqual(['R08: test/fixtures/helper.ts is not a test file under test/ or e2e/.']);
    expect(problems((rows) => rows.set('R08', '`test/unit/a.test.ts`'))).toEqual(['R08: test/unit/a.test.ts names no title: quote the tests in it that check R08.']);
    expect(problems((rows) => rows.set('R09', '`docs/WORKFLOW.md`'))).toEqual(['R09: docs/WORKFLOW.md is not a test file under test/ or e2e/.']);
    expect(problems((rows) => rows.set('R10', '`test/unit/a.test.ts` "reads the field"; U9'))).toEqual(['R10: user check U9 is not in section 10.']);
    expect(problems((rows) => rows.set('R11', 'U1'))).toEqual(['R11 names U1, but section 10 does not list R11 under it.']);
    expect(problems((rows) => rows.set('R02', '`test/unit/a.test.ts` "the box is closed"'))).toEqual(["Section 10 lists R02 under U1, but R02's row does not name U1."]);
    expect(problems((rows) => rows.set('R12', '`test/unit/a.test.ts` "reads the field"; M3 cover checks'))).toEqual(['R12: "M3 cover checks" is neither a backticked test file with quoted titles nor a user check\'s id.']);
    expect(problems((rows) => rows.delete('R31'))).toEqual([expect.stringMatching(/^Section 3 lists R01, .*, R30, not R01 to R31 in order\.$/)]);
  });

  it('section 10 is the fixed list of user checks, and every one covers a requirement', () => {
    const users = tableRows(section(requirements, 10)!).filter((cells) => /^U\d+$/.test(cells[0]));
    expect(users.map((cells) => cells[0])).toEqual(['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7']);
    for (const cells of users) expect(cells[2], cells[0]).toMatch(/^R\d\d(, R\d\d)*$/);
  });

  it('records the decisions D1 to D9 with what each changed, and keeps the open items open', () => {
    const decisions = tableRows(section(requirements, 4)!).filter((cells) => /^D\d$/.test(cells[0]));
    expect(decisions.map((cells) => cells[0])).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']);
    for (const cells of decisions) expect(cells[1].length, cells[0]).toBeGreaterThan(20);
    const open = tableRows(section(requirements, 9)!);
    // The M11a memory deviation and the physical unknowns are the user's to settle, and stay open until they do.
    expect(open.find((cells) => cells[0].includes('peak RSS'))?.[2]).toMatch(/^open/);
    expect(open.find((cells) => cells[0].includes('Whether 3 mm holds up'))?.[2]).toMatch(/^open/);
  });
});

describe('the docs', () => {
  it("docs/WORKFLOW.md covers what the plan's M11 check names, in the words README.txt and the Demold report use", () => {
    const workflow = doc('docs/WORKFLOW.md');
    expect(
      missing(workflow, [
        // The D2 sequence, in README.txt's own words.
        'slide the silicone out of the cover with the model still in it',
        'put the silicone back into the cover, the way it came out',
        ...Object.values(VERDICT_WORDS),
        'places marked **Cut** first',
        'Demold report',
        // The sprue rule, as README.txt and the demold steps give it.
        'cut each pour sprue at the floor of its seat, where the cone meets the straight bore, not flush with the top',
        'when you pour without a funnel',
        // Sealing, with tape, petroleum jelly or the bolts, and the leak test before the model is glued in.
        'petroleum jelly (Vaseline) in the groove',
        'It helps the joint seal, and the leak test shows whether your joint needs more',
        'corner first',
        'until snug, and no more',
        'tape across the middle',
        'Tape strip holds under Advanced, Printer (10 N by default)',
        'Leak test with water before the first pour',
        'Do this once before the model is glued in',
        'take the mold apart, and let the parts dry fully',
        'the joint takes more in the real pour than in this test',
        // The air the vents cannot reach, with the first coat brushed on while the model can be reached.
        'while the model can still be reached: mix a small batch of silicone and brush a first coat of silicone onto the model there',
        'Then close the mold and pour the rest',
        // The vacuum note: in the cup, if you have one, and on the filled mold only after a test.
        'Degas in the cup,** if you have a vacuum chamber',
        'To degas the filled mold in a vacuum is untested for printed molds',
        'first fill a fit-test pair with silicone, put it under vacuum',
        'rises slowly and evenly',
        // Cure inhibition and the test patch.
        'cure inhibition',
        'platinum-cure',
        'test patch',
        'a glue that passed the test patch',
        // Mode A for models on several footprints.
        'Use Mode A for a model that stands on several footprints, such as the wolf',
        // The app: a model open first, the fit test, then Export ZIP after the clearances; diag.html's limits.
        'Open your STL with Open STL or project',
        'Check the base face',
        'it stays off until a model is open',
        'click Export ZIP under Export',
        'Whenever you change a setting, the clearances among them, export again',
        "It builds the pairs at the app's default settings, apart from the taper clearance you type there, and it has no bolt coupon",
        'The report shows the first six places',
        // Printing: poses, no supports, whole layers, the base proud, the fit test and the bolt coupon.
        'Do not flip a part over',
        'Turn supports off',
        'whole number of layers',
        'the base stands 0.2 mm proud',
        'tightest pair whose base seats fully',
        'bolt coupon',
        // The finished mold, and what only the user can find out.
        "the cover's flat top is now the bottom of your mold",
        'Whether 3 mm of silicone holds up in use',
      ]),
    ).toEqual([]);
    // The steps README.txt and the Demold report give hold the same words, for each verdict, so a change to them shows here.
    const steps = (verdict: Parameters<typeof demoldSteps>[0]): string => folded(demoldSteps(verdict, defaultParams()).join(' '));
    const shared = {
      'cut-required': ['slide the silicone out of the cover with the model still in it', 'The cover widens towards the base, so the silicone slides out that way', 'in a wavy line so the cut faces line up again', 'put the silicone back into the cover, the way it came out'],
      'jacket-out': ['slide the silicone out of the cover with the model still in it', 'Stretch the silicone off the model where it holds', 'only where it would tear', 'Take out the model'],
      plausible: ['while the silicone stays in the cover', 'If the model holds, slide the silicone out of the cover with the model in it, flex the silicone to free the model, and put the silicone back into the cover the way it came out'],
    } as const;
    for (const [verdict, phrases] of Object.entries(shared)) {
      expect(missing(steps(verdict as keyof typeof shared), [...phrases]), verdict).toEqual([]);
      expect(missing(workflow, [...phrases]), verdict).toEqual([]);
    }
    expect(steps('cut-required')).toContain(folded('at the floor of its seat, where the cone meets the straight bore'));
    // README.txt's sprue rule and its vacuum note say what WORKFLOW.md says.
    for (const phrase of ['at the floor of the seat, where the cone meets the straight bore', 'not flush with the top', 'A cone of silicone left in the seat is wider than the bore under it, so it would lock the mold in the cover', 'fills the cone-shaped seat']) {
      expect(folded(SPRUE_RULE), phrase).toContain(folded(phrase));
      expect(folded(workflow), phrase).toContain(folded(phrase.replace('the seat, where', 'its seat, where')));
    }
    for (const phrase of ['untested on printed molds', 'come through', 'fit-test pair', 'bubbles at its walls']) {
      expect(folded(VACUUM_NOTE), phrase).toContain(folded(phrase));
    }
    expect(missing(workflow, ['untested for printed molds', 'come through into the silicone', 'fit-test pair', 'for bubbles'])).toEqual([]);
  });

  it('section 7 points to docs/WORKFLOW.md, and README.md names every doc and says no licence is chosen', () => {
    const seven = section(requirements, 7)!;
    expect(seven).toContain('`docs/WORKFLOW.md` has the full workflow');
    expect(seven).not.toMatch(/will hold/);
    const readme = doc('README.md');
    expect(missing(readme, ['docs/WORKFLOW.md', 'docs/DEPLOY.md', 'docs/THIRD_PARTY.md', 'docs/REQUIREMENTS.md', 'docs/PLAN.md', 'docs/BENCHMARKS.md', 'No licence has been chosen'])).toEqual([]);
    for (const path of ['docs/WORKFLOW.md', 'docs/DEPLOY.md', 'docs/THIRD_PARTY.md', 'docs/BENCHMARKS.md', 'public/third-party-notices.txt']) expect(existsSync(join(root, path)), path).toBe(true);
  });

  it('docs/DEPLOY.md covers installing, serving, updating, other servers, plain http and the tests', () => {
    expect(
      missing(doc('docs/DEPLOY.md'), [
        'Node 24',
        'scripts/install.sh',
        'WITH_SYSTEM_DEPS=1',
        'scripts/serve.sh',
        'It has no git remote, so there is nothing to pull',
        'run `scripts/serve.sh` again',
        'nothing else should build into `dist/` while it runs',
        '--outDir ../cfg-static',
        'application/wasm',
        'module workers',
        'secure context',
        'Chrome',
        'If Chrome blocks the download',
        'Choose Keep',
        'ssh -N -L 5173:127.0.0.1:5173',
        'chrome://flags/#unsafely-treat-insecure-origin-as-secure',
        '2.9 to 3.0 GB',
        'about 3.5 GB of memory free',
        'bench.html',
        'scripts/ci.sh --full',
        'scripts/ci.sh --soak',
        'CFG_SHOTS=1',
        'xvfb',
      ]),
    ).toEqual([]);
  });
});

describe('the scripts and the repository', () => {
  it('scripts/install.sh needs Node 24 and runs sudo only with WITH_SYSTEM_DEPS=1, and both scripts parse', () => {
    for (const script of ['scripts/install.sh', 'scripts/serve.sh', 'scripts/ci.sh']) execFileSync('bash', ['-n', join(root, script)]);
    const source = doc('scripts/install.sh');
    const lines = source.split('\n');
    // The guard itself, which exits when the major version is under 24: a comment or a guard that never exits does not count.
    expect(source).toMatch(/^node -e 'process\.exit\(\+process\.versions\.node\.split\("\."\)\[0\] >= 24 \? 0 : 1\)' \|\| \{\n  echo "Node 24 or newer is required[^\n]*\n  exit 1\n\}$/m);
    // Root is needed only for system packages, and only when asked for.
    const start = lines.findIndex((line) => line.startsWith('if [ "${WITH_SYSTEM_DEPS:-0}" = "1" ]; then'));
    const end = lines.findIndex((line, k) => k > start && line === 'fi');
    expect(start).toBeGreaterThan(0);
    const outside = lines.filter((line, k) => (k < start || k > end) && !line.trim().startsWith('#'));
    expect(outside.filter((line) => /\bsudo\b|\bpkexec\b|\bdoas\b|\bsu\s+-c\b|install-deps|--with-deps|apt-get install/.test(line))).toEqual([]);
    expect(lines.slice(start, end).some((line) => /\bsudo\b/.test(line))).toBe(true);
  });

  it('scripts/serve.sh builds, then serves the build on every address at port 5173, and no other', () => {
    const commands = doc('scripts/serve.sh').split('\n').filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('set ') && !line.startsWith('cd '));
    expect(commands).toEqual(['npx vite build', 'exec npx vite preview --host 0.0.0.0 --port 5173 --strictPort']);
  });

  it('no commit message names Claude or Anthropic', () => {
    // D8: the user asked for no attribution in this repository's history.
    const messages = execFileSync('git', ['log', '--format=%H %B'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    expect(messages.trim().length).toBeGreaterThan(0);
    expect(messages.split('\n').filter((line) => /claude|anthropic/i.test(line))).toEqual([]);
  });
});
