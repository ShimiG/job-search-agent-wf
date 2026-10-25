import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ConfigError,
  MasterCvSchema,
  PreferencesSchema,
  SourcesSchema,
  imapCredentialsFromEnv,
  loadJsonFile,
  resolvePaths,
  saveSources,
  type Paths,
} from './config.ts';
import { JobStore } from './db/store.ts';
import { AnthropicEnricher } from './llm/enrich.ts';
import { openReviewPage } from './review/launch.ts';
import { cvStatus, UPLOAD_CV_FIRST } from './cv/ready.ts';
import { AnthropicScorer } from './llm/scorer.ts';
import { appliedEmailsSource } from './sources/applications.ts';
import { formatJobDetail, formatJobList, formatMarkdown, formatRunStats } from './output/report.ts';
import { runScout } from './pipeline/run.ts';
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
  run [--no-score] [--open-review]
                               Fetch all sources, filter, dedupe, and score (--no-score skips the LLM);
                               --open-review opens the review page when jobs reach your shortlist
  list [--status s1,s2] [--all] [--limit N] [--json] [--brief] [--md]
                               Ranked shortlist (default status: shortlisted). --md writes a Markdown file
  show <id>                    Full details, score breakdown and history for one job
  pick <id...>                 Send jobs to the Tailor agent (status → selected)
  dismiss <id...>              Drop jobs you don't want (status → dismissed)
  sources                      Configured sources and their last fetch result
  add-source <careers-url> [--company "Name"] [--token T]
                               Detect the ATS from a careers URL and add it to sources.json
  reevaluate                   Re-run filters and scoring on everything Scout owns (after editing preferences or CV)
  watch [--cron "0 8 * * *"]   Keep running and do a full run on a schedule
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

async function commandRun(paths: Paths, logger: Logger, noScore: boolean) {
  const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
  let scorer: AnthropicScorer | undefined;
  if (!noScore) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ConfigError('ANTHROPIC_API_KEY is not set. Add it to .env, or run with --no-score to skip scoring.');
    }
    const cv = loadJsonFile(paths.masterCv, MasterCvSchema);
    scorer = new AnthropicScorer({ cv, prefs, model: process.env.SCOUT_MODEL });
  }
  const store = new JobStore(paths.db);
  try {
    const applied = appliedEmailsSource(loadJsonFile(paths.sources, SourcesSchema).emailAlerts, imapCredentialsFromEnv());
    const enricher = scorer && prefs.enrich.enabled ? new AnthropicEnricher({ model: process.env.ENRICH_MODEL }) : undefined;
    const stats = await runScout({ store, adapters: buildAdapters(paths, logger), http: new FetchHttp(), prefs, logger, scorer, applied, enricher });
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

async function commandWatch(paths: Paths, logger: Logger, cronExpr: string, noScore: boolean) {
  const cron = await import('node-cron');
  if (!cron.validate(cronExpr)) throw new ConfigError(`Invalid cron expression: ${cronExpr}`);
  let running = false;
  const tick = async () => {
    if (running) return logger.warn('Previous run still in progress; skipping this tick');
    running = true;
    try {
      await commandRun(paths, logger, noScore);
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
      await commandRun(paths, logger, noScore);
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
    case 'sources':
      return commandSources(paths);
    case 'add-source':
      return commandAddSource(paths, args[0], values);
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
    case 'watch':
      return commandWatch(paths, logger, String(values.cron ?? '0 8 * * *'), noScore);
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
