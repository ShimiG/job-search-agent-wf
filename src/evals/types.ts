import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Count } from '../report/metrics.ts';

/*
 * An eval is a fixed set of cases with known answers, run through the same code the agents use, so a
 * number like "catches 11 of 12 invented claims" can be reproduced by anyone with the repository.
 * The cases are in evals/ (all fictional); each run's result is saved under data/evals/.
 */

export interface EvalMetric {
  label: string;
  /** A rate, with the counts behind it. */
  count?: Count;
  /** Or a plain value, already formatted. */
  value?: string;
}

/** One case's outcome: what was expected, what came back, and whether that passes. */
export interface CaseResult {
  id: string;
  /** The case's group within the suite: "fit", "injection", "fabricated"... */
  kind: string;
  expected: string;
  got: string;
  pass: boolean;
  /** Why it failed to run at all, if it did. A case that couldn't run counts as neither pass nor fail. */
  error?: string;
  note?: string;
}

export interface EvalSummary {
  suite: string;
  title: string;
  ranAt: string;
  /** The model under test. */
  model: string;
  cases: number;
  /** Cases that could not be run (the model failed), left out of every rate. */
  errors: number;
  /** Dollars spent on the run; 0 for a local model or a rules-only suite. */
  cost: number;
  metrics: EvalMetric[];
}

export interface EvalResult extends EvalSummary {
  results: CaseResult[];
}

export const count = (n: number, of: number): Count => ({ n, of, rate: of > 0 ? n / of : null });

/** Reads a .jsonl dataset: one JSON object per line; blank lines and lines starting with // are skipped. */
export function readCases<T>(file: string, parse: (raw: unknown) => T): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line && !line.startsWith('//'))
    .map(({ line, n }) => {
      try {
        return parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`${path.basename(file)} line ${n}: ${(err as Error).message}`);
      }
    });
}

/** Saves a run as the suite's latest result, and a dated copy beside it. */
export function saveEvalResult(dir: string, result: EvalResult): string {
  mkdirSync(path.join(dir, 'history'), { recursive: true });
  const text = JSON.stringify(result, null, 2) + '\n';
  writeFileSync(path.join(dir, 'history', `${result.suite}-${result.ranAt.replace(/[:.]/g, '-')}.json`), text);
  const file = path.join(dir, `${result.suite}.json`);
  writeFileSync(file, text);
  return file;
}

/** The latest result of each suite that has been run, without the per-case detail. */
export function loadEvalSummaries(dir: string): EvalSummary[] {
  if (!existsSync(dir)) return [];
  const out: EvalSummary[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const { results: _results, ...summary } = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as EvalResult;
      if (summary.suite && Array.isArray(summary.metrics)) out.push(summary);
    } catch {
      // A file that isn't a result is not this report's business.
    }
  }
  return out;
}
