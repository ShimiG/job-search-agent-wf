import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MasterCvSchema, PreferencesSchema, type MasterCv, type Preferences } from '../config.ts';
import { rate, usd } from '../report/format.ts';
import { TailorConfigSchema, type TailorConfig } from '../tailor/schema.ts';
import { FactCheckCase, ReplyCase, ScoringCase, type SuiteOutput } from './suites.ts';
import { readCases, type EvalResult } from './types.ts';

/** The checked-in cases: evals/ at the top of the repository. Everything in it is fictional. */
export const EVALS_DIR = fileURLToPath(new URL('../../evals/', import.meta.url));
const EXAMPLES_DIR = fileURLToPath(new URL('../../examples/', import.meta.url));

export const SUITES = {
  scoring: { title: 'Scoring: the right side of the cutoff, and planted instructions', file: 'scoring.jsonl' },
  factcheck: { title: 'Fact-check: invented claims in a reworded CV', file: 'factcheck.jsonl' },
  replies: { title: 'Sorting replies to applications', file: 'replies.jsonl' },
} as const;
export type SuiteName = keyof typeof SUITES;
export const SUITE_NAMES = Object.keys(SUITES) as SuiteName[];

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
    '',
    ...r.metrics.map((m) => `${m.label.padEnd(width)}  ${m.count ? rate(m.count) : (m.value ?? 'n/a')}`),
  ];
  const wrong = r.results.filter((x) => !x.pass && !x.error);
  if (wrong.length) lines.push('', 'Wrong:', ...wrong.map((x) => `- ${x.id}: expected ${x.expected}, got ${x.got}${x.note ? ` (${x.note})` : ''}`));
  const failed = r.results.filter((x) => x.error);
  if (failed.length) lines.push('', 'Could not be run (left out of every rate):', ...failed.map((x) => `- ${x.id}: ${x.error}`));
  if (r.metrics.some((m) => m.count && m.count.of > 0 && m.count.of < 20)) lines.push('', '* fewer than 20 cases: a difference of one case moves the rate by 5 points or more.');
  return lines.join('\n');
}
