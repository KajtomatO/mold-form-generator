/**
 * Reads the requirement map in docs/REQUIREMENTS.md: section 3's Check column, which names test
 * files, titles within them, and the user checks that section 10 lists.
 */

/** The text of `## <number>. ...` up to the next `## ` heading, or null without one. */
export function section(markdown: string, number: number): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${number}. `));
  if (start < 0) return null;
  const end = lines.findIndex((line, k) => k > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The rows of the tables in a section, header and separator rows left out, as trimmed cells. */
export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  let header = true;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) {
      header = true;
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (header) header = false;
    else rows.push(cells);
  }
  return rows;
}

export interface CheckCell {
  /** Test files with the titles, or parts of titles, the row names in each. */
  files: { file: string; titles: string[] }[];
  /** User checks by their id in section 10, such as U3. */
  users: string[];
  /** Items that are neither, which the map cannot read. */
  unreadable: string[];
}

/**
 * One Check cell: items split by semicolons, each a backticked test file with quoted titles after
 * it, as `test/unit/x.test.ts` "a title", "another", or a user check's id alone.
 */
export function parseCheckCell(cell: string): CheckCell {
  const parsed: CheckCell = { files: [], users: [], unreadable: [] };
  for (const item of cell.split(';').map((part) => part.trim()).filter(Boolean)) {
    const file = /^`([^`]+)`(.*)$/.exec(item);
    if (file) {
      const titles = [...file[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (file[2].replace(/"[^"]+"/g, '').replace(/,/g, '').trim() !== '') parsed.unreadable.push(item);
      else parsed.files.push({ file: file[1], titles });
    } else if (/^U\d+$/.test(item)) parsed.users.push(item);
    else parsed.unreadable.push(item);
  }
  return parsed;
}

/** A string literal in a source file: its text, escapes read and template placeholders kept as written, and where its quotes stand. */
interface Literal {
  text: string;
  start: number;
  end: number;
}

/**
 * Every string literal in a TypeScript file, and which characters are code: not inside a literal, a
 * comment or a regular expression, so brackets can be matched over code alone.
 */
function scan(source: string): { literals: Literal[]; code: boolean[] } {
  const literals: Literal[] = [];
  const code = new Array<boolean>(source.length).fill(true);
  const mark = (from: number, to: number): void => {
    for (let k = from; k < Math.min(to, source.length); k++) code[k] = false;
  };
  let k = 0;
  // The last character that was not space: a slash after one of these starts a regular expression.
  let last = '';
  while (k < source.length) {
    const c = source[k];
    if (c === '/' && source[k + 1] === '/') {
      const end = source.indexOf('\n', k);
      mark(k, end < 0 ? source.length : end);
      k = end < 0 ? source.length : end;
      continue;
    }
    if (c === '/' && source[k + 1] === '*') {
      const end = source.indexOf('*/', k + 2);
      mark(k, end < 0 ? source.length : end + 2);
      k = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
      const start = k;
      let inClass = false;
      for (k++; k < source.length && source[k] !== '\n' && (source[k] !== '/' || inClass); k++) {
        if (source[k] === '\\') k++;
        else if (source[k] === '[') inClass = true;
        else if (source[k] === ']') inClass = false;
      }
      k++;
      mark(start, k);
      last = 'x';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = k;
      let text = '';
      for (k++; k < source.length && source[k] !== c; ) {
        if (source[k] === '\\') {
          text += source[k + 1] ?? '';
          k += 2;
        } else if (c === '`' && source[k] === '$' && source[k + 1] === '{') {
          const from = k;
          let depth = 0;
          do {
            if (source[k] === '{') depth++;
            else if (source[k] === '}') depth--;
            k++;
          } while (k < source.length && depth > 0);
          text += source.slice(from, k);
        } else text += source[k++];
      }
      k++;
      mark(start, k);
      literals.push({ text, start, end: k });
      last = 'x';
      continue;
    }
    if (!/\s/.test(c)) last = c;
    k++;
  }
  return { literals, code };
}

/** Every string literal in a TypeScript file, with nothing from comments. */
export function stringLiterals(source: string): string[] {
  return scan(source).literals.map((l) => l.text);
}

/** Vitest's and Playwright's functions that take a test's or a group's title first. */
const TEST_CALLS = new Set(['it', 'test', 'describe', 'suite', 'bench']);

/**
 * The titles a test file gives its tests and groups, and the names of the checks in the tables that
 * `.each` titles them from: a string literal counts only as the first argument of it, test or describe
 * (with any of their forms, such as `it.each(rows)` or `test.describe.serial`), or inside the table an
 * `.each` reads, given in place or by the name of a constant in the same file. A title left only in an
 * assertion's message, a fixture's text or a comment is none.
 */
export function testTitles(source: string): string[] {
  const { literals, code } = scan(source);
  const isSpace = (k: number): boolean => !code[k] || /\s/.test(source[k]);
  const back = (k: number): number => {
    while (k >= 0 && isSpace(k)) k--;
    return k;
  };
  /** The bracket that opens the one closing at `close`, over code only. */
  const opening = (close: number): number => {
    let depth = 0;
    for (let k = close; k >= 0; k--) {
      if (!code[k]) continue;
      if (source[k] === ')' || source[k] === ']' || source[k] === '}') depth++;
      else if (source[k] === '(' || source[k] === '[' || source[k] === '{') depth--;
      if (depth === 0) return k;
    }
    return -1;
  };
  const closing = (open: number): number => {
    let depth = 0;
    for (let k = open; k < source.length; k++) {
      if (!code[k]) continue;
      if (source[k] === '(' || source[k] === '[' || source[k] === '{') depth++;
      else if (source[k] === ')' || source[k] === ']' || source[k] === '}') depth--;
      if (depth === 0) return k;
    }
    return source.length;
  };
  const inside = (from: number, to: number): Literal[] => literals.filter((l) => l.start > from && l.end <= to);

  const titles: string[] = [];
  const tables: [number, number][] = [];
  for (const literal of literals) {
    let k = back(literal.start - 1);
    if (source[k] !== '(') continue;
    // Read the callee back from its "(": names joined by dots, with calls such as .each(rows) between.
    const chain: string[] = [];
    const eachCalls: [number, number][] = [];
    let call: [number, number] | null = null;
    k = back(k - 1);
    while (k >= 0) {
      if (source[k] === ')') {
        const open = opening(k);
        if (open < 0) break;
        call = [open, k];
        k = back(open - 1);
        continue;
      }
      if (!/[\w$]/.test(source[k])) break;
      let start = k;
      while (start > 0 && /[\w$]/.test(source[start - 1]) && code[start - 1]) start--;
      const name = source.slice(start, k + 1);
      chain.unshift(name);
      if (call && (name === 'each' || name === 'for')) eachCalls.push(call);
      call = null;
      k = back(start - 1);
      if (source[k] !== '.') break;
      k = back(k - 1);
    }
    if (chain.length === 0 || !TEST_CALLS.has(chain[0])) continue;
    titles.push(literal.text);
    tables.push(...eachCalls);
  }

  // The names in each table: its literals, and those of the constants it names, followed down.
  const seen = new Set<string>();
  const follow = (from: number, to: number, depth: number): void => {
    for (const l of inside(from, to)) titles.push(l.text);
    if (depth === 0) return;
    const text = [...source.slice(from, to)].map((ch, j) => (code[from + j] ? ch : ' ')).join('');
    for (const [name] of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const declared = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b`).exec(source);
      if (!declared || !code[declared.index]) continue;
      // The "=" of the declaration, past any type, whose arrows hold "=" too.
      let k = declared.index + declared[0].length;
      while (k < source.length && !(code[k] && source[k] === '=' && source[k + 1] !== '>' && source[k + 1] !== '=')) {
        if (code[k] && '([{'.includes(source[k])) k = closing(k);
        k++;
      }
      k++;
      while (k < source.length && /\s/.test(source[k])) k++;
      const end = '([{'.includes(source[k]) ? closing(k) : source.indexOf('\n', k);
      follow(k - 1, end < 0 ? source.length : end, depth - 1);
    }
  };
  for (const [open, close] of tables) follow(open, close, 3);
  return titles;
}

/** The ids R01 to R36, as section 3 must list them. */
export const REQUIREMENT_IDS = Array.from({ length: 36 }, (_, k) => `R${String(k + 1).padStart(2, '0')}`);

/**
 * What is wrong with the map, in words that say what to fix; empty when every requirement maps to
 * test files that exist with the titles named, or to user checks section 10 lists, and the two
 * sections agree on which user check covers which requirement. `read` gives a repository file's
 * text, or null when it does not exist.
 */
export function mapProblems(requirements: string, read: (path: string) => string | null): string[] {
  const problems: string[] = [];
  const table = section(requirements, 3);
  const matrix = section(requirements, 10);
  if (!table) return ['docs/REQUIREMENTS.md has no section 3.'];
  if (!matrix) return ['docs/REQUIREMENTS.md has no section 10.'];
  const rows = tableRows(table);
  const ids = rows.map((cells) => cells[0]);
  if (ids.join() !== REQUIREMENT_IDS.join()) problems.push(`Section 3 lists ${ids.join(', ')}, not R01 to R36 in order.`);

  // Section 10: each user check with the requirements it covers.
  const users = new Map(tableRows(matrix).filter((cells) => /^U\d+$/.test(cells[0])).map((cells) => [cells[0], new Set(cells[2]?.match(/R\d\d/g) ?? [])]));
  if (users.size === 0) problems.push('Section 10 has no table of user checks.');

  // Each file's titles and check names, read once; null for a file that does not exist.
  const names = new Map<string, string[] | null>();
  for (const cells of rows) {
    const id = cells[0];
    const cell = parseCheckCell(cells[cells.length - 1] ?? '');
    if (cell.files.length === 0 && cell.users.length === 0) problems.push(`${id} names no check: give it a test file or a user check from section 10.`);
    for (const item of cell.unreadable) problems.push(`${id}: "${item}" is neither a backticked test file with quoted titles nor a user check's id.`);
    for (const { file, titles } of cell.files) {
      if (!/^(test|e2e)\/.+\.(test|spec)\.ts$/.test(file)) {
        problems.push(`${id}: ${file} is not a test file under test/ or e2e/.`);
        continue;
      }
      if (!names.has(file)) {
        const source = read(file);
        names.set(file, source === null ? null : testTitles(source));
      }
      const strings = names.get(file);
      if (!strings) {
        problems.push(`${id}: ${file} does not exist.`);
        continue;
      }
      // A file alone says nothing a rename could break, so each needs a title.
      if (titles.length === 0) problems.push(`${id}: ${file} names no title: quote the tests in it that check ${id}.`);
      for (const title of titles) if (!strings.some((text) => text.includes(title))) problems.push(`${id}: no test title or check name in ${file} holds "${title}".`);
    }
    for (const user of cell.users) {
      if (!users.has(user)) problems.push(`${id}: user check ${user} is not in section 10.`);
      else if (!users.get(user)!.has(id)) problems.push(`${id} names ${user}, but section 10 does not list ${id} under it.`);
    }
  }
  for (const [user, covered] of users) {
    for (const id of covered) {
      const row = rows.find((cells) => cells[0] === id);
      if (!row || !parseCheckCell(row[row.length - 1]).users.includes(user)) problems.push(`Section 10 lists ${id} under ${user}, but ${id}'s row does not name ${user}.`);
    }
  }
  return problems;
}
