import type { MasterCv } from '../config.ts';
import { containsKeyword, normalizeForMatch } from '../util/text.ts';
import type { BulletChange, Draft, Issue, OutputLanguage, TailorConfig, TailoredContent, Verdicts } from './schema.ts';

/*
 * Grounding happens in two layers:
 *  1. Deterministic rules here: structure (IDs, limits, skills), numbers, and unknown terms.
 *     Cheap, exact, and they can't be talked out of anything.
 *  2. An LLM fact-check of every reworded claim (see llm.ts), applied with applyVerdicts().
 * Bullets and the summary have a safe fallback, your exact master-CV wording, so a failed
 * check fixes itself. Cover-letter paragraphs have no fallback, so they get one revision
 * round and anything still unsupported is shown to you before you approve.
 */

export type ContentBody = Omit<TailoredContent, 'jobId' | 'company' | 'jobTitle' | 'cvLanguage' | 'letterLanguage' | 'generatedAt'>;

interface HighlightRef {
  text: string;
  entryId: string;
  kind: 'experience' | 'project';
}

export function highlightIndex(cv: MasterCv): Map<string, HighlightRef> {
  const map = new Map<string, HighlightRef>();
  for (const e of cv.experience) for (const h of e.highlights) map.set(h.id, { text: h.text, entryId: e.id, kind: 'experience' });
  for (const p of cv.projects) for (const h of p.highlights) map.set(h.id, { text: h.text, entryId: p.id, kind: 'project' });
  return map;
}

/** All text in the CV, for "does this term appear anywhere in your CV" checks. */
export function cvCorpus(cv: MasterCv): string {
  const parts: string[] = [cv.name, cv.headline, cv.location ?? '', cv.summary];
  for (const s of cv.skills) parts.push(s.category, ...s.items);
  for (const e of cv.experience) parts.push(e.company, e.role, ...e.highlights.map((h) => h.text));
  for (const p of cv.projects) parts.push(p.name, ...p.stack, ...p.highlights.map((h) => h.text));
  for (const ed of cv.education) parts.push(ed.institution, ed.degree, ed.year ?? '');
  for (const l of cv.languages) parts.push(l.language, l.level);
  return parts.join('\n');
}

export function extractNumbers(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ''));
}

const COMMON_CAPITALIZED = new Set(
  [
    'i', "i'm", "i've", "i'd", "i'll", 'dear', 'hi', 'hello', 'team', 'hiring', 'manager', 'best', 'regards', 'thank', 'thanks',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'sunday', 'english', 'hebrew', 'russian', 'cv', 'resume',
  ].map((w) => w.toLowerCase()),
);

/**
 * Latin-script tokens that look like tools, products, or proper nouns: SQLite, Node.js, C#, GPT-4.1,
 * or a Capitalized word mid-sentence. Sentence-initial capitals are ignored. Works inside Hebrew text too.
 */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9]*(?:[.+#/-][A-Za-z0-9+#]+)*[+#]*/g;
  for (const m of text.matchAll(re)) {
    const token = m[0];
    const before = text.slice(0, m.index).trimEnd();
    const sentenceStart = before === '' || /[.!?:\n•\-–—"“(]$/.test(before);
    const techShape = /[0-9.+#/]/.test(token) || /[A-Z]/.test(token.slice(1));
    const capitalized = /^[A-Z]/.test(token);
    if (COMMON_CAPITALIZED.has(token.toLowerCase())) continue;
    if (techShape || (capitalized && !sentenceStart)) terms.add(token.replace(/[.,]+$/, ''));
  }
  return [...terms];
}

export const unknownTerms = (text: string, ...corpora: string[]) =>
  extractTerms(text).filter((t) => !corpora.some((c) => containsKeyword(c, t)));

export const unknownNumbers = (text: string, ...allowed: string[]) => {
  const known = new Set(allowed.flatMap(extractNumbers));
  return extractNumbers(text).filter((n) => !known.has(n));
};

const same = (a: string, b: string) => normalizeForMatch(a) === normalizeForMatch(b);
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Step 1: enforce structure. Unknown IDs and skills are dropped, limits applied, missing jobs restored. */
export function normalizeDraft(draft: Draft, cv: MasterCv, cfg: TailorConfig, letterLanguage: OutputLanguage = 'en'): { body: ContentBody; issues: Issue[] } {
  const issues: Issue[] = [];
  const highlights = highlightIndex(cv);

  const pickBullets = (entryId: string, kind: 'experience' | 'project', bullets: Draft['experience'][number]['bullets']) => {
    const seen = new Set<string>();
    const out: Array<{ source: string; text: string }> = [];
    for (const b of bullets) {
      const ref = highlights.get(b.source);
      if (!ref || ref.entryId !== entryId || ref.kind !== kind) {
        issues.push({ severity: 'fixed', where: `${kind}:${entryId}`, message: `dropped a bullet citing unknown highlight "${b.source}"` });
        continue;
      }
      if (seen.has(b.source)) continue;
      seen.add(b.source);
      out.push({ source: b.source, text: b.text.trim() || ref.text });
    }
    return out.slice(0, cfg.cv.maxBulletsPerRole);
  };

  // Every job stays on the CV, in master order: gaps in your history look worse than an unrelated role.
  const draftedExperience = new Map(draft.experience.map((e) => [e.id, e]));
  for (const e of draft.experience) {
    if (!cv.experience.some((x) => x.id === e.id)) {
      issues.push({ severity: 'fixed', where: 'experience', message: `dropped unknown experience entry "${e.id}"` });
    }
  }
  const experience = cv.experience.map((entry) => {
    const drafted = draftedExperience.get(entry.id);
    let bullets = drafted ? pickBullets(entry.id, 'experience', drafted.bullets) : [];
    if (bullets.length === 0) {
      bullets = entry.highlights.slice(0, 2).map((h) => ({ source: h.id, text: h.text }));
      issues.push({ severity: 'fixed', where: `experience:${entry.id}`, message: 'role was missing or empty; restored with your first highlights' });
    }
    return { id: entry.id, bullets };
  });

  const projects: ContentBody['projects'] = [];
  for (const p of draft.projects) {
    if (!cv.projects.some((x) => x.id === p.id)) {
      issues.push({ severity: 'fixed', where: 'projects', message: `dropped unknown project "${p.id}"` });
      continue;
    }
    if (projects.some((x) => x.id === p.id)) continue;
    const bullets = pickBullets(p.id, 'project', p.bullets);
    if (bullets.length) projects.push({ id: p.id, bullets });
  }
  if (projects.length > cfg.cv.maxProjects) projects.length = cfg.cv.maxProjects;

  const allSkills = cv.skills.flatMap((s) => s.items);
  const skills: string[] = [];
  for (const s of draft.skills) {
    const match = allSkills.find((k) => same(k, s));
    if (!match) {
      issues.push({ severity: 'fixed', where: 'skills', message: `dropped "${s}" (not in your CV skills)` });
      continue;
    }
    if (!skills.includes(match)) skills.push(match);
  }
  if (skills.length === 0) skills.push(...allSkills);
  if (skills.length > cfg.cv.maxSkills) skills.length = cfg.cv.maxSkills;

  const body: ContentBody = {
    headline: draft.headline.trim() || cv.headline,
    summary: draft.summary.text.trim() || cv.summary,
    skills,
    experience,
    projects,
    coverLetter: {
      greeting: draft.coverLetter.greeting.trim(),
      paragraphs: draft.coverLetter.paragraphs.map((p) => p.text.trim()).filter(Boolean),
      closing: draft.coverLetter.closing.trim(),
      signOff: cfg.coverLetter.signOff[letterLanguage],
    },
    notes: {
      emphasized: draft.notes.emphasized.map((s) => s.trim()).filter(Boolean),
      requirementsNotMet: draft.notes.requirementsNotMet.map((s) => s.trim()).filter(Boolean),
    },
  };
  return { body, issues };
}

export interface FactCheckResult {
  issues: Issue[];
  /** Per letter paragraph: terms found in the posting but not your CV. The LLM checks these get claimed honestly. */
  letterSuspects: Map<number, string[]>;
}

/**
 * Step 2: deterministic fact checks. Mutates `body`: bullets, summary and headline that introduce
 * numbers or tools absent from your CV revert to your master wording (when the CV is in English).
 */
export function factCheck(body: ContentBody, cv: MasterCv, posting: string, cvLanguage: OutputLanguage, cfg: TailorConfig): FactCheckResult {
  const issues: Issue[] = [];
  const corpus = cvCorpus(cv);
  const highlights = highlightIndex(cv);
  const canRevert = cvLanguage === 'en';

  for (const section of [...body.experience, ...body.projects]) {
    for (const b of section.bullets) {
      const original = highlights.get(b.source)!.text;
      if (same(b.text, original)) continue;
      const badNumbers = unknownNumbers(b.text, original);
      const badTerms = unknownTerms(b.text, corpus);
      if (badNumbers.length === 0 && badTerms.length === 0) continue;
      const what = [...badNumbers.map((n) => `number ${n}`), ...badTerms].join(', ');
      if (canRevert) {
        issues.push({ severity: 'fixed', where: `bullet:${b.source}`, message: `added ${what} not in your CV; reverted to your wording` });
        b.text = original;
      } else {
        issues.push({ severity: 'unresolved', where: `bullet:${b.source}`, message: `mentions ${what}, not found in your CV` });
      }
    }
  }

  const checkTopLevel = (where: 'summary' | 'headline', fallback: string) => {
    const text = body[where];
    const bad = [...unknownNumbers(text, corpus).map((n) => `number ${n}`), ...unknownTerms(text, corpus)];
    if (bad.length === 0) return;
    if (canRevert) {
      issues.push({ severity: 'fixed', where, message: `added ${bad.join(', ')} not in your CV; reverted to your master ${where}` });
      body[where] = fallback;
    } else {
      issues.push({ severity: 'unresolved', where, message: `mentions ${bad.join(', ')}, not found in your CV` });
    }
  };
  checkTopLevel('summary', cv.summary);
  checkTopLevel('headline', cv.headline);

  const letterSuspects = new Map<number, string[]>();
  body.coverLetter.paragraphs.forEach((p, i) => {
    const nowhere = unknownTerms(p, corpus, posting);
    const badNumbers = unknownNumbers(p, corpus, posting);
    if (nowhere.length || badNumbers.length) {
      const what = [...nowhere, ...badNumbers.map((n) => `number ${n}`)].join(', ');
      issues.push({ severity: 'unresolved', where: `letter:${i}`, message: `mentions ${what}, found in neither your CV nor the posting` });
    }
    const fromPosting = unknownTerms(p, corpus).filter((t) => !nowhere.includes(t));
    if (fromPosting.length) letterSuspects.set(i, fromPosting);
  });

  const letterText = [body.coverLetter.greeting, ...body.coverLetter.paragraphs, body.coverLetter.closing].join(' ');
  const words = wordCount(letterText);
  if (words > cfg.coverLetter.maxWords * 1.15) {
    issues.push({ severity: 'warning', where: 'letter', message: `${words} words (limit ${cfg.coverLetter.maxWords})` });
  }
  for (const phrase of cfg.coverLetter.avoid) {
    if (containsKeyword(letterText, phrase)) issues.push({ severity: 'warning', where: 'letter', message: `uses avoided phrase "${phrase}"` });
  }
  return { issues, letterSuspects };
}

export interface Claim {
  id: string;
  text: string;
  /** Extra guidance for the fact-checker. */
  note?: string;
}

/** Everything reworded or newly written, for the LLM fact-check. Unchanged bullets are your own words and skip it. */
export function claimsForReview(body: ContentBody, cv: MasterCv, suspects: Map<number, string[]>): Claim[] {
  const highlights = highlightIndex(cv);
  const claims: Claim[] = [];
  if (!same(body.headline, cv.headline)) claims.push({ id: 'headline', text: body.headline });
  if (!same(body.summary, cv.summary)) claims.push({ id: 'summary', text: body.summary });
  for (const section of [...body.experience, ...body.projects]) {
    for (const b of section.bullets) {
      const original = highlights.get(b.source)!.text;
      if (!same(b.text, original)) claims.push({ id: `bullet:${b.source}`, text: b.text, note: `Rewritten from: "${original}"` });
    }
  }
  body.coverLetter.paragraphs.forEach((p, i) => {
    const terms = suspects.get(i);
    claims.push({
      id: `letter:${i}`,
      text: p,
      note: terms?.length ? `Mentions ${terms.join(', ')}, which appear in the posting but not the CV: must not be claimed as the candidate's experience.` : undefined,
    });
  });
  return claims;
}

export function bulletChanges(body: ContentBody, cv: MasterCv): BulletChange[] {
  const highlights = highlightIndex(cv);
  return [...body.experience, ...body.projects].flatMap((s) =>
    s.bullets
      .map((b) => ({ source: b.source, original: highlights.get(b.source)!.text, final: b.text }))
      .filter((c) => !same(c.original, c.final)),
  );
}

/**
 * Step 3: apply the fact-checker's verdicts. Bullets/summary/headline revert (English CV) or are flagged.
 * Returns the problems found in letter paragraphs so the caller can request one revision.
 */
export function applyVerdicts(body: ContentBody, cv: MasterCv, verdicts: Verdicts, cvLanguage: OutputLanguage): { issues: Issue[]; letterProblems: Map<number, string> } {
  const issues: Issue[] = [];
  const letterProblems = new Map<number, string>();
  const highlights = highlightIndex(cv);
  const canRevert = cvLanguage === 'en';

  for (const v of verdicts.claims) {
    if (v.supported) continue;
    const problem = v.problem.trim() || 'not supported by the CV';
    if (v.id.startsWith('letter:')) {
      const i = Number(v.id.slice(7));
      if (Number.isInteger(i) && i >= 0 && i < body.coverLetter.paragraphs.length) letterProblems.set(i, problem);
      continue;
    }
    if (v.id.startsWith('bullet:')) {
      const source = v.id.slice(7);
      const bullet = [...body.experience, ...body.projects].flatMap((s) => s.bullets).find((b) => b.source === source);
      const original = highlights.get(source)?.text;
      if (!bullet || !original) continue;
      if (canRevert) {
        bullet.text = original;
        issues.push({ severity: 'fixed', where: v.id, message: `fact-check: ${problem}; reverted to your wording` });
      } else {
        issues.push({ severity: 'unresolved', where: v.id, message: `fact-check: ${problem}` });
      }
      continue;
    }
    if (v.id === 'summary' || v.id === 'headline') {
      if (canRevert) {
        body[v.id] = v.id === 'summary' ? cv.summary : cv.headline;
        issues.push({ severity: 'fixed', where: v.id, message: `fact-check: ${problem}; reverted to your master ${v.id}` });
      } else {
        issues.push({ severity: 'unresolved', where: v.id, message: `fact-check: ${problem}` });
      }
    }
  }
  return { issues, letterProblems };
}
