import type { MasterCv, Preferences } from '../config.ts';
import type { JobRow, ScoreResult } from '../types.ts';
import { cutoff } from '../pipeline/run.ts';
import { OllamaScorer, pickExamples } from './scorer.ts';

/*
 * Whether a local model can take over scoring: it re-scores postings Claude already scored (none of
 * them shown to it as examples) and the two are compared. Nothing is saved to the jobs.
 */

export interface Pair {
  job: JobRow;
  claude: ScoreResult;
  local: ScoreResult;
}

export interface Comparison {
  n: number;
  meanAbsDiff: number;
  /** Local minus Claude, on average: positive means the local model scores more generously. */
  bias: number;
  correlation: number;
  /** Jobs both put on the same side of your cutoff, with the local model's scores moved by `shift`. */
  agreement: number;
  shift: number;
  agreementUnshifted: number;
  claudeOnly: Pair[];
  localOnly: Pair[];
}

function pearson(xs: number[], ys: number[]): number {
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const [mx, my] = [mean(xs), mean(ys)];
  let [sxy, sxx, syy] = [0, 0, 0];
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i]! - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

export function compare(pairs: Pair[], prefs: Preferences): Comparison {
  const passes = (p: Pair, score: number) => score >= cutoff(p.job, prefs);
  const agreeing = (shift: number) => pairs.filter((p) => passes(p, p.claude.score) === passes(p, p.local.score + shift)).length;
  // The shift that best lines the local model's scores up with Claude's decisions; ties go to the smallest.
  let shift = 0;
  for (let s = -25; s <= 25; s++) if (agreeing(s) > agreeing(shift) || (agreeing(s) === agreeing(shift) && Math.abs(s) < Math.abs(shift))) shift = s;
  const diffs = pairs.map((p) => p.local.score - p.claude.score);
  return {
    n: pairs.length,
    meanAbsDiff: diffs.reduce((a, d) => a + Math.abs(d), 0) / pairs.length,
    bias: diffs.reduce((a, d) => a + d, 0) / pairs.length,
    correlation: pearson(pairs.map((p) => p.claude.score), pairs.map((p) => p.local.score)),
    agreement: agreeing(shift) / pairs.length,
    shift,
    agreementUnshifted: agreeing(0) / pairs.length,
    claudeOnly: pairs.filter((p) => passes(p, p.claude.score) && !passes(p, p.local.score + shift)),
    localOnly: pairs.filter((p) => !passes(p, p.claude.score) && passes(p, p.local.score + shift)),
  };
}

export function formatComparison(c: Comparison, model: string, secondsPerJob: number, pairs: Pair[]): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const line = (p: Pair) => `- #${p.job.id} ${p.job.company} — ${p.job.title}: Claude ${p.claude.score}, ${model} ${p.local.score}${p.job.descriptionIsPartial ? ' (alert only)' : ''}`;
  return [
    `# ${model} vs Claude: scoring comparison`,
    '',
    `${c.n} jobs Claude had scored, re-scored by ${model} (about ${Math.round(secondsPerJob)}s a job).`,
    '',
    `- Average difference: ${c.meanAbsDiff.toFixed(1)} points (${model} scores ${c.bias >= 0 ? 'higher' : 'lower'} by ${Math.abs(c.bias).toFixed(1)} on average)`,
    `- Correlation with Claude's scores: ${c.correlation.toFixed(2)} (1.00 = same order)`,
    `- Same shortlist decision as Claude: ${pct(c.agreementUnshifted)} as is` +
      (c.shift ? `, ${pct(c.agreement)} if ${model}'s scores are moved by ${c.shift > 0 ? '+' : ''}${c.shift}` : ''),
    '',
    `## Claude shortlisted, ${model} didn't (${c.claudeOnly.length})`,
    ...(c.claudeOnly.length ? c.claudeOnly.map(line) : ['- none']),
    '',
    `## ${model} shortlisted, Claude didn't (${c.localOnly.length})`,
    ...(c.localOnly.length ? c.localOnly.map(line) : ['- none']),
    '',
    '## All jobs',
    ...pairs.map(line),
    '',
  ].join('\n');
}

/**
 * Picks the sample: half jobs Claude shortlisted, half it didn't, each spread over its score range,
 * so both kinds of disagreement show. The examples the local model learns from are left out, so it
 * isn't graded on them.
 */
export function pickSample(scored: Array<{ job: JobRow; result: ScoreResult }>, examples: Set<number>, prefs: Preferences, size: number) {
  const pool = scored.filter((s) => !examples.has(s.job.id));
  const above = pool.filter((s) => s.result.score >= cutoff(s.job, prefs));
  const below = pool.filter((s) => s.result.score < cutoff(s.job, prefs));
  const fromAbove = Math.min(above.length, Math.max(Math.ceil(size / 2), size - below.length));
  return [...pickExamples(above, fromAbove), ...pickExamples(below, size - fromAbove)];
}

export async function compareWithClaude(opts: {
  cv: MasterCv;
  prefs: Preferences;
  model: string;
  scored: Array<{ job: JobRow; result: ScoreResult }>;
  size: number;
  log: (msg: string) => void;
}): Promise<{ comparison: Comparison; pairs: Pair[]; secondsPerJob: number }> {
  const examples = pickExamples(opts.scored, 8);
  const scorer = new OllamaScorer({ cv: opts.cv, prefs: opts.prefs, model: opts.model, examples });
  const sample = pickSample(opts.scored, new Set(examples.map((e) => e.job.id)), opts.prefs, opts.size);
  const pairs: Pair[] = [];
  const started = Date.now();
  for (const [i, { job, result }] of sample.entries()) {
    try {
      const local = await scorer.score(job);
      pairs.push({ job, claude: result, local });
      opts.log(`${i + 1}/${sample.length} #${job.id} Claude ${result.score}, ${opts.model} ${local.score}  ${job.company} — ${job.title}`);
    } catch (err) {
      opts.log(`${i + 1}/${sample.length} #${job.id} failed: ${(err as Error).message}`);
    }
  }
  if (!pairs.length) throw new Error(`${opts.model} scored none of the sample`);
  return { comparison: compare(pairs, opts.prefs), pairs, secondsPerJob: (Date.now() - started) / 1000 / sample.length };
}
