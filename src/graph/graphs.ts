// LangGraph wrappers around the three agents, served by `npm run graph` (langgraph.json).
// Each agent keeps its own logic; these graphs build the same dependencies the CLIs build,
// and the pipeline graph replaces "pick" and "approve" on the command line with interrupts.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import {
  ConfigError,
  MasterCvSchema,
  PreferencesSchema,
  SourcesSchema,
  imapCredentialsFromEnv,
  loadJsonFile,
  resolvePaths,
  type Paths,
} from '../config.ts';
import { applyPicks, applyReview, unresolvedCount, type Skipped } from '../decisions.ts';
import { JobStore } from '../db/store.ts';
import { openReviewPage, reviewUrl } from '../review/launch.ts';
import { cvStatus, UPLOAD_CV_FIRST } from '../cv/ready.ts';
import { AnthropicEnricher } from '../llm/enrich.ts';
import { AnthropicScorer } from '../llm/scorer.ts';
import { runScout, type RunStats } from '../pipeline/run.ts';
import { appliedEmailsSource } from '../sources/applications.ts';
import { createBoardAdapter } from '../sources/ats.ts';
import type { SourceAdapter } from '../sources/common.ts';
import { DEFAULT_FEEDS, createEmailAlertAdapter } from '../sources/email-alerts.ts';
import { FetchHttp } from '../sources/http.ts';
import { AnthropicFieldMapper } from '../submit/llm.ts';
import { createImapCodeSource } from '../submit/otp.ts';
import { openBrowser, runSubmitter, type SubmitRunStats } from '../submit/run.ts';
import { SubmitFileSchema, type SubmitMode } from '../submit/schema.ts';
import { AnthropicTailor } from '../tailor/llm.ts';
import { launchPdfEngine } from '../tailor/render.ts';
import { runTailor, type TailorRunStats } from '../tailor/run.ts';
import { TailorConfigSchema } from '../tailor/schema.ts';
import type { JobRow } from '../types.ts';
import { createLogger, type Logger } from '../util/logger.ts';

// The dev server runs from the project root, like the npm scripts.
const envFile = path.join(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function withStore<T>(fn: (store: JobStore) => T | Promise<T>): Promise<T> {
  const store = new JobStore(resolvePaths().db);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------- agents

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
  if (adapters.length === 0) logger.warn('No enabled sources. Add some with "npm run scout -- add-source <careers-url>".');
  return adapters;
}

export async function scoutAgent(noScore = false): Promise<RunStats> {
  const paths = resolvePaths();
  const logger = createLogger();
  const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
  let scorer: AnthropicScorer | undefined;
  if (!noScore) {
    if (!cvStatus().ready) throw new ConfigError(UPLOAD_CV_FIRST);
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ConfigError('ANTHROPIC_API_KEY is not set. Add it to .env, or run with noScore: true to skip scoring.');
    }
    scorer = new AnthropicScorer({ cv: loadJsonFile(paths.masterCv, MasterCvSchema), prefs, model: process.env.SCOUT_MODEL });
  }
  const applied = appliedEmailsSource(loadJsonFile(paths.sources, SourcesSchema).emailAlerts, imapCredentialsFromEnv());
  const enricher = scorer && prefs.enrich.enabled ? new AnthropicEnricher({ model: process.env.ENRICH_MODEL }) : undefined;
  return withStore((store) => runScout({ store, adapters: buildAdapters(paths, logger), http: new FetchHttp(), prefs, logger, scorer, applied, enricher }));
}

export async function tailorAgent(jobIds: number[] | undefined, noPdf = false): Promise<TailorRunStats> {
  if (!process.env.ANTHROPIC_API_KEY) throw new ConfigError('ANTHROPIC_API_KEY is not set. Add it to .env.');
  const paths = resolvePaths();
  if (!existsSync(paths.tailor)) throw new ConfigError(`Missing ${paths.tailor}. Run "npm run scout -- init" to create it.`);
  const cfg = loadJsonFile(paths.tailor, TailorConfigSchema);
  const cv = loadJsonFile(paths.masterCv, MasterCvSchema);
  const llm = new AnthropicTailor({ model: process.env.TAILOR_MODEL });
  const pdf = cfg.pdf.enabled && !noPdf ? await launchPdfEngine(cfg.pdf.browserPath) : null;
  try {
    return await withStore((store) =>
      runTailor({ store, cv, cfg, writer: llm, verifier: llm, pdf, outDir: paths.applicationsDir, logger: createLogger(), model: llm.model }, { jobIds }),
    );
  } finally {
    await pdf?.close();
  }
}

export async function submitAgent(jobIds: number[] | undefined, mode: SubmitMode = 'assist'): Promise<SubmitRunStats> {
  if (!['assist', 'prepare', 'auto'].includes(mode)) throw new ConfigError('mode must be assist, prepare or auto');
  const paths = resolvePaths();
  const logger = createLogger();
  if (!existsSync(paths.submit)) throw new ConfigError(`Missing ${paths.submit}. Run "npm run scout -- init" to create it.`);
  const settings = loadJsonFile(paths.submit, SubmitFileSchema);
  if (mode === 'auto' && !settings.autoSubmit) {
    throw new ConfigError('Auto mode is off. Set "autoSubmit": true in config/submit.json if you want it, or use mode "assist".');
  }
  const cv = loadJsonFile(paths.masterCv, MasterCvSchema);
  const tailor = loadJsonFile(paths.tailor, TailorConfigSchema);
  const mapper = process.env.ANTHROPIC_API_KEY ? new AnthropicFieldMapper({ model: process.env.TAILOR_MODEL }) : null;
  if (!mapper) logger.warn('ANTHROPIC_API_KEY not set: unusual questions will be left for you');
  const imap = imapCredentialsFromEnv();
  const browser = await openBrowser({ browserPath: settings.browserPath, headless: mode !== 'assist', userDataDir: paths.browserProfile });
  try {
    return await withStore((store) =>
      runSubmitter(
        {
          store,
          cv,
          answers: settings,
          contact: tailor.contact,
          cfg: settings,
          mapper,
          browser,
          logger,
          codes: imap ? createImapCodeSource(imap, logger) : null,
          onAssist: (info) =>
            logger.info(`#${info.job.id} ${info.job.company} — ${info.job.title}: the form is open in the browser. Review it and click Submit.`, {
              needsYou: info.unresolved.map((u) => u.label),
              modelWritten: info.modelAnswers.map((m) => m.label),
              blockers: info.blockers,
            }),
        },
        mode,
        { jobIds },
      ),
    );
  } finally {
    await browser.close();
  }
}

/** Your Submitter settings, or null when config/submit.json is missing. */
function submitSettings() {
  const paths = resolvePaths();
  return existsSync(paths.submit) ? loadJsonFile(paths.submit, SubmitFileSchema) : null;
}

/**
 * With "Review before sending" off, what the Tailor just finished goes straight to the Submitter.
 * Applications the fact-check flagged are held back for you. Returns null when review is on.
 */
export async function sendWithoutReview(jobIds: number[], mode: SubmitMode = 'assist') {
  if (submitSettings()?.requireApproval !== false) return null;
  const { approved, skipped } = await withStore((store) =>
    applyReview(store, { approve: jobIds.filter((id) => store.get(id)?.status === 'tailored') }),
  );
  const submitStats = approved.length ? await submitAgent(approved, mode) : undefined;
  return { approved, held: skipped, submitStats };
}

// ---------------------------------------------------------------- your decisions

export { applyPicks, applyReview };

const brief = (j: JobRow) => ({
  id: j.id,
  company: j.company,
  title: j.title,
  location: j.location,
  score: j.score,
  // From a job alert email: scored on title, company and location only. Read the full posting first.
  ...(j.descriptionIsPartial ? { partial: true } : {}),
  url: j.url,
  // For an alert job: where the full posting was found, and the company's page to apply on.
  ...(j.postingUrl ? { fullPosting: j.postingUrl } : {}),
  ...(j.enrichedAt && j.applyUrl ? { applyPage: j.applyUrl } : {}),
});

/**
 * A run is starting: open the review page, which follows it from here (scoring, your picks, tailoring,
 * your approval, submitting). Skipped when the page started the run. Its own node, because a node that
 * pauses (pick) runs again from the top when resumed, and this must happen once.
 */
async function notifyNode(s: { quiet?: boolean }): Promise<Record<string, never>> {
  if (!s.quiet) await openReviewPage(createLogger());
  return {};
}

// ---------------------------------------------------------------- single-agent graphs

const AgentInput = {
  /** Limit the run to these job IDs (default: everything waiting for this agent). */
  jobIds: Annotation<number[] | undefined>,
};

export const scout = new StateGraph(
  Annotation.Root({
    noScore: Annotation<boolean | undefined>,
    /** Started from the review page, which is already open. */
    quiet: Annotation<boolean | undefined>,
    scoutStats: Annotation<RunStats | undefined>,
  }),
)
  .addNode('notify', notifyNode)
  .addNode('scout', async (s) => ({ scoutStats: await scoutAgent(s.noScore) }))
  .addEdge(START, 'notify')
  .addEdge('notify', 'scout')
  .addEdge('scout', END)
  .compile({ name: 'scout' });

export const tailor = new StateGraph(
  Annotation.Root({
    ...AgentInput,
    noPdf: Annotation<boolean | undefined>,
    /** Submitter mode, used when "Review before sending" is off. */
    mode: Annotation<SubmitMode | undefined>,
    tailorStats: Annotation<TailorRunStats | undefined>,
    submitStats: Annotation<SubmitRunStats | undefined>,
  }),
)
  .addNode('tailor', async (s) => ({ tailorStats: await tailorAgent(s.jobIds, s.noPdf) }))
  // Review off: straight on to the Submitter. Review on: the jobs wait in Ready to send.
  .addNode('send', async (s) => {
    const ids = s.jobIds ?? (await withStore((store) => store.listByStatus(['tailored']).map((j) => j.id)));
    const sent = await sendWithoutReview(ids, s.mode);
    return sent?.submitStats ? { submitStats: sent.submitStats } : {};
  })
  .addEdge(START, 'tailor')
  .addEdge('tailor', 'send')
  .addEdge('send', END)
  .compile({ name: 'tailor' });

export const submitter = new StateGraph(
  Annotation.Root({
    ...AgentInput,
    mode: Annotation<SubmitMode | undefined>,
    submitStats: Annotation<SubmitRunStats | undefined>,
  }),
)
  .addNode('submit', async (s) => ({ submitStats: await submitAgent(s.jobIds, s.mode) }))
  .addEdge(START, 'submit')
  .addEdge('submit', END)
  .compile({ name: 'submitter' });

// ---------------------------------------------------------------- pipeline

const PipelineState = Annotation.Root({
  noScore: Annotation<boolean | undefined>,
  noPdf: Annotation<boolean | undefined>,
  /** Submitter mode; "assist" (default) waits for you to click Submit in the browser. */
  mode: Annotation<SubmitMode | undefined>,
  /** Started from the review page, which is already open. */
  quiet: Annotation<boolean | undefined>,
  scoutStats: Annotation<RunStats | undefined>,
  picked: Annotation<number[]>({ reducer: (_, b) => b, default: () => [] }),
  tailorStats: Annotation<TailorRunStats | undefined>,
  approved: Annotation<number[]>({ reducer: (_, b) => b, default: () => [] }),
  submitStats: Annotation<SubmitRunStats | undefined>,
  skipped: Annotation<Skipped[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});
type Pipeline = typeof PipelineState.State;

// interrupt() replays the node from the top on resume, so the database writes come after it.
async function pickNode(): Promise<Partial<Pipeline>> {
  const shortlist = await withStore((store) => store.listByStatus(['shortlisted']).map(brief));
  if (!shortlist.length) return { picked: [] };
  const answer = interrupt({
    question: `Pick on the review page (${reviewUrl()}), or resume here with {"pick": [ids], "dismiss": [ids]}.`,
    reviewPage: reviewUrl(),
    shortlist,
  });
  return withStore((store) => applyPicks(store, answer));
}

async function reviewNode(s: Pipeline): Promise<Partial<Pipeline>> {
  const tailored = await withStore((store) =>
    s.picked
      .map((id) => store.get(id))
      .filter((j): j is JobRow => j?.status === 'tailored')
      .map((j) => ({ ...brief(j), folder: store.latestApplication(j.id)?.dir, unverified: unresolvedCount(store, j.id) })),
  );
  if (!tailored.length) return { approved: [] };
  // Review off: no pause. Clean applications are approved; flagged ones wait in Ready to send.
  if (submitSettings()?.requireApproval === false) {
    return withStore((store) => applyReview(store, { approve: tailored.map((t) => t.id) }));
  }
  const answer = interrupt({
    question: `Approve on the review page (${reviewUrl()}), or resume here with {"approve": [ids], "reject": [ids], "force": false}.`,
    reviewPage: reviewUrl(),
    tailored,
  });
  return withStore((store) => applyReview(store, answer));
}

const continueIf = (key: 'picked' | 'approved', next: string) => (s: Pipeline) => (s[key].length ? next : END);

export const pipeline = new StateGraph(PipelineState)
  .addNode('notify', notifyNode)
  .addNode('scout', async (s) => ({ scoutStats: await scoutAgent(s.noScore) }))
  .addNode('pick', pickNode)
  .addNode('tailor', async (s) => ({ tailorStats: await tailorAgent(s.picked, s.noPdf) }))
  .addNode('review', reviewNode)
  .addNode('submit', async (s) => ({ submitStats: await submitAgent(s.approved, s.mode) }))
  .addEdge(START, 'notify')
  .addEdge('notify', 'scout')
  .addEdge('scout', 'pick')
  .addConditionalEdges('pick', continueIf('picked', 'tailor'), ['tailor', END])
  .addEdge('tailor', 'review')
  .addConditionalEdges('review', continueIf('approved', 'submit'), ['submit', END])
  .addEdge('submit', END)
  .compile({ name: 'pipeline' });
