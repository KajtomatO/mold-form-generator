/**
 * Plain text for the README files in an export ZIP, which makers open in any editor, Windows Notepad
 * among them: plain ASCII, short lines, and CRLF line endings.
 */

/** Lines are kept short for any editor, and end in CRLF, so Windows Notepad shows them as they are. */
export const WIDTH = 76;
export const EOL = '\r\n';

/** Letters that keep no plain form when their accents come off: l and L with a stroke, o slash, d bar, sharp s, ae, oe. */
const PLAIN_LETTERS: Record<string, string> = {
  'ł': 'l', 'Ł': 'L', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D',
  'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
};

/**
 * Text as plain ASCII: a model's file name can hold any letter, as Polish ones do. Accents come off,
 * and what still has no ASCII form becomes '?'.
 */
export function ascii(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, (c) => PLAIN_LETTERS[c] ?? (/\s/.test(c) ? ' ' : '?'));
}

/**
 * Words to lines of at most WIDTH, the first after `first`, the rest after `rest`, in plain ASCII. A word
 * longer than a whole line, such as a long file name, is broken where the line ends.
 */
export function wrap(text: string, first = '', rest = first): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  const next = (): void => {
    lines.push(line);
    line = rest;
    empty = true;
  };
  for (const word of ascii(text).split(/\s+/).filter(Boolean)) {
    let left = word;
    while (left.length > 0) {
      const room = WIDTH - line.length - (empty ? 0 : 1);
      if (left.length <= room) {
        line += (empty ? '' : ' ') + left;
        empty = false;
        break;
      }
      if (!empty && (left.length <= WIDTH - rest.length || room <= 0)) {
        next();
        continue;
      }
      line += (empty ? '' : ' ') + left.slice(0, room);
      left = left.slice(room);
      next();
    }
  }
  lines.push(line);
  return lines;
}

