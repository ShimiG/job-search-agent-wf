import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { rate, usd } from '../report/format.ts';
import { OWN_JOBS, type EvalResult, type EvalSummary } from './types.ts';

/*
 * The same suite run with different models, side by side: the way to decide whether a cheaper model
 * is good enough, or whether the advisor earns what it costs. Every run is kept under
 * data/evals/history; this takes each model's latest run of each suite.
 */

export interface SuiteComparison {
  suite: string;
  title: string;
  /** One per model, newest first. Only runs over the same number of cases as the newest: an older case set isn't comparable. */
  runs: EvalSummary[];
}

export function loadComparisons(evalsDir: string): SuiteComparison[] {
  const dir = path.join(evalsDir, 'history');
  if (!existsSync(dir)) return [];
  const all: EvalSummary[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const { results: _results, ...summary } = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as EvalResult;
      if (summary.suite && summary.model && Array.isArray(summary.metrics)) all.push(summary);
    } catch {
      // Not a result: skip it.
    }
  }
  all.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  const out: SuiteComparison[] = [];
  for (const suite of [...new Set(all.map((r) => r.suite))].sort()) {
    const mine = all.filter((r) => r.suite === suite);
    const newest = mine[0]!;
    const runs: EvalSummary[] = [];
    // Your own decisions grow by a job or two between runs: still the same test. A fixed suite with other cases isn't.
    const comparable = (r: EvalSummary) => OWN_JOBS.includes(suite) || r.cases === newest.cases;
    for (const r of mine) if (comparable(r) && !runs.some((x) => x.model === r.model)) runs.push(r);
    out.push({ suite, title: newest.title, runs });
  }
  return out;
}

/** A Markdown table: one row per measure, one column per model. Empty when there's only one model. */
export function formatComparison(c: SuiteComparison): string[] {
  if (c.runs.length < 2) return [];
  const labels = [...new Set(c.runs.flatMap((r) => r.metrics.map((m) => m.label)))];
  const cell = (r: EvalSummary, label: string) => {
    const m = r.metrics.find((x) => x.label === label);
    return m ? (m.count ? rate(m.count) : (m.value ?? 'n/a')) : 'n/a';
  };
  const head = ['Measure', ...c.runs.map((r) => r.model)];
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`,
    ...labels.map((label) => `| ${label} | ${c.runs.map((r) => cell(r, label)).join(' | ')} |`),
    `| Cases | ${c.runs.map((r) => r.cases).join(' | ')} |`,
    `| Could not be run | ${c.runs.map((r) => r.errors).join(' | ')} |`,
    `| Cost of the run | ${c.runs.map((r) => usd(r.cost)).join(' | ')} |`,
    `| Run on | ${c.runs.map((r) => r.ranAt.slice(0, 10)).join(' | ')} |`,
    '',
  ];
}

/** Plain text for "npm run eval -- compare". */
export function formatComparisons(all: SuiteComparison[]): string {
  const withTwo = all.filter((c) => c.runs.length >= 2);
  if (!withTwo.length) {
    return 'Nothing to compare yet: run a suite with two models, for example\n  npm run eval -- scoring\n  npm run eval -- scoring --no-advisor\n  npm run eval -- scoring --model claude-sonnet-5-5';
  }
  return withTwo.flatMap((c) => [c.title, '', ...formatComparison(c)]).join('\n');
}
