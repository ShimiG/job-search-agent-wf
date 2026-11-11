import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';

/*
 * Can software read the CV back out of its PDF? An applicant tracking system doesn't look at the page:
 * it pulls the text out of the file, and what it gets is not always what you see. A font can draw a
 * character with a glyph that has no character behind it, so a word arrives with a hole in it; a layout
 * can hand the lines over in a different order than they're read.
 *
 * So after the PDF is made, its text is extracted the way a parser would and compared with what was put
 * on the page: every heading, line and bullet has to be there, character for character, in reading
 * order. Right-to-left text is stored in the file in the order it is drawn, so for Hebrew lines only
 * the characters are compared, not their order.
 */

/** The text a parser gets out of a PDF file, pages joined in order. */
export async function extractPdfText(file: string): Promise<string> {
  const { extractText } = await import('unpdf');
  const { text } = await extractText(new Uint8Array(readFileSync(file)), { mergePages: true });
  return text;
}

export interface PdfTextCheck {
  /** Pieces of text on the page that were looked for. */
  checked: number;
  /** Text that is on the page but not in what a parser reads. */
  missing: string[];
  /** Text a parser reads before the text that comes before it on the page. */
  outOfOrder: string[];
}

/** Every piece of text on the page, in the order it's read: one per heading, line, bullet. */
export function pageText(html: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  const walk = (node: unknown) => {
    const n = node as { type: string; data?: string; children?: unknown[]; name?: string };
    if (n.type === 'text') {
      const t = (n.data ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (n.name !== 'style' && n.name !== 'script') for (const c of n.children ?? []) walk(c);
  };
  for (const el of $('body').toArray()) walk(el);
  return out;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/** Compared without spacing (a parser's is its own), case (headings are drawn in capitals) or invisible marks. */
const squash = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s​-‏‪-‮⁦-⁩­]/g, '');
const lettersOnly = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');

/** Is there a run of `text` with exactly the characters of `piece`, in any order? */
function hasSameCharacters(text: string, piece: string): boolean {
  const want = [...piece];
  const chars = [...text];
  if (want.length === 0) return true;
  // For each character: how many more the window needs (negative: it has too many).
  const owed = new Map<string, number>();
  for (const ch of want) owed.set(ch, (owed.get(ch) ?? 0) + 1);
  let unsettled = owed.size;
  const move = (ch: string, by: number) => {
    const before = owed.get(ch) ?? 0;
    if (before === 0) unsettled++;
    if (before + by === 0) unsettled--;
    owed.set(ch, before + by);
  };
  for (let i = 0; i < chars.length; i++) {
    move(chars[i]!, -1);
    if (i >= want.length) move(chars[i - want.length]!, 1);
    if (i >= want.length - 1 && unsettled === 0) return true;
  }
  return false;
}

const quote = (s: string) => (s.length > 70 ? `${s.slice(0, 70)}…` : s);

/** Compares what a parser read (`extracted`) with what was put on the page (`pieces`, in reading order). */
export function checkPdfText(extracted: string, pieces: string[]): PdfTextCheck {
  const text = squash(extracted);
  const letters = lettersOnly(text);
  const result: PdfTextCheck = { checked: 0, missing: [], outOfOrder: [] };
  let cursor = 0;
  for (const piece of pieces) {
    const want = squash(piece);
    if (!lettersOnly(want)) continue;
    result.checked++;
    if (RTL.test(want)) {
      if (!hasSameCharacters(letters, lettersOnly(want))) result.missing.push(quote(piece));
      continue;
    }
    const at = text.indexOf(want, cursor);
    if (at >= 0) cursor = at + want.length;
    else if (text.includes(want)) result.outOfOrder.push(quote(piece));
    else result.missing.push(quote(piece));
  }
  return result;
}

export const pdfTextOk = (c: PdfTextCheck) => c.missing.length === 0 && c.outOfOrder.length === 0;

/** One line for the report and the review page. */
export function pdfTextMessage(c: PdfTextCheck): string {
  if (pdfTextOk(c)) return `All ${c.checked} lines of the CV read back out of the PDF as text, in order.`;
  const parts: string[] = [];
  if (c.missing.length) parts.push(`${c.missing.length} of ${c.checked} lines can't be read back out of the PDF as they appear on the page, so an applicant tracking system may not see them: ${c.missing.map((m) => `"${m}"`).join('; ')}`);
  if (c.outOfOrder.length) parts.push(`${c.outOfOrder.length} line(s) are read out of the PDF in a different place than they are on the page: ${c.outOfOrder.map((m) => `"${m}"`).join('; ')}`);
  return `${parts.join('. ')}.`;
}
