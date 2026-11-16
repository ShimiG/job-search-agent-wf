import { cliErrorMessage } from '../util/cli-error.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { classifyEmail } from '../archiver/classify.ts';
import { ConfigError, loadJsonFile, MasterCvSchema, PreferencesSchema, resolvePaths } from '../config.ts';
import { withCertificates } from '../cv/certificates.ts';
import { JobStore } from '../db/store.ts';
import { CostMeter } from '../llm/cost.ts';
import { ollamaHasModel, ollamaModel } from '../llm/ollama.ts';
import { createScorer, scorerProblem } from '../llm/scorer.ts';
import { AnthropicTailor } from '../tailor/llm.ts';
import { formatComparisons, loadComparisons } from './compare.ts';
import { FIXED_SUITES, formatEvalResult, loadDecisionCases, loadEvalProfile, loadFactCheckCases, loadReplyCases, loadScoringCases, SUITE_NAMES, toResult, type SuiteName } from './run.ts';
import { runDecisionsEval, runFactCheckEval, runRepliesEval, runScoringEval } from './suites.ts';
import { saveEvalResult, type EvalResult } from './types.ts';

const HELP = `Evals: fixed, fictional test cases run through the code the agents use.

Usage: npm run eval -- <suite> [options]

  scoring      Scores 26 postings against a fictional CV: are good fits shortlisted and poor fits
               rejected, and do instructions planted in a posting move its score? Uses SCOUT_MODEL.
  factcheck    Checks 24 reworded CV bullets, half of them saying more than the CV does: how many
               does the Tailor take back, and how many honest ones? Uses TAILOR_MODEL.
  replies      Sorts 24 emails with the Archiver's local model. Uses ARCHIVER_MODEL (Ollama).
  all          Each of the three above that can run with what is set up.

  decisions    Not a fixed set: re-scores the jobs you picked or dismissed from your shortlist, with
               your own CV and preferences, and measures the scores against what you chose. The test
               for "is this model, or the advisor, worth it for my search". Uses SCOUT_MODEL; costs
               what scoring that many jobs costs (the advisor is the expensive part). Nothing in your
               database changes.
  compare      Each suite's latest run per model, side by side. Runs nothing.

Options:
  --model <name>   The model to test instead of the one in .env (e.g. claude-haiku-5-5, ollama:gemma3:12b)
  --limit <n>      At most n cases of each kind: a cheap first look
  --rules-only     factcheck: only the rule checks, no model call and no cost
  --no-advisor     scoring, decisions: without the stronger model the scorer may consult, to see what it adds
  --all            decisions: every scored job you decided on, not only the ones that were shortlisted
  --quiet          Don't print each case as it finishes

Each result is saved under data/evals/ and included by: npm run scout -- case-study
The scoring and factcheck suites call Claude and cost money (cents); the result says how much.
`;

/** Thrown when a suite can't run with what is set up; "all" skips it and carries on. */
class NotSetUp extends Error {}

async function runSuite(suite: SuiteName, opts: { model?: string; limit?: number; rulesOnly: boolean; noAdvisor?: boolean; all?: boolean; log?: (line: string) => void }): Promise<EvalResult> {
  const meter = new CostMeter('eval');
  const cost = () => meter.totals().total;

  if (suite === 'decisions') {
    // Your own jobs, CV and preferences: the scorer is built exactly as Scout builds it.
    const paths = resolvePaths();
    if (!existsSync(paths.masterCv) || !existsSync(paths.db)) throw new NotSetUp('There is no CV or job database here yet: this suite re-scores jobs you have decided on.');
    const model = opts.model ?? process.env.SCOUT_MODEL;
    if (opts.noAdvisor) process.env.SCOUT_ADVISOR_MODEL = 'off';
    const problem = await scorerProblem(model);
    if (problem) throw new NotSetUp(problem);
    const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
    const cv = withCertificates(loadJsonFile(paths.masterCv, MasterCvSchema), paths.certificatesDir);
    const store = new JobStore(paths.db);
    try {
      const cases = loadDecisionCases(store, prefs, { all: opts.all, limit: opts.limit });
      const [yes, no] = [cases.filter((c) => c.decision === 'yes').length, cases.filter((c) => c.decision === 'no').length];
      if (!yes || !no) throw new NotSetUp(`It needs jobs you picked and jobs you dismissed${opts.all ? '' : ' from your shortlist'}: there are ${yes} and ${no}.`);
      console.error(`Re-scoring ${cases.length} jobs (${yes} you picked, ${no} you dismissed). Nothing in your database changes.`);
      const scorer = createScorer({ cv, prefs, model, examples: () => store.listClaudeScored(), meter });
      const output = await runDecisionsEval({ cases, scorer, concurrency: ollamaModel(model) ? 1 : 3, log: opts.log });
      return toResult(suite, scorer.model ?? model ?? 'claude-sonnet-5-5', output, cost());
    } finally {
      store.close();
    }
  }

  const { cv, prefs, cfg } = loadEvalProfile();

  if (suite === 'scoring') {
    const model = opts.model ?? process.env.SCOUT_MODEL;
    // The scorer reads this setting when it is built; "off" is what a user would set to run without one.
    if (opts.noAdvisor) process.env.SCOUT_ADVISOR_MODEL = 'off';
    const problem = await scorerProblem(model);
    if (problem) throw new NotSetUp(problem);
    const scorer = createScorer({ cv, prefs, model, meter });
    const output = await runScoringEval({
      cases: loadScoringCases(opts.limit), scorer, threshold: prefs.scoring.threshold, partialThreshold: prefs.scoring.partialThreshold, concurrency: ollamaModel(model) ? 1 : 3, log: opts.log,
    });
    return toResult(suite, scorer.model ?? model ?? 'claude-sonnet-5-5', output, cost());
  }

  if (suite === 'factcheck') {
    if (opts.rulesOnly) return toResult(suite, 'rule checks only', await runFactCheckEval({ cases: loadFactCheckCases(opts.limit), cv, cfg, verifier: null, log: opts.log }), 0);
    if (!process.env.ANTHROPIC_API_KEY) throw new NotSetUp('ANTHROPIC_API_KEY is not set. Add it to .env, or run with --rules-only');
    const tailor = new AnthropicTailor({ model: opts.model ?? process.env.TAILOR_MODEL, meter });
    const output = await runFactCheckEval({ cases: loadFactCheckCases(opts.limit), cv, cfg, verifier: tailor, log: opts.log });
    return toResult(suite, tailor.model, output, cost());
  }

  const name = opts.model ?? process.env.ARCHIVER_MODEL ?? 'ollama:gemma3:12b';
  const model = ollamaModel(name);
  if (!model) throw new NotSetUp('The Archiver reads email with a local model only: use --model ollama:<name>');
  if (!(await ollamaHasModel(model))) throw new NotSetUp(`Ollama isn't running or doesn't have ${model}. Start it with "brew services start ollama", then "ollama pull ${model}"`);
  const output = await runRepliesEval({ cases: loadReplyCases(opts.limit), classify: (mail, body) => classifyEmail(mail, body, model, meter), log: opts.log });
  return toResult('replies', name, output, 0);
}

async function main() {
  const root = process.cwd();
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string' }, limit: { type: 'string' }, 'rules-only': { type: 'boolean' }, 'no-advisor': { type: 'boolean' }, all: { type: 'boolean' }, quiet: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  const which = positionals[0];
  if (!which || values.help) return console.log(HELP);
  if (which === 'compare') return console.log(formatComparisons(loadComparisons(resolvePaths(root).evalsDir)));
  if (which !== 'all' && !SUITE_NAMES.includes(which as SuiteName)) throw new ConfigError(`Unknown suite "${which}". Suites: ${SUITE_NAMES.join(', ')}, all, compare`);
  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new ConfigError('--limit must be a whole number, 1 or more');

  const paths = resolvePaths(root);
  const suites = which === 'all' ? FIXED_SUITES : [which as SuiteName];
  let ran = 0;
  let saved = 0;
  for (const suite of suites) {
    try {
      const result = await runSuite(suite, { model: values.model, limit, rulesOnly: Boolean(values['rules-only']), noAdvisor: Boolean(values['no-advisor']), all: Boolean(values.all), log: values.quiet ? undefined : (line) => console.error(line) });
      // A --limit run is a quick look, not the suite: it is shown, and kept out of the saved results.
      const file = limit ? null : saveEvalResult(paths.evalsDir, result);
      console.log(`\n${formatEvalResult(result)}\n\n${file ? `Saved to ${file}` : 'Not saved: this was a --limit run.'}\n`);
      if (file) saved++;
      ran++;
    } catch (err) {
      if (!(err instanceof NotSetUp)) throw err;
      if (which !== 'all') throw new ConfigError(err.message);
      console.error(`Skipping ${suite}: ${err.message}`);
    }
  }
  if (saved) console.log('Include the results in your write-up with: npm run scout -- case-study\nCompare models with: npm run eval -- compare');
  if (!ran) throw new ConfigError('No suite could run. See the messages above.');
}

main().catch((err) => {
  console.error(cliErrorMessage(err, 'npm run eval') ?? err);
  process.exit(1);
});
