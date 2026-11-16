import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MasterCvSchema, PreferencesSchema, type MasterCv, type Preferences } from '../config.ts';
import { rate, usd } from '../report/format.ts';
import { TailorConfigSchema, type TailorConfig } from '../tailor/schema.ts';
import type { JobStore } from '../db/store.ts';
import { cutoff } from '../pipeline/run.ts';
import { decisionExamples, pastDecisions, type DecisionExamples } from '../pipeline/past-decisions.ts';
import { FactCheckCase, ReplyCase, ScoringCase, type DecisionCase, type SuiteOutput } from './suites.ts';
import { OWN_JOBS } from './types.ts';
import { readCases, type EvalResult } from './types.ts';

/** The checked-in cases: evals/ at the top of the repository. Everything in it is fictional. */
export const EVALS_DIR = fileURLToPath(new URL('../../evals/', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('../../examples/', import.meta.url));

export const SUITES = {
  scoring: { title: 'Scoring: the right side of the cutoff, and planted instructions', file: 'scoring.jsonl' },
  factcheck: { title: 'Fact-check: invented claims in a reworded CV', file: 'factcheck.jsonl' },
  replies: { title: 'Sorting replies to applications', file: 'replies.jsonl' },
  decisions: { title: 'Your own decisions, re-scored', file: '' },
  learning: { title: 'Learning from your decisions: older ones as examples, newer ones as the test', file: '' },
} as const;
export type SuiteName = keyof typeof SUITES;
export const SUITE_NAMES = Object.keys(SUITES) as SuiteName[];
/** The suites with checked-in, fictional cases: what "all" runs. "decisions" reads your own jobs and is asked for by name. */
export const FIXED_SUITES: SuiteName[] = ['scoring', 'factcheck', 'replies'];
const ABOUT: Partial<Record<SuiteName, string>> = {
  decisions: 'Not a fixed test set: these are jobs you picked or dismissed, scored again and measured against what you chose. The jobs are yours, so nobody else can rerun it.',
  learning: 'Not a fixed test set: your own jobs. The same model scores the newer half of your decisions twice, without and with the older half shown as examples; no test job is among the examples.',
};

/** The fictional candidate every case is written against. */
export function loadEvalProfile(dir = EVALS_DIR): { cv: MasterCv; prefs: Preferences; cfg: TailorConfig } {
  const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return {
    cv: MasterCvSchema.parse(json(path.join(dir, 'cv.json'))),
    prefs: PreferencesSchema.parse(json(path.join(dir, 'preferences.json'))),
    cfg: TailorConfigSchema.parse(json(path.join(EXAMPLES_DIR, 'tailor.json'))),
  };
}

/** At most `limit` cases of each kind, in file order; an injection case is kept only with the posting it was made from. */
function capped<T extends { id: string; kind: string; base?: string }>(cases: T[], limit?: number): T[] {
  if (!limit || limit < 1) return cases;
  const seen = new Map<string, number>();
  const kept = new Set<string>();
  return cases.filter((c) => {
    const n = seen.get(c.kind) ?? 0;
    if (n >= limit || (c.base && !kept.has(c.base))) return false;
    seen.set(c.kind, n + 1);
    kept.add(c.id);
    return true;
  });
}

export function loadScoringCases(limit?: number, dir = EVALS_DIR): ScoringCase[] {
  return capped(readCases(path.join(dir, SUITES.scoring.file), (raw) => ScoringCase.parse(raw)), limit);
}
export function loadFactCheckCases(limit?: number, dir = EVALS_DIR): FactCheckCase[] {
  return capped(readCases(path.join(dir, SUITES.factcheck.file), (raw) => FactCheckCase.parse(raw)), limit);
}
export function loadReplyCases(limit?: number, dir = EVALS_DIR): ReplyCase[] {
  return capped(readCases(path.join(dir, SUITES.replies.file), (raw) => ReplyCase.parse(raw)), limit);
}

/** A suite's output as the record that is saved and reported. */
export function toResult(suite: SuiteName, model: string, output: SuiteOutput, cost: number, now = new Date()): EvalResult {
  return {
    suite,
    title: SUITES[suite].title,
    ...(ABOUT[suite] ? { about: ABOUT[suite] } : {}),
    ranAt: now.toISOString(),
    model,
    cases: output.results.length,
    errors: output.results.filter((r) => r.error).length,
    cost,
    metrics: output.metrics,
    results: output.results,
  };
}

/** Plain text for the terminal: the numbers, then every case that went wrong. */
export function formatEvalResult(r: EvalResult): string {
  const width = Math.max(...r.metrics.map((m) => m.label.length));
  const lines = [
    r.title,
    `${r.cases} cases with ${r.model}${r.cost ? `, ${usd(r.cost)}` : ''}`,
    ...(r.about ? [r.about] : []),
    '',
    ...r.metrics.map((m) => `${m.label.padEnd(width)}  ${m.count ? rate(m.count) : (m.value ?? 'n/a')}`),
  ];
  // Your own jobs aren't listed one by one: what counts there is the ranking, not each case.
  const wrong = OWN_JOBS.includes(r.suite) ? [] : r.results.filter((x) => !x.pass && !x.error);
  if (wrong.length) lines.push('', 'Wrong:', ...wrong.map((x) => `- ${x.id}: expected ${x.expected}, got ${x.got}${x.note ? ` (${x.note})` : ''}`));
  const failed = r.results.filter((x) => x.error);
  if (failed.length) lines.push('', 'Could not be run (left out of every rate):', ...failed.map((x) => `- ${x.id}: ${x.error}`));
  if (r.metrics.some((m) => m.count && m.count.of > 0 && m.count.of < 20)) lines.push('', '* fewer than 20 cases: a difference of one case moves the rate by 5 points or more.');
  return lines.join('\n');
}

/**
 * The jobs you decided on, for the decisions suite. By default only jobs that were on your shortlist:
 * dismissing a job shown as below the cutoff mostly repeats the score, so those say little. `all`
 * takes every scored job you decided on. With `limit`, that many of each decision, newest first.
 */
export function loadDecisionCases(store: JobStore, prefs: Preferences, opts: { all?: boolean; limit?: number } = {}): DecisionCase[] {
  const history = store.allHistory();
  const reached = (status: string) => new Set(history.filter((h) => h.to === status).map((h) => h.jobId));
  const [shortlisted, picked, dismissed, submitted] = [reached('shortlisted'), reached('selected'), reached('dismissed'), reached('submitted')];
  const out: DecisionCase[] = [];
  for (const s of store.jobSummaries().reverse()) {
    if (s.score === null || (!opts.all && !shortlisted.has(s.id))) continue;
    const yes = picked.has(s.id) || submitted.has(s.id);
    if (!yes && !dismissed.has(s.id)) continue;
    const decision = yes ? 'yes' : 'no';
    if (opts.limit && out.filter((c) => c.decision === decision).length >= opts.limit) continue;
    const job = store.get(s.id);
    if (job) out.push({ id: s.id, decision, job, cutoff: cutoff(job, prefs), storedScore: s.score });
  }
  return out;
}

/**
 * The split for the learning suite. Your decisions on scored jobs (shortlisted ones, unless `all`),
 * in the order you made them: the newer half is the test, and the examples are your decisions from
 * before the first test job, chosen exactly as Scout chooses them. `limit` keeps that many of the
 * newest picks and dismissals in the test.
 */
export function loadLearningSplit(
  store: JobStore,
  prefs: Preferences,
  opts: { all?: boolean; perSide: number; limit?: number },
): { cases: DecisionCase[]; examples: DecisionExamples; splitAt: string | null } {
  const decided = pastDecisions(store).filter((d) => d.job.score !== null && (opts.all || d.shortlisted));
  const newer = decided.slice(Math.floor(decided.length / 2));
  const splitAt = newer[0]?.at ?? null;
  // The examples are decisions made strictly before the first test job, so nothing in the test is among them.
  let cases: DecisionCase[] = newer.map((d) => ({ id: d.jobId, decision: d.decision === 'picked' ? ('yes' as const) : ('no' as const), job: d.job, cutoff: cutoff(d.job, prefs), storedScore: d.job.score! }));
  if (opts.limit) {
    const last = (decision: 'yes' | 'no') => cases.filter((c) => c.decision === decision).slice(-opts.limit!);
    const keep = new Set([...last('yes'), ...last('no')].map((c) => c.id));
    cases = cases.filter((c) => keep.has(c.id));
  }
  return { cases, examples: splitAt ? decisionExamples(store, opts.perSide, { before: splitAt }) : { picked: [], dismissed: [] }, splitAt };
}
