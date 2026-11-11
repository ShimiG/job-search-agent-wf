import type { MasterCv } from '../config.ts';
import { normalizeCompany } from '../util/text.ts';
import type { TailoredContent } from './schema.ts';
import { cvCorpus } from './verify.ts';

/*
 * Does this cover letter read like your other ones? Recruiters and AI-screening tools spot
 * mass-produced letters by their repeated prose: the same opening, the same closing line, the same
 * paragraph with only the company name swapped. A letter to a company you've already written to is the
 * worst case: the same person may read both.
 *
 * Measured on word 5-grams, with each letter's company and job title replaced by placeholders (so a
 * template that only swaps the name still matches) and every 5-gram that appears in your CV removed:
 * restating your own facts is expected, repeating the same sentences around them isn't.
 */

export const SHINGLE = 5;
/** A paragraph counts as reused when this share of its own wording appears in one earlier letter. */
export const PARAGRAPH_REUSE = 0.5;
/** A letter is flagged when this share of its wording appears in one earlier letter. */
export const LETTER_REUSE = 0.3;

export interface EarlierLetter {
  jobId: number;
  company: string;
  title: string;
  /** The paragraphs and closing line, as sent. */
  paragraphs: string[];
}

export interface LetterSimilarity {
  /** How many earlier letters it was compared with. */
  compared: number;
  /** The most similar earlier letter, when any wording is shared. */
  closest: { jobId: number; company: string; title: string; overlap: number } | null;
  /** Paragraphs (0-based; the closing line is last) that repeat an earlier letter. */
  reused: Array<{ paragraph: number; jobId: number; company: string; overlap: number }>;
  /** The closest letter, or a reused paragraph, went to the same company. */
  sameCompany: boolean;
  flagged: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function words(text: string, company: string, title: string): string[] {
  let t = text.normalize('NFKC').toLowerCase();
  for (const [name, mark] of [[title, ' ⟨role⟩ '], [company, ' ⟨company⟩ ']] as const) {
    const n = name.normalize('NFKC').toLowerCase().trim();
    if (n.length >= 2) t = t.replace(new RegExp(escape(n), 'g'), mark);
  }
  return t.match(/⟨\w+⟩|[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

function shingles(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(tokens.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** Share of `a`'s 5-grams that are also in `b`. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let n = 0;
  for (const s of a) if (b.has(s)) n++;
  return n / a.size;
}


export function letterSimilarity(
  letter: Pick<TailoredContent, 'company' | 'jobTitle' | 'coverLetter'>,
  earlier: EarlierLetter[],
  cv: MasterCv,
): LetterSimilarity {
  const cvShingles = shingles(words(cvCorpus(cv), '', ''));
  const prose = (paragraphs: string[], company: string, title: string) =>
    paragraphs.map((p) => new Set([...shingles(words(p, company, title))].filter((s) => !cvShingles.has(s))));

  const mine = prose([...letter.coverLetter.paragraphs, letter.coverLetter.closing], letter.company, letter.jobTitle);
  const all = new Set(mine.flatMap((p) => [...p]));
  const result: LetterSimilarity = { compared: earlier.length, closest: null, reused: [], sameCompany: false, flagged: false };
  if (all.size === 0) return result;

  for (const other of earlier) {
    const theirs = new Set(prose(other.paragraphs, other.company, other.title).flatMap((p) => [...p]));
    const overlap = containment(all, theirs);
    if (overlap > 0 && overlap > (result.closest?.overlap ?? 0)) result.closest = { jobId: other.jobId, company: other.company, title: other.title, overlap };
    mine.forEach((p, i) => {
      // Short paragraphs have too few 5-grams to judge.
      if (p.size < 4) return;
      const o = containment(p, theirs);
      const seen = result.reused.find((r) => r.paragraph === i);
      if (o < PARAGRAPH_REUSE || (seen && seen.overlap >= o)) return;
      if (seen) Object.assign(seen, { jobId: other.jobId, company: other.company, overlap: o });
      else result.reused.push({ paragraph: i, jobId: other.jobId, company: other.company, overlap: o });
    });
  }
  result.reused.sort((a, b) => a.paragraph - b.paragraph);
  const same = (company: string) => normalizeCompany(company) === normalizeCompany(letter.company);
  const closeEnough = (result.closest?.overlap ?? 0) >= LETTER_REUSE;
  result.flagged = closeEnough || result.reused.length > 0;
  result.sameCompany = (closeEnough && same(result.closest!.company)) || result.reused.some((r) => same(r.company));
  return result;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Plain-language findings: one line for the letter, one per reused paragraph. */
export function similarityMessages(s: LetterSimilarity, paragraphCount: number): string[] {
  if (!s.flagged) return [];
  const out: string[] = [];
  const c = s.closest;
  if (c && c.overlap >= LETTER_REUSE) {
    out.push(
      `${pct(c.overlap)} of this letter's wording is the same as your letter to ${c.company} (#${c.jobId}, ${c.title})` +
        (s.sameCompany ? `: the same company, so the same people may read both` : ''),
    );
  }
  // A near-copy is said once; listing each paragraph of it adds nothing.
  const copied = c && c.overlap >= 0.8 ? c.jobId : null;
  for (const r of s.reused) {
    if (r.jobId === copied) continue;
    const which = r.paragraph === paragraphCount ? 'the closing line' : `paragraph ${r.paragraph + 1}`;
    out.push(`${which} repeats your letter to ${r.company} (#${r.jobId}, ${pct(r.overlap)} the same)`);
  }
  return out;
}

/** A note for "Redo with a note" that asks for fresh wording, keeping the facts. */
export function similarityRedoNote(s: LetterSimilarity): string {
  if (!s.flagged) return '';
  const closest = s.closest && s.closest.overlap >= LETTER_REUSE ? [s.closest.company] : [];
  const companies = [...new Set([...closest, ...s.reused.map((r) => r.company)])];
  return `Write the cover letter in fresh words, with a different opening and closing: it reuses wording from my letter${companies.length > 1 ? 's' : ''} to ${companies.join(', ')}. Keep the same facts.`;
}
