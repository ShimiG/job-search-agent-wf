import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  MasterCvSchema,
  type MasterCv,
  PreferencesSchema,
  SourcesSchema,
  imapCredentialsFromEnv,
  loadJsonFile,
  resolvePaths,
  saveSources,
  type Paths,
} from './config.ts';
import { JobStore } from './db/store.ts';
import { removeJob } from './decisions.ts';
import { CostMeter } from './llm/cost.ts';
import { AnthropicEnricher } from './llm/enrich.ts';
import { openReviewPage } from './review/launch.ts';
import { withCertificates } from './cv/certificates.ts';
import { mergeProjects, parseProjectsFile } from './cv/projects.ts';
import { cvStatus, UPLOAD_CV_FIRST } from './cv/ready.ts';
import { compareWithClaude, formatComparison } from './llm/compare.ts';
import { ollamaModel } from './llm/ollama.ts';
import { archive } from './archiver/run.ts';
import { createScorer, scorerProblem } from './llm/scorer.ts';
import { appliedEmailsSource } from './sources/applications.ts';
import { formatJobDetail, formatJobList, formatMarkdown, formatRunStats } from './output/report.ts';
import { sweepAppliedListings } from './pipeline/applied.ts';
import { formatOutcomeReport, outcomeReport } from './pipeline/outcomes.ts';
import { runScout } from './pipeline/run.ts';
import { formatSpendingReport, spendingReport } from './pipeline/spending.ts';
import { createBoardAdapter } from './sources/ats.ts';
import type { SourceAdapter } from './sources/common.ts';
import { DEFAULT_FEEDS, createEmailAlertAdapter } from './sources/email-alerts.ts';
import { FetchHttp } from './sources/http.ts';
import { detectBoard } from './sources/parse-url.ts';
import type { JobStatus } from './types.ts';
import { JOB_STATUSES } from './types.ts';
import { createLogger, type Logger } from './util/logger.ts';

const HELP = `job-scout — Agent 1: find, filter, dedupe and score job postings

Usage: npm run scout -- <command> [options]

Commands:
  init                         Create config/ and data/ files from the examples
  run [--no-score] [--batch] [--open-review]
                               Fetch all sources, filter, dedupe, and score (--no-score skips the LLM;
                               --batch scores with Claude at half price, with scores usually within the hour);
                               --open-review opens the review page when jobs reach your shortlist
  list [--status s1,s2] [--all] [--limit N] [--json] [--brief] [--md]
                               Ranked shortlist (default status: shortlisted). --md writes a Markdown file
  show <id>                    Full details, score breakdown and history for one job
  pick <id...>                 Send jobs to the Tailor agent (status → selected)
  dismiss <id...>              Drop jobs you don't want (status → dismissed)
  remove <id...>               Take jobs off every list, at any stage (sent ones are archived instead)
  sources                      Configured sources and their last fetch result
  results                      Callback rates (by source, score and how you applied) and what the search has cost
  add-source <careers-url> [--company "Name"] [--token T]
                               Detect the ATS from a careers URL and add it to sources.json
  cv-projects <file.json> [--replace-all]
                               Update the projects in your CV from a file: same ID or name replaces, the rest
                               are added; --replace-all also removes projects the file doesn't list
  reevaluate                   Re-run filters and scoring on everything Scout owns (after editing preferences or CV)
  watch [--cron "0 8 * * *"]   Keep running and do a full run on a schedule
  archive                      Archiver: sort new replies to your applications and update data/applications-report.md
  compare-scorers [--limit 40] Re-score jobs Claude scored with Gemma (Ollama) and compare
`;

function loadEnv(root: string) {
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

function withStore<T>(paths: Paths, fn: (store: JobStore) => T): T {
  const store = new JobStore(paths.db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function parseIds(values: string[]): number[] {
  const ids = values.flatMap((v) => v.split(',')).map((v) => Number(v.replace(/^#/, '')));
  const bad = ids.filter((n) => !Number.isInteger(n) || n <= 0);
  if (ids.length === 0 || bad.length) throw new ConfigError('Pass one or more numeric job IDs, e.g. "pick 12 15"');
  return ids;
}

function buildAdapters(paths: Paths, logger: Logger): SourceAdapter[] {
  const sources = loadJsonFile(paths.sources, SourcesSchema);
  const adapters = sources.boards.filter((b) => b.enabled).map(createBoardAdapter);
  if (sources.emailAlerts.enabled) {
    const credentials = imapCredentialsFromEnv();
    if (!credentials) {
      logger.warn('emailAlerts.enabled is true but IMAP_USER / IMAP_PASSWORD are not set; skipping email alerts');
    } else {
      adapters.push(
        createEmailAlertAdapter({
          credentials,
          mailbox: sources.emailAlerts.mailbox,
          sinceDays: sources.emailAlerts.sinceDays,
          feeds: sources.emailAlerts.feeds.length ? sources.emailAlerts.feeds : DEFAULT_FEEDS,
          logger,
        }),
      );
    }
  }
  if (adapters.length === 0) logger.warn('No enabled sources. Add some with "add-source <careers-url>".');
  return adapters;
}

async function commandCompareScorers(paths: Paths, logger: Logger, size: number) {
  const model = ollamaModel(process.env.COMPARE_MODEL ?? 'ollama:gemma3:12b')!;
  const problem = await scorerProblem(`ollama:${model}`);
  if (problem) throw new ConfigError(problem);
  const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
  const scored = withStore(paths, (store) => store.listClaudeScored());
  logger.info(`Re-scoring up to ${size} of the ${scored.length} jobs Claude scored with ${model}. Nothing is saved to the jobs.`);
  const { comparison, pairs, secondsPerJob } = await compareWithClaude({
    cv: withCertificates(loadJsonFile(paths.masterCv, MasterCvSchema), paths.certificatesDir),
    prefs,
    model,
    scored,
    size,
    log: (msg) => logger.info(msg),
  });
  const report = formatComparison(comparison, model, secondsPerJob, pairs);
  const file = path.join(path.dirname(paths.db), 'scorer-comparison.md');
  writeFileSync(file, report);
  console.log('\n' + report.split('\n## All jobs')[0]);
  console.log(`Full report: ${file}`);
}

async function commandRun(paths: Paths, logger: Logger, noScore: boolean, batch = false) {
  const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
  const model = process.env.SCOUT_MODEL;
  const meter = new CostMeter('scout');
  let cv: MasterCv | undefined;
  if (!noScore) {
    const problem = await scorerProblem(model);
    if (problem) throw new ConfigError(`${problem}, or run with --no-score to skip scoring.`);
    // Certificates you uploaded count too: "AWS certification required" is met if you hold it.
    cv = withCertificates(loadJsonFile(paths.masterCv, MasterCvSchema), paths.certificatesDir);
  }
  const store = new JobStore(paths.db);
  try {
    const scorer = cv && createScorer({ cv, prefs, model, examples: () => store.listClaudeScored(), meter });
    const { emailAlerts } = loadJsonFile(paths.sources, SourcesSchema);
    const applied = appliedEmailsSource(emailAlerts, imapCredentialsFromEnv());
    // The web lookup is Claude's, so it needs the API key even when scoring is local.
    const enricher = scorer && prefs.enrich.enabled && process.env.ANTHROPIC_API_KEY ? new AnthropicEnricher({ model: process.env.ENRICH_MODEL, meter }) : undefined;
    const stats = await runScout({ store, adapters: buildAdapters(paths, logger), http: new FetchHttp(), prefs, logger, scorer, applied, enricher, meter, batch, checkLinkedIn: emailAlerts.checkClosed ? undefined : null });
    console.log('\n' + formatRunStats(stats));
    const shortlist = store.listByStatus(['shortlisted']);
    if (shortlist.length) console.log(`\n${shortlist.length} jobs on your shortlist. See them with: npm run scout -- list`);
    return stats;
  } finally {
    store.close();
  }
}

function commandList(paths: Paths, values: Record<string, string | boolean | undefined>) {
  const statuses = values.all
    ? (JOB_STATUSES as readonly JobStatus[])
    : String(values.status ?? 'shortlisted')
        .split(',')
        .map((s) => s.trim() as JobStatus);
  const unknown = statuses.filter((s) => !JOB_STATUSES.includes(s));
  if (unknown.length) throw new ConfigError(`Unknown status: ${unknown.join(', ')}. Valid: ${JOB_STATUSES.join(', ')}`);
  const store = new JobStore(paths.db);
  try {
    const limit = values.limit ? Number(values.limit) : 50;
    const jobs = store.listByStatus(statuses).slice(0, limit);
    if (values.json) {
      console.log(JSON.stringify(jobs.map(({ description, ...rest }) => rest), null, 2));
    } else if (values.md) {
      const file = path.join(paths.dataDir, `shortlist-${new Date().toISOString().slice(0, 10)}.md`);
      writeFileSync(file, formatMarkdown(jobs, new Date()), 'utf8');
      console.log(`Wrote ${jobs.length} jobs to ${file}`);
    } else {
      console.log(formatJobList(jobs, { details: !values.brief }));
      const counts = store.statusCounts();
      console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  '));
    }
  } finally {
    store.close();
  }
}

function commandTransition(paths: Paths, ids: number[], to: 'selected' | 'dismissed') {
  const allowedFrom: Record<typeof to, JobStatus[]> = {
    selected: ['shortlisted', 'low_score', 'dismissed', 'queued', 'score_error'],
    dismissed: ['shortlisted', 'low_score', 'selected', 'queued', 'score_error'],
  };
  const store = new JobStore(paths.db);
  try {
    const now = new Date().toISOString();
    for (const id of ids) {
      const job = store.get(id);
      if (!job) {
        console.log(`#${id}: not found`);
        continue;
      }
      if (!allowedFrom[to].includes(job.status)) {
        console.log(`#${id}: is "${job.status}", can't move to "${to}"`);
        continue;
      }
      store.setStatus(id, to, null, 'user', now);
      console.log(`#${id}: ${job.company} — ${job.title} → ${to}`);
    }
    const swept = sweepAppliedListings(store, now);
    const others = swept.applied + swept.inProgress + swept.dismissed;
    if (others) console.log(`${others} other listing(s) of these jobs removed from Scout.`);
  } finally {
    store.close();
  }
}

function commandSources(paths: Paths) {
  const sources = loadJsonFile(paths.sources, SourcesSchema);
  const store = new JobStore(paths.db);
  try {
    const health = new Map(store.sourceHealth().map((h) => [h.source_key, h]));
    if (sources.boards.length === 0) console.log('No boards configured yet.');
    for (const board of sources.boards) {
      const adapter = createBoardAdapter(board);
      const h = health.get(adapter.key);
      const state = !board.enabled
        ? 'disabled'
        : !h
          ? 'never fetched'
          : h.last_error_at && (!h.last_success_at || h.last_error_at > h.last_success_at)
            ? `FAILING since ${h.last_error_at.slice(0, 16).replace('T', ' ')}: ${h.last_error}`
            : `ok ${h.last_success_at?.slice(0, 16).replace('T', ' ')} (${h.last_job_count} posting${h.last_job_count === 1 ? '' : 's'})`;
      console.log(`${adapter.key.padEnd(30)} ${board.company.padEnd(22)} ${state}`);
    }
    const email = sources.emailAlerts;
    console.log(`email alerts: ${email.enabled ? `on (${(email.feeds.length ? email.feeds : DEFAULT_FEEDS).map((f) => f.name).join(', ')})` : 'off'}`);
  } finally {
    store.close();
  }
}

function commandAddSource(paths: Paths, url: string | undefined, values: Record<string, string | boolean | undefined>) {
  if (!url) throw new ConfigError('Usage: add-source <careers-url> [--company "Name"] [--token T]');
  const detected = detectBoard(url, {
    company: typeof values.company === 'string' ? values.company : undefined,
    token: typeof values.token === 'string' ? values.token : undefined,
  });
  if (!detected.ok) throw new ConfigError(detected.reason);
  const sources = loadJsonFile(paths.sources, SourcesSchema);
  const key = createBoardAdapter(detected.board).key;
  if (sources.boards.some((b) => createBoardAdapter(b).key === key)) {
    console.log(`${key} is already configured.`);
    return;
  }
  sources.boards.push(detected.board);
  saveSources(paths.sources, sources);
  console.log(`Added ${key} (${detected.board.company}). Edit config/sources.json to rename it.`);
}

/** Replaces or adds projects in data/master-cv.json from a file, keeping a backup of the old CV. */
function commandCvProjects(paths: Paths, file: string | undefined, replaceAll: boolean) {
  if (!file) throw new ConfigError('Usage: cv-projects <file.json> [--replace-all]');
  if (!existsSync(file)) throw new ConfigError(`No such file: ${file}`);
  if (!existsSync(paths.masterCv)) throw new ConfigError(`No CV yet at ${paths.masterCv}. Upload one on the review page first (Settings → Your CV).`);
  let incoming;
  try {
    incoming = parseProjectsFile(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new ConfigError(`${file} isn't a list of projects: ${(err as Error).message}`);
  }
  let merged;
  try {
    merged = mergeProjects(loadJsonFile(paths.masterCv, MasterCvSchema), incoming, { replaceAll });
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const backup = paths.masterCv.replace(/\.json$/, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  copyFileSync(paths.masterCv, backup);
  writeFileSync(paths.masterCv, JSON.stringify(merged.cv, null, 2) + '\n');
  const list = (label: string, names: string[]) => names.length && console.log(`${label}: ${names.join(', ')}`);
  list('Added', merged.added);
  list('Updated', merged.updated);
  list('Kept as they were', merged.kept);
  list('Removed', merged.removed);
  const highlights = merged.cv.projects.reduce((n, p) => n + p.highlights.length, 0);
  console.log(`Your CV now has ${merged.cv.projects.length} project(s) with ${highlights} highlights. The old CV is at ${backup}`);
  if (merged.kept.length) console.log('If a kept project is an older entry for one you just added under another name, run again with --replace-all.');
}

function commandInit(root: string, paths: Paths) {
  const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  const pairs: Array<[string, string]> = [
    [path.join(examples, 'preferences.json'), paths.preferences],
    [path.join(examples, 'sources.json'), paths.sources],
    [path.join(examples, 'tailor.json'), paths.tailor],
    [path.join(examples, 'submit.json'), paths.submit],
    [path.join(examples, 'master-cv.json'), paths.masterCv],
    [path.join(examples, '.env.example'), path.join(root, '.env')],
  ];
  for (const [from, to] of pairs) {
    if (existsSync(to)) {
      console.log(`exists   ${path.relative(root, to)}`);
    } else {
      copyFileSync(from, to);
      console.log(`created  ${path.relative(root, to)}`);
    }
  }
  console.log('\nNext: fill in data/master-cv.json, config/tailor.json and config/submit.json, tune config/preferences.json, add your API key to .env,');
  console.log('then add boards with "npm run scout -- add-source <careers-url>".');
}

async function commandWatch(paths: Paths, logger: Logger, cronExpr: string, noScore: boolean, batch = false) {
  const cron = await import('node-cron');
  if (!cron.validate(cronExpr)) throw new ConfigError(`Invalid cron expression: ${cronExpr}`);
  let running = false;
  const tick = async () => {
    if (running) return logger.warn('Previous run still in progress; skipping this tick');
    running = true;
    try {
      await commandRun(paths, logger, noScore, batch);
    } catch (err) {
      logger.error(`Run failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  cron.schedule(cronExpr, tick);
  logger.info(`Watching. Next runs follow "${cronExpr}" (local time). Ctrl+C to stop.`);
}

async function main() {
  const root = process.cwd();
  loadEnv(root);
  const paths = resolvePaths(root);
  const logger = createLogger();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'no-score': { type: 'boolean' },
      batch: { type: 'boolean' },
      'replace-all': { type: 'boolean' },
      'open-review': { type: 'boolean' },
      status: { type: 'string' },
      all: { type: 'boolean' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      brief: { type: 'boolean' },
      md: { type: 'boolean' },
      company: { type: 'string' },
      token: { type: 'string' },
      cron: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  const noScore = Boolean(values['no-score']);
  const batch = Boolean(values.batch);

  switch (command) {
    case 'init':
      return commandInit(root, paths);
    case 'run': {
      // A run started elsewhere (the review page, LangGraph, an earlier schedule) is still going.
      const busy = withStore(paths, (store) => store.latestRun('scout'));
      if (busy && !busy.finishedAt && Date.now() - Date.parse(busy.startedAt) < 3 * 3_600_000) {
        logger.info(`Scout is already running (started ${busy.startedAt}); skipping this run.`);
        return;
      }
      // Scoring without a CV would spend tokens on meaningless scores (scheduled runs included).
      if (!noScore && !cvStatus(paths.masterCv).ready) {
        logger.warn(`${cvStatus(paths.masterCv).reason}. ${UPLOAD_CV_FIRST} Skipping this run.`);
        return;
      }
      await commandRun(paths, logger, noScore, batch);
      if (values['open-review'] && withStore(paths, (store) => store.listByStatus(['shortlisted']).length)) await openReviewPage(logger);
      return;
    }
    case 'list':
      return commandList(paths, values);
    case 'show': {
      const [id] = parseIds(args);
      const store = new JobStore(paths.db);
      try {
        const job = store.get(id!);
        console.log(job ? formatJobDetail(job, store.history(job.id)) : `#${id}: not found`);
      } finally {
        store.close();
      }
      return;
    }
    case 'pick':
      return commandTransition(paths, parseIds(args), 'selected');
    case 'dismiss':
      return commandTransition(paths, parseIds(args), 'dismissed');
    case 'remove': {
      const store = new JobStore(paths.db);
      try {
        for (const id of parseIds(args)) {
          try {
            const { from } = removeJob(store, id);
            console.log(`#${id}: removed (was "${from}")`);
          } catch (err) {
            console.log(`#${id}: ${(err as Error).message}`);
          }
        }
      } finally {
        store.close();
      }
      return;
    }
    case 'sources':
      return commandSources(paths);
    case 'results': {
      const store = new JobStore(paths.db);
      try {
        console.log(formatOutcomeReport(outcomeReport(store)));
        console.log('\n' + formatSpendingReport(spendingReport(store)));
      } finally {
        store.close();
      }
      return;
    }
    case 'add-source':
      return commandAddSource(paths, args[0], values);
    case 'cv-projects':
      return commandCvProjects(paths, args[0], Boolean(values['replace-all']));
    case 'reevaluate': {
      const store = new JobStore(paths.db);
      try {
        const n = store.requeueForReevaluation(new Date().toISOString());
        console.log(`${n} jobs will be re-filtered and re-scored on the next run.`);
      } finally {
        store.close();
      }
      return;
    }
    case 'archive': {
      const busy = withStore(paths, (store) => store.latestRun('archiver'));
      if (busy && !busy.finishedAt && Date.now() - Date.parse(busy.startedAt) < 2 * 3_600_000) {
        logger.info(`The Archiver is already running (started ${busy.startedAt}); skipping this run.`);
        return;
      }
      await archive(paths, logger);
      return;
    }
    case 'compare-scorers':
      return commandCompareScorers(paths, logger, Number(values.limit ?? 40));
    case 'watch':
      return commandWatch(paths, logger, String(values.cron ?? '0 8 * * *'), noScore, batch);
    default:
      console.log(HELP);
      if (command && command !== 'help' && !values.help) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
