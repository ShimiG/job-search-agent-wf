import type { MasterCv } from '../config.ts';
import { hasNumber, wordingProblems } from '../tailor/style.ts';
import { containsKeyword } from '../util/text.ts';

/*
 * A check of the master CV itself, by the same writing rules the Tailor's bullets are held to. The
 * Tailor may only reword what's here and never adds a figure, so a weak highlight stays weak in every
 * tailored CV: this is the one place where fixing it once fixes it everywhere.
 *
 * It only reports. Nothing is rewritten, and no number is suggested: only you know the real one.
 */

export interface HighlightFinding {
  /** The highlight's ID in master-cv.json. */
  id: string;
  /** "Role, Company" or the project's name. */
  entry: string;
  text: string;
  problems: string[];
}

export interface SkillFinding {
  skill: string;
  category: string;
  /** unshown: nothing in the CV shows it. generic: a tool every office uses. graded: carries a self-given level. repeat: listed twice. */
  kind: 'unshown' | 'generic' | 'graded' | 'repeat';
  problem: string;
}

export interface CvAudit {
  highlights: number;
  /** Highlights that state something measurable. */
  withNumber: number;
  /** Highlights whose wording breaks a rule. */
  wording: HighlightFinding[];
  /** Highlights with no figure in them: worth one if you have a real one. `problems` is empty. */
  noNumber: HighlightFinding[];
  skills: SkillFinding[];
  /** About the summary and the CV as a whole. */
  general: string[];
}

/** Tools every office uses: listing them takes room from the skills that set you apart. */
const GENERIC_TOOLS = [
  'jira', 'slack', 'trello', 'asana', 'zoom', 'teams', 'microsoft teams', 'ms teams', 'microsoft office', 'ms office', 'office 365', 'microsoft 365',
  'word', 'microsoft word', 'powerpoint', 'outlook', 'google docs', 'google workspace', 'gmail', 'email', 'windows',
];
/** A self-given grade: nobody can check it, and it invites a question the bullets should answer instead. */
const SELF_RATING = /\b(expert|advanced|proficient|intermediate|beginner|basic|familiar(?:ity)?|working knowledge)\b|\d+\s*%|\b\d\s*\/\s*(?:5|10)\b|[★⭐]/i;

/** A highlight may run longer than a printed bullet (the Tailor shortens it), but not this long. */
export const MAX_HIGHLIGHT_CHARS = 300;
/** Words that say nothing about which skill it is: "REST APIs" is shown by "REST", not by "APIs". */
const FILLER = new Set([
  'and', 'the', 'for', 'with', 'from', 'through', 'api', 'apis', 'development', 'programming', 'design', 'management', 'engineering', 'systems', 'system', 'tools',
  'software', 'services', 'service', 'business', 'data', 'modern', 'based', 'driven', 'solutions', 'technologies', 'platform', 'platforms', 'framework', 'frameworks',
]);
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu) ?? [];
/** "grounding" and "grounded", "integration" and "integrations". */
const sameWord = (a: string, b: string) => a === b || a.replace(/s$/, '') === b.replace(/s$/, '') || (a.length >= 7 && b.length >= 7 && a.slice(0, 6) === b.slice(0, 6));

/**
 * Does anything in the CV mention this skill? The name as written, or, for a skill of several words,
 * any of its telling words ("WhatsApp Business messaging" is shown by a highlight about WhatsApp).
 * Deliberately generous: a skill is only reported when nothing comes close.
 */
function isShown(name: string, shown: string, shownWords: Set<string>): boolean {
  if (containsKeyword(shown, name)) return true;
  const words = wordsOf(name).filter((w) => w.length >= 3 && !FILLER.has(w));
  if (wordsOf(name).length < 2) return false;
  return words.some((w) => [...shownWords].some((s) => sameWord(w, s)));
}

/** About four lines of the CV. */
export const MAX_SUMMARY_CHARS = 420;
/** Past this many skills the list stops being read. */
export const MAX_SKILLS = 30;

export function auditCv(cv: MasterCv): CvAudit {
  const entries = [
    ...cv.experience.map((e) => ({ entry: `${e.role}, ${e.company}`, highlights: e.highlights })),
    ...cv.projects.map((p) => ({ entry: p.name, highlights: p.highlights })),
  ];
  const wording: HighlightFinding[] = [];
  const noNumber: HighlightFinding[] = [];
  let highlights = 0;
  for (const e of entries) {
    for (const h of e.highlights) {
      highlights++;
      const problems = wordingProblems(h.text);
      // The Tailor shortens a highlight to fit two lines; one this long is usually two things it could choose between.
      if (h.text.trim().length > MAX_HIGHLIGHT_CHARS) problems.unshift(`${h.text.trim().length} characters long: if it describes two things, split it so the Tailor can pick the one a job calls for`);
      if (problems.length) wording.push({ id: h.id, entry: e.entry, text: h.text, problems });
      if (!hasNumber(h.text)) noNumber.push({ id: h.id, entry: e.entry, text: h.text, problems: [] });
    }
  }

  // Where a skill can be shown: what you did, where, and what each project was built with.
  const shown = [
    ...entries.flatMap((e) => e.highlights.flatMap((h) => [h.text, ...(h.tags ?? [])])),
    ...cv.projects.flatMap((p) => [p.name, ...p.stack]),
    ...cv.experience.flatMap((e) => [e.role, e.company]),
    ...(cv.certifications ?? []).map((c) => c.name),
  ].join('\n');
  const shownWords = new Set(wordsOf(shown));

  const skills: SkillFinding[] = [];
  const seen = new Map<string, string>();
  for (const group of cv.skills) {
    for (const item of group.items) {
      const add = (kind: SkillFinding['kind'], problem: string) => skills.push({ skill: item, category: group.category, kind, problem });
      const key = item.trim().toLowerCase();
      const earlier = seen.get(key);
      if (earlier !== undefined) add('repeat', earlier === group.category ? 'listed twice' : `also listed under "${earlier}"`);
      else seen.set(key, group.category);

      const rating = SELF_RATING.exec(item);
      if (rating) add('graded', `"${rating[0].trim()}" is a grade you gave yourself: list the skill alone and let the bullets show the level`);
      // The name on its own: "Python (Advanced)" and "JavaScript (ES5 through modern)" are Python and JavaScript.
      const name = item.replace(/[([{].*?[)\]}]/g, ' ').replace(SELF_RATING, ' ').replace(/[\s:,;–-]+$/g, '').trim() || item;
      if (GENERIC_TOOLS.includes(name.toLowerCase())) add('generic', 'a tool every team uses: it takes room from the skills that set you apart');
      else if (!isShown(name, shown, shownWords)) add('unshown', 'no highlight or project mentions it: add one that does, or a reader has only the word to go on');
    }
  }

  const general: string[] = [];
  const summary = cv.summary.trim();
  if (summary.length > MAX_SUMMARY_CHARS) general.push(`The summary runs to ${summary.length} characters: about four lines (${MAX_SUMMARY_CHARS}) is as much as gets read.`);
  const summaryWording = wordingProblems(summary).filter((p) => p.startsWith('"'));
  for (const p of summaryWording) general.push(`The summary: ${p}.`);
  const skillCount = cv.skills.reduce((n, g) => n + g.items.length, 0);
  if (skillCount > MAX_SKILLS) general.push(`${skillCount} skills are listed: past about ${MAX_SKILLS} the list stops being read. The Tailor picks from it, so this only costs you on a CV you send yourself.`);
  const thin = cv.experience.filter((e) => e.highlights.length < 2).map((e) => `${e.role}, ${e.company}`);
  if (thin.length) general.push(`Fewer than 2 highlights, so the Tailor has little to choose from: ${thin.join('; ')}.`);

  return { highlights, withNumber: highlights - noNumber.length, wording, noNumber, skills, general };
}

export const auditIsClean = (a: CvAudit) => a.wording.length === 0 && a.skills.length === 0 && a.general.length === 0;

/** Plain text for the CLI. */
export function formatAudit(a: CvAudit): string {
  if (a.highlights === 0) return 'Your CV has no highlights yet: there is nothing to check.';
  const out: string[] = [];
  out.push(`${a.withNumber} of ${a.highlights} highlights state a number.`);
  if (auditIsClean(a)) out.push('Nothing else to fix: the wording and the skills list follow the rules.');
  if (a.general.length) out.push('', ...a.general.map((g) => `- ${g}`));
  if (a.wording.length) {
    out.push('', `Wording (${a.wording.length}):`);
    for (const f of a.wording) out.push(`- [${f.id}] ${f.entry}`, `  "${f.text}"`, ...f.problems.map((p) => `  → ${p}`));
  }
  if (a.skills.length) {
    out.push('', `Skills (${a.skills.length}):`);
    for (const f of a.skills.filter((x) => x.kind !== 'unshown')) out.push(`- ${f.skill} (${f.category}): ${f.problem}`);
    const unshown = a.skills.filter((x) => x.kind === 'unshown');
    if (unshown.length) out.push(`- No highlight or project mentions these, so a reader has only the word to go on: ${unshown.map((x) => x.skill).join(', ')}`);
  }
  if (a.noNumber.length) {
    out.push('', `No number (${a.noNumber.length}). If you have a real figure (how many, how much faster, how often), add it; if not, leave it:`);
    for (const f of a.noNumber) out.push(`- [${f.id}] ${f.text}`);
  }
  return out.join('\n');
}
