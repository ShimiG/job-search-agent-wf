import { z } from 'zod';
import type { ResponseKind } from '../archiver/classify.ts';
import { RESPONSE_KINDS } from '../archiver/classify.ts';
import type { MasterCv } from '../config.ts';
import type { Scorer } from '../llm/scorer.ts';
import type { RawEmail } from '../sources/applications.ts';
import type { ClaimVerifier } from '../tailor/llm.ts';
import type { TailorConfig } from '../tailor/schema.ts';
import { claimsForReview, factCheck, highlightIndex, type ContentBody } from '../tailor/verify.ts';
import type { NormalizedJob } from '../types.ts';
import { auc, median } from '../report/metrics.ts';
import { count, type CaseResult, type EvalMetric } from './types.ts';

/*
 * The three suites. Each runs its cases through the code the agents themselves use (the scorer, the
 * Tailor's rule checks and fact-checker, the Archiver's email sorter), with whatever model you point
 * it at, and reports plain counts. A case the model failed to answer is an error, not a wrong answer.
 */

export interface SuiteOutput {
  results: CaseResult[];
  metrics: EvalMetric[];
}

/** Runs `fn` over `items`, a few at a time, keeping their order. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const ran = (results: CaseResult[]) => results.filter((r) => !r.error);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);

// ---------------------------------------------------------------- scoring

/** What each kind of posting tests, and the line it gets in the results. */
const SCORING_KINDS = {
  fit: 'Good fits shortlisted',
  'no-fit': 'Poor fits rejected',
  trap: "Keyword traps rejected (the CV's words, a different job)",
  disguised: "Disguised fits shortlisted (the right work, none of the CV's words)",
  dealbreaker: 'Right work with one firm disqualifier, rejected',
  'soft-gap': 'Right work missing only nice-to-haves, shortlisted',
  partial: 'Title-and-one-line postings on the right side of their cutoff',
  injection: 'Postings with planted instructions, still rejected',
} as const;
type ScoringKind = keyof typeof SCORING_KINDS;
/** The kinds that take reading the whole posting, not matching its words. */
const HARD_SCORING: readonly ScoringKind[] = ['trap', 'disguised', 'dealbreaker', 'soft-gap'];

export const ScoringCase = z
  .object({
    id: z.string(),
    kind: z.enum(Object.keys(SCORING_KINDS) as [ScoringKind, ...ScoringKind[]]),
    expect: z.enum(['shortlist', 'reject']),
    /** For an injection case: the clean posting it was made from. */
    base: z.string().optional(),
    /** Only a title and a line are known, as from a job alert: scored as partial, against the partial cutoff. */
    partial: z.boolean().optional(),
    job: z.object({
      title: z.string(),
      company: z.string(),
      location: z.string(),
      workplaceType: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
      description: z.string().min(40),
    }),
  })
  .refine((c) => c.partial || c.job.description.length >= 200, 'a full posting needs a real description (200 characters or more)');
export type ScoringCase = z.infer<typeof ScoringCase>;

/**
 * Does the scorer put each posting on the right side of the cutoff? The easy kinds can be told apart
 * by their words; the harder ones only by reading what the job is and what it demands. And does text
 * planted in a posting move its score?
 */
export async function runScoringEval(opts: {
  cases: ScoringCase[];
  scorer: Scorer;
  threshold: number;
  /** The cutoff for postings known only by a title and a line; the same as `threshold` when not given. */
  partialThreshold?: number | null;
  concurrency?: number;
  log?: (line: string) => void;
}): Promise<SuiteOutput> {
  const scores = new Map<string, number>();
  const cutoffOf = (c: ScoringCase) => (c.partial ? (opts.partialThreshold ?? opts.threshold) : opts.threshold);
  const results = await pool(opts.cases, opts.concurrency ?? 3, async (c): Promise<CaseResult> => {
    const job: NormalizedJob = { source: 'manual', externalId: `eval:${c.id}`, url: `https://example.com/eval/${c.id}`, ...c.job, descriptionIsPartial: Boolean(c.partial) };
    try {
      const { score } = await opts.scorer.score(job);
      scores.set(c.id, score);
      const got = score >= cutoffOf(c) ? 'shortlist' : 'reject';
      opts.log?.(`${got === c.expect ? 'ok  ' : 'MISS'} ${c.id}: ${score}`);
      return { id: c.id, kind: c.kind, expected: c.expect, got: `${got} (${score})`, pass: got === c.expect };
    } catch (err) {
      opts.log?.(`ERR  ${c.id}: ${message(err)}`);
      return { id: c.id, kind: c.kind, expected: c.expect, got: '', pass: false, error: message(err) };
    }
  });

  const of = (...kinds: ScoringKind[]) => ran(results).filter((r) => (kinds as string[]).includes(r.kind));
  const passed = (rows: CaseResult[]) => rows.filter((r) => r.pass).length;
  const line = (label: string, rows: CaseResult[]): EvalMetric[] => (rows.length ? [{ label, count: count(passed(rows), rows.length) }] : []);
  const clean = ran(results).filter((r) => r.kind !== 'injection');
  // How far the planted text moved each posting's score, for the pairs where both were scored.
  const lifts = opts.cases
    .filter((c) => c.kind === 'injection' && c.base && scores.has(c.id) && scores.has(c.base))
    .map((c) => scores.get(c.id)! - scores.get(c.base!)!);
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
  // Full postings only: a title and a line can't score as high, so they'd blur the comparison.
  const full = opts.cases.filter((c) => c.kind !== 'injection' && !c.partial && scores.has(c.id));
  const scoresOf = (expect: string) => full.filter((c) => c.expect === expect).map((c) => scores.get(c.id)!);
  const ranking = auc(scoresOf('shortlist'), scoresOf('reject'));

  return {
    results,
    metrics: [
      ...line('Right side of the cutoff (every posting without planted text)', clean),
      ...line('The harder postings (traps, disguised fits, dealbreakers, minor gaps)', of(...HARD_SCORING)),
      ...(Object.keys(SCORING_KINDS) as ScoringKind[]).flatMap((kind) => line(SCORING_KINDS[kind], of(kind))),
      { label: 'Chance a posting to shortlist outscores one to reject (100% is a perfect ranking)', value: ranking === null ? 'n/a' : `${Math.round(ranking * 100)}%` },
      { label: 'Points the planted instructions added, on average', value: lifts.length ? signed(lifts.reduce((a, b) => a + b, 0) / lifts.length) : 'n/a' },
      { label: 'Largest change from planted instructions', value: lifts.length ? signed(lifts.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)) : 'n/a' },
      { label: 'Median score of a posting to shortlist', value: String(median(scoresOf('shortlist')) ?? 'n/a') },
      { label: 'Median score of a posting to reject', value: String(median(scoresOf('reject')) ?? 'n/a') },
      { label: 'Cutoff', value: opts.partialThreshold && opts.partialThreshold !== opts.threshold ? `${opts.threshold} (${opts.partialThreshold} for a title and one line)` : String(opts.threshold) },
    ],
  };
}

// ---------------------------------------------------------------- fact-check

export const FactCheckCase = z.object({
  id: z.string(),
  /** honest and fabricated are plain; reworded is an honest bullet changed more freely; subtle adds something with no number or name to catch. */
  kind: z.enum(['honest', 'fabricated', 'reworded', 'subtle']),
  /** The CV highlight this bullet claims to reword. */
  source: z.string(),
  text: z.string(),
  expect: z.enum(['supported', 'unsupported']),
  why: z.string(),
});
export type FactCheckCase = z.infer<typeof FactCheckCase>;

/** A posting for the fact-checker to read claims against; none of the cases depend on its details. */
export const EVAL_POSTING =
  'AI Automation Engineer. Build LLM agents and automations for customer support, integrate with customer systems over REST APIs, and work with the support team. 3+ years of experience required.';

/**
 * Do the Tailor's two checks take back a reworded bullet that says more than the CV does, and leave
 * an honest rewording alone? Each bullet goes through the rule checks first, exactly as a draft does;
 * what they let through goes to the fact-checker (unless `verifier` is null: rules only).
 */
export async function runFactCheckEval(opts: {
  cases: FactCheckCase[];
  cv: MasterCv;
  cfg: TailorConfig;
  verifier: ClaimVerifier | null;
  concurrency?: number;
  log?: (line: string) => void;
}): Promise<SuiteOutput> {
  const highlights = highlightIndex(opts.cv);
  const results = await pool(opts.cases, opts.concurrency ?? 3, async (c): Promise<CaseResult> => {
    const done = (got: string, error?: string): CaseResult => {
      const verdict = got.startsWith('unsupported') ? 'unsupported' : 'supported';
      opts.log?.(error ? `ERR  ${c.id}: ${error}` : `${verdict === c.expect ? 'ok  ' : 'MISS'} ${c.id}: ${got}`);
      return { id: c.id, kind: c.kind, expected: c.expect, got, pass: !error && verdict === c.expect, note: c.why, ...(error ? { error } : {}) };
    };
    const ref = highlights.get(c.source);
    if (!ref) return done('', `no highlight "${c.source}" in the eval CV`);
    // A draft with this one bullet in it; everything else is the CV's own wording.
    const entry = { id: ref.entryId, bullets: [{ source: c.source, text: c.text }] };
    const body = {
      headline: opts.cv.headline,
      summary: opts.cv.summary,
      skills: [],
      experience: ref.kind === 'experience' ? [entry] : [],
      projects: ref.kind === 'project' ? [entry] : [],
      certifications: [],
      coverLetter: { greeting: '', paragraphs: [], closing: '', signOff: '' },
      notes: { emphasized: [], requirementsNotMet: [] },
    } as ContentBody;
    const rules = factCheck(body, opts.cv, EVAL_POSTING, 'en', opts.cfg);
    // The rule checks put the CV's own wording back when a bullet adds a number or a name.
    if (rules.issues.some((i) => i.where === `bullet:${c.source}`)) return done('unsupported (rule checks)');
    if (!opts.verifier) return done('supported (rule checks only)');
    try {
      const claims = claimsForReview(body, opts.cv, rules.letterSuspects);
      const verdicts = await opts.verifier.verify(opts.cv, EVAL_POSTING, claims);
      const verdict = verdicts.claims.find((v) => v.id === `bullet:${c.source}`);
      if (!verdict) return done('', 'the fact-checker returned no verdict for this claim');
      return done(verdict.supported ? 'supported' : 'unsupported (fact-check)');
    } catch (err) {
      return done('', message(err));
    }
  });

  const of = (...kinds: string[]) => ran(results).filter((r) => kinds.includes(r.kind));
  const by = (rows: CaseResult[], got: string) => rows.filter((r) => r.got === got).length;
  const caught = (rows: CaseResult[]) => rows.filter((r) => r.pass).length;
  const wronged = (rows: CaseResult[]) => rows.length - rows.filter((r) => r.pass).length;
  const line = (label: string, n: number, rows: CaseResult[]): EvalMetric[] => (rows.length ? [{ label, count: count(n, rows.length) }] : []);
  const invented = of('fabricated', 'subtle');
  const honest = of('honest', 'reworded');
  const caughtByRules = by(invented, 'unsupported (rule checks)');
  const caughtByModel = by(invented, 'unsupported (fact-check)');
  return {
    results,
    metrics: [
      { label: 'Invented claims caught', count: count(caughtByRules + caughtByModel, invented.length) },
      ...line('Plain inventions caught (a number, a tool, a team led)', caught(of('fabricated')), of('fabricated')),
      ...line('Subtle inventions caught (a wider scope, a result, a bigger role)', caught(of('subtle')), of('subtle')),
      { label: 'Caught by the rule checks, at no cost', count: count(caughtByRules, invented.length) },
      ...(opts.verifier ? [{ label: 'Caught by the fact-checker, of those the rules let through', count: count(caughtByModel, invented.length - caughtByRules) }] : []),
      { label: 'Honest rewordings wrongly taken back (lower is better)', count: count(wronged(honest), honest.length) },
      ...line('Of the freely reworded ones (lower is better)', wronged(of('reworded')), of('reworded')),
      { label: 'Honest rewordings taken back by the rule checks', value: String(by(honest, 'unsupported (rule checks)')) },
    ],
  };
}

// ---------------------------------------------------------------- replies

export const ReplyCase = z.object({
  id: z.string(),
  kind: z.enum(RESPONSE_KINDS),
  expect: z.enum(RESPONSE_KINDS),
  /** One of the harder emails: a request inside a receipt, a rejection after an interview, a reminder... */
  hard: z.boolean().optional(),
  /** Unrelated mail carrying an instruction to file it as something else. */
  planted: z.boolean().optional(),
  from: z.object({ name: z.string(), address: z.string() }),
  subject: z.string(),
  body: z.string(),
});
export type ReplyCase = z.infer<typeof ReplyCase>;

/** An assessment, an interview or an offer: the mail you can't afford to have sorted wrong. */
const CALLBACKS: readonly ResponseKind[] = ['assessment', 'interview', 'offer'];
const isCallback = (kind: string) => (CALLBACKS as readonly string[]).includes(kind);

/** Does the Archiver's sorter give each email the right kind? */
export async function runRepliesEval(opts: {
  cases: ReplyCase[];
  classify: (mail: RawEmail, body: string) => Promise<{ kind: string; model: string }>;
  /** A local model reads one email at a time. */
  concurrency?: number;
  log?: (line: string) => void;
}): Promise<SuiteOutput> {
  let byRules = 0;
  const results = await pool(opts.cases, opts.concurrency ?? 1, async (c): Promise<CaseResult> => {
    const mail: RawEmail = { fromName: c.from.name, fromAddress: c.from.address, subject: c.subject, text: c.body, html: '', date: new Date('2026-11-01T09:00:00Z') };
    try {
      const got = await opts.classify(mail, c.body);
      if (got.model === 'rules') byRules++;
      opts.log?.(`${got.kind === c.expect ? 'ok  ' : 'MISS'} ${c.id}: ${got.kind}${got.model === 'rules' ? ' (rules)' : ''}`);
      return { id: c.id, kind: c.kind, expected: c.expect, got: got.kind, pass: got.kind === c.expect };
    } catch (err) {
      opts.log?.(`ERR  ${c.id}: ${message(err)}`);
      return { id: c.id, kind: c.kind, expected: c.expect, got: '', pass: false, error: message(err) };
    }
  });

  const done = ran(results);
  const callbacks = done.filter((r) => isCallback(r.expected));
  const others = done.filter((r) => !isCallback(r.expected));
  const rejections = done.filter((r) => r.expected === 'rejection');
  const idsWhere = (test: (c: ReplyCase) => boolean) => new Set(opts.cases.filter(test).map((c) => c.id));
  const hard = done.filter((r) => idsWhere((c) => Boolean(c.hard)).has(r.id));
  const planted = done.filter((r) => idsWhere((c) => Boolean(c.planted)).has(r.id));
  return {
    results,
    metrics: [
      { label: 'Sorted into the right kind', count: count(done.filter((r) => r.pass).length, done.length) },
      ...(hard.length ? [{ label: 'The harder emails sorted right (requests inside receipts, reminders, soft rejections)', count: count(hard.filter((r) => r.pass).length, hard.length) }] : []),
      ...(planted.length ? [{ label: 'Unrelated mail with planted instructions, still filed as unrelated', count: count(planted.filter((r) => r.pass).length, planted.length) }] : []),
      { label: 'Callbacks recognised as a callback (assessment, interview, offer)', count: count(callbacks.filter((r) => isCallback(r.got)).length, callbacks.length) },
      { label: 'Callbacks given exactly the right kind', count: count(callbacks.filter((r) => r.pass).length, callbacks.length) },
      { label: 'Rejections recognised', count: count(rejections.filter((r) => r.pass).length, rejections.length) },
      { label: 'Other mail mistaken for a callback (lower is better)', count: count(others.filter((r) => isCallback(r.got)).length, others.length) },
      { label: 'Emails sorted by fixed rules, without the model', count: count(byRules, done.length) },
    ],
  };
}

// ---------------------------------------------------------------- your own decisions

/** A job you decided on: picked or applied to (yes), or dismissed and never picked (no). */
export interface DecisionCase {
  id: number;
  decision: 'yes' | 'no';
  job: NormalizedJob;
  /** The cutoff this job was held to: lower for one known only by a title and a line. */
  cutoff: number;
  /** The score it was given at the time. */
  storedScore: number;
}

/**
 * The fixed suites are written to have clear answers, and a clear answer is easy. What is hard about
 * scoring is the middle: real postings, half-described, where the right answer is what you would have
 * chosen. So this one re-scores the jobs you did choose between and measures the scores against your
 * decisions. Run it with two models, or with and without the advisor, and the same jobs tell them apart.
 */
export async function runDecisionsEval(opts: { cases: DecisionCase[]; scorer: Scorer; concurrency?: number; log?: (line: string) => void }): Promise<SuiteOutput> {
  const scores = new Map<number, number>();
  const results = await pool(opts.cases, opts.concurrency ?? 3, async (c): Promise<CaseResult> => {
    const expected = c.decision === 'yes' ? 'shortlist' : 'reject';
    try {
      const { score } = await opts.scorer.score(c.job);
      scores.set(c.id, score);
      const got = score >= c.cutoff ? 'shortlist' : 'reject';
      opts.log?.(`${got === expected ? 'ok  ' : 'MISS'} #${c.id}: ${score} (was ${c.storedScore}), you ${c.decision === 'yes' ? 'picked it' : 'dismissed it'}`);
      return { id: `#${c.id}`, kind: c.decision, expected, got: `${got} (${score})`, pass: got === expected };
    } catch (err) {
      opts.log?.(`ERR  #${c.id}: ${message(err)}`);
      return { id: `#${c.id}`, kind: c.decision, expected, got: '', pass: false, error: message(err) };
    }
  });

  const scored = opts.cases.filter((c) => scores.has(c.id));
  const yes = scored.filter((c) => c.decision === 'yes');
  const no = scored.filter((c) => c.decision === 'no');
  const now = (rows: DecisionCase[]) => rows.map((c) => scores.get(c.id)!);
  const then = (rows: DecisionCase[]) => rows.map((c) => c.storedScore);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const kept = (rows: DecisionCase[]) => rows.filter((c) => scores.get(c.id)! >= c.cutoff).length;
  const change = scored.length ? scored.reduce((n, c) => n + Math.abs(scores.get(c.id)! - c.storedScore), 0) / scored.length : null;
  return {
    results,
    metrics: [
      { label: 'Jobs re-scored', value: `${yes.length} you picked, ${no.length} you dismissed` },
      { label: 'Chance a job you picked outscores one you dismissed (50% is a coin flip)', value: pct(auc(now(yes), now(no))) },
      { label: 'The same, with the scores these jobs were given at the time', value: pct(auc(then(yes), then(no))) },
      { label: 'Jobs you picked, scored at or above the cutoff', count: count(kept(yes), yes.length) },
      { label: 'Jobs you dismissed, scored at or above the cutoff (lower is better)', count: count(kept(no), no.length) },
      { label: 'Share of that shortlist you would pick', count: count(kept(yes), kept(yes) + kept(no)) },
      { label: 'Median score of a job you picked', value: String(median(now(yes)) ?? 'n/a') },
      { label: 'Median score of a job you dismissed', value: String(median(now(no)) ?? 'n/a') },
      { label: 'Average change from the score given at the time', value: change === null ? 'n/a' : `${change.toFixed(1)} points` },
    ],
  };
}
