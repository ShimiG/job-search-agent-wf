import type { MasterCv } from '../config.ts';
import type { TailoredContent } from './schema.ts';
import { highlightIndex } from './verify.ts';

/*
 * How a CV bullet should read, by the conventions technical recruiters expect: it opens with an active
 * verb, says what was done and what came of it, uses digits for numbers, and stays within two lines.
 * No pronouns, no "Responsible for", no adverbs that praise the work in place of describing it.
 *
 * These checks only flag: nothing is rewritten, and no number is ever added. The same rules audit the
 * master CV (cv/audit.ts), where a real figure can be put in once and used by every tailored CV.
 * Wording rules are for English; length applies to every language.
 */

/** About two lines of the CV at its normal type size. */
export const MAX_BULLET_CHARS = 190;

const WEAK_OPENER = /^(responsible for|tasked with|in charge of|assisted (?:in|with)|helped (?:to |with )?|worked on|involved in|participated in|duties included|served as)\b/i;
/** "I" only as the capital letter on its own (not i/o or i.e.); "us" and "me" are left out: "US" is a country. */
const PRONOUN_I = /(?:^|\s)I(?=\s|['’]|$)/;
const PRONOUN = /\b(we|my|our)\b/i;
/** Words that praise the work without saying anything about it. */
const BUZZWORDS = [
  'strategically', 'expertly', 'successfully', 'seamlessly', 'passionately', 'tirelessly', 'groundbreaking', 'cutting-edge', 'world-class',
  'best-in-class', 'state-of-the-art', 'innovative', 'results-driven', 'synergy', 'dynamic', 'robustly', 'efficiently and effectively',
];
const BUZZWORD = new RegExp(`\\b(${BUZZWORDS.map((b) => b.replace(/[-]/g, '[- ]')).join('|')})\\b`, 'i');
const SPELLED_NUMBER = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million)\b/i;
const OPENS_WITH_ARTICLE = /^(the|a|an|this|these|those)\s/i;
const OPENS_WITH_ING = /^[A-Za-z]+ing\b/;
const HEBREW_OR_CYRILLIC = /[֐-׿Ѐ-ӿ]/;

/** What's off about one bullet, in plain words. Empty when it reads as it should. */
export function bulletProblems(text: string): string[] {
  const t = text.trim();
  const problems: string[] = [];
  if (t.length > MAX_BULLET_CHARS) problems.push(`runs to about three lines (${t.length} characters; two lines is about ${MAX_BULLET_CHARS})`);
  // The wording rules are English ones.
  if (HEBREW_OR_CYRILLIC.test(t)) return problems;

  const weak = WEAK_OPENER.exec(t);
  if (weak) problems.push(`opens with "${weak[1]}": start with what you did (Built, Reduced, Automated…)`);
  else if (OPENS_WITH_ARTICLE.test(t)) problems.push('opens with a noun phrase: start with an active verb');
  else if (OPENS_WITH_ING.test(t)) problems.push(`opens with "${OPENS_WITH_ING.exec(t)![0]}": use the past tense for finished work`);

  const pronoun = PRONOUN_I.test(t) ? 'I' : PRONOUN.exec(t)?.[1];
  if (pronoun) problems.push(`uses "${pronoun}": CV bullets have no pronouns`);

  const buzz = BUZZWORD.exec(t);
  if (buzz) problems.push(`"${buzz[1]}" praises the work without describing it: say what happened`);

  const spelled = SPELLED_NUMBER.exec(t);
  if (spelled) problems.push(`write "${spelled[1]}" as a digit: numbers are what a reader's eye stops on`);
  return problems;
}

/** A bullet says something measurable when it carries a number. */
export const hasNumber = (text: string) => /\d/.test(text);

export interface StyleNote {
  /** "bullet:<highlight id>". */
  where: string;
  text: string;
  problems: string[];
  /** The bullet is your CV's own wording, so the fix belongs in your CV, not in a redo. */
  fromCv: boolean;
}

/** Every bullet of a tailored CV that breaks a rule, in the order they appear on the page. */
export function styleNotes(content: Pick<TailoredContent, 'experience' | 'projects'>, cv: MasterCv): StyleNote[] {
  const highlights = highlightIndex(cv);
  const notes: StyleNote[] = [];
  for (const entry of [...content.experience, ...content.projects]) {
    for (const b of entry.bullets) {
      const problems = bulletProblems(b.text);
      if (problems.length) notes.push({ where: `bullet:${b.source}`, text: b.text, problems, fromCv: highlights.get(b.source)?.text.trim() === b.text.trim() });
    }
  }
  return notes;
}

/** A note for "Redo with a note": fix the wording of the bullets the writer can fix. */
export function styleRedoNote(notes: StyleNote[]): string {
  const fixable = notes.filter((n) => !n.fromCv);
  if (!fixable.length) return '';
  return `Rewrite these CV bullets to follow the bullet style rules, keeping the same facts: ${fixable.map((n) => `"${n.text.slice(0, 60)}…" (${n.problems.map((p) => p.split(':')[0]).join('; ')})`).join(' | ')}`;
}

/** Markdown section for the tailoring report. */
export function formatStyleNotes(notes: StyleNote[] | undefined): string[] {
  if (!notes?.length) return [];
  return ['## Bullet style', ...notes.map((n) => `- ${n.fromCv ? '(your CV\'s wording) ' : ''}"${n.text}"\n  ${n.problems.map((p) => `→ ${p}`).join('\n  ')}`), ''];
}
