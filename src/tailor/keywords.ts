import type { MasterCv } from '../config.ts';
import { containsKeyword } from '../util/text.ts';
import type { PostingKeyword, TailoredContent } from './schema.ts';
import { cvCorpus, highlightIndex } from './verify.ts';

/*
 * How a keyword-matching ATS sees the tailored CV: which of the posting's key requirements appear in it
 * word for word. Every status is checked here against real text, never taken from the model:
 *  - matched:  the tailored CV uses the term.
 *  - left_out: your CV uses the term, but this version doesn't. Free to add: it's already yours.
 *  - reworded: your CV shows it in other words (the highlights the writer cited). Using the posting's
 *              term there is honest if it's the same work; it's your call.
 *  - missing:  nothing in your CV shows it. Never added: that's what the fact-check is for.
 */

export type KeywordStatus = 'matched' | 'left_out' | 'reworded' | 'missing';

export interface KeywordResult {
  term: string;
  required: boolean;
  status: KeywordStatus;
  /** For "reworded": the CV highlight that shows it. */
  evidence?: string;
}

export interface KeywordCoverage {
  items: KeywordResult[];
  /** Terms the posting uses that the tailored CV uses too. */
  matched: number;
  /** Terms your CV backs up in any wording (matched + left out + reworded). */
  supported: number;
  total: number;
  requiredMatched: number;
  requiredTotal: number;
}

/** The text an ATS parses: the CV, not the cover letter. */
export function tailoredCvText(content: Pick<TailoredContent, 'headline' | 'summary' | 'skills' | 'experience' | 'projects'>): string {
  return [
    content.headline,
    content.summary,
    ...content.skills,
    ...content.experience.flatMap((e) => e.bullets.map((b) => b.text)),
    ...content.projects.flatMap((p) => p.bullets.map((b) => b.text)),
  ].join('\n');
}

const ORDER: Record<KeywordStatus, number> = { matched: 0, left_out: 1, reworded: 2, missing: 3 };

export function keywordCoverage(
  content: Pick<TailoredContent, 'headline' | 'summary' | 'skills' | 'experience' | 'projects' | 'keywords'>,
  cv: MasterCv,
  posting: string,
): KeywordCoverage {
  const text = tailoredCvText(content);
  const corpus = cvCorpus(cv);
  const highlights = highlightIndex(cv);
  const items: KeywordResult[] = [];
  const seen = new Set<string>();

  for (const k of content.keywords ?? []) {
    const terms = [k.cvTerm, k.term].map((t) => t.trim()).filter(Boolean);
    const shown = terms[0]!;
    // Only the posting's own words count: a term it doesn't contain is the model's paraphrase.
    if (!terms.length || !terms.some((t) => containsKeyword(posting, t))) continue;
    const key = shown.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let status: KeywordStatus = 'missing';
    let evidence: string | undefined;
    if (terms.some((t) => containsKeyword(text, t))) status = 'matched';
    else if (terms.some((t) => containsKeyword(corpus, t))) status = 'left_out';
    else {
      evidence = k.evidence.map((id) => highlights.get(id)?.text).find(Boolean);
      if (evidence) status = 'reworded';
    }
    items.push({ term: shown, required: k.required, status, ...(evidence ? { evidence } : {}) });
  }

  items.sort((a, b) => ORDER[a.status] - ORDER[b.status] || Number(b.required) - Number(a.required));
  const required = items.filter((i) => i.required);
  return {
    items,
    matched: items.filter((i) => i.status === 'matched').length,
    supported: items.filter((i) => i.status !== 'missing').length,
    total: items.length,
    requiredMatched: required.filter((i) => i.status === 'matched').length,
    requiredTotal: required.length,
  };
}

/** A note for "Redo with a note" that asks the Tailor to use the terms your CV already backs up. */
export function redoNote(coverage: KeywordCoverage): string {
  const leftOut = coverage.items.filter((i) => i.status === 'left_out').map((i) => i.term);
  const reworded = coverage.items.filter((i) => i.status === 'reworded').map((i) => i.term);
  const parts: string[] = [];
  if (leftOut.length) parts.push(`Include these terms from the posting, which my CV already uses: ${leftOut.join(', ')}.`);
  if (reworded.length) parts.push(`Where a bullet honestly describes the same work, use the posting's wording: ${reworded.join(', ')}.`);
  return parts.join(' ');
}

/** Markdown section for the tailoring report. */
export function formatCoverage(c: KeywordCoverage | undefined): string[] {
  if (!c || c.total === 0) return [];
  const of = (status: KeywordStatus) => c.items.filter((i) => i.status === status);
  const terms = (items: KeywordResult[]) => (items.length ? items.map((i) => `${i.term}${i.required ? '' : ' (nice to have)'}`).join(', ') : 'none');
  const lines = [
    '## ATS keywords',
    `${c.matched} of ${c.total} of the posting's key terms appear in this CV word for word` +
      `${c.requiredTotal ? ` (${c.requiredMatched} of ${c.requiredTotal} must-haves)` : ''}. Your CV backs up ${c.supported} of ${c.total}.`,
    '',
    `- In the CV: ${terms(of('matched'))}`,
    `- Your CV uses these, this version left them out: ${terms(of('left_out'))}`,
  ];
  const reworded = of('reworded');
  lines.push(reworded.length ? '- Your CV shows these in other words:' : '- Your CV shows these in other words: none');
  for (const r of reworded) lines.push(`  - ${r.term}: "${r.evidence}"`);
  lines.push(`- Not in your CV (never added): ${terms(of('missing'))}`, '');
  return lines;
}

export type { PostingKeyword };
