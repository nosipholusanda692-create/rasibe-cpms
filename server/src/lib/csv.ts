/**
 * CSV for files a person will open in a spreadsheet (RFC 4180).
 *
 * Two things go wrong with naive joining. A quote or comma inside a value
 * breaks the columns. And a value that begins with = + - @ or a tab is run as a
 * formula when the file is opened: a client called =HYPERLINK("http://...")
 * becomes a link on the bookkeeper's machine (CSV injection, CWE-1236). Such a
 * value is prefixed with an apostrophe, the OWASP remedy, so it is shown as
 * text instead.
 *
 * Numbers are left alone, including negative ones: a credit note's -8.00 is a
 * number, not a formula, and must stay summable.
 */

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (NUMBER.test(text)) return text;

  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** A header row and data rows, CRLF-separated, with a BOM so Excel reads UTF-8. */
export function csvDocument(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
