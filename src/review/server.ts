import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { z } from 'zod';
import { loadJsonFile, MasterCvSchema, PreferencesSchema, resolvePaths } from '../config.ts';
import { addCertificate, CERTIFICATE_MAX_BYTES, CERTIFICATE_TYPES, certificateFile, listCertificates, removeCertificate, withCertificates } from '../cv/certificates.ts';
import { importCv } from '../cv/import.ts';
import { cvStatus, UPLOAD_CV_FIRST } from '../cv/ready.ts';
import { applyPicks, applyReview, removeJob } from '../decisions.ts';
import { JobStore } from '../db/store.ts';
import { scoutAgent, sendWithoutReview, submitAgent, tailorAgent } from '../graph/graphs.ts';
import { CostMeter } from '../llm/cost.ts';
import { AnthropicEnricher, enrichCost } from '../llm/enrich.ts';
import { checkApplyPage, pastedPosting, postingFromLink } from '../llm/posting.ts';
import { createScorer } from '../llm/scorer.ts';
import { sweepAppliedListings } from '../pipeline/applied.ts';
import { jobsInBatches } from '../pipeline/batch.ts';
import { addManualJob } from '../pipeline/manual.ts';
import { outcomeReport, WAITING_DAYS } from '../pipeline/outcomes.ts';
import { placeByScore, resortByCutoff } from '../pipeline/run.ts';
import { spendingReport } from '../pipeline/spending.ts';
import { saveShortlistCutoff, shortlistCutoff } from '../settings.ts';
import { ARCHIVE_AFTER_DAYS, buildReport, groupApplications, isArchived, STAGES } from '../archiver/report.ts';
import { markSubmitted } from '../submit/run.ts';
import { MODEL_SOURCES, SubmitFileSchema, type PlannedAnswer, type SubmitMode } from '../submit/schema.ts';
import { TailorConfigSchema, type VerificationReport } from '../tailor/schema.ts';
import type { JobRow } from '../types.ts';
import { redoNote } from '../tailor/keywords.ts';
import { similarityRedoNote } from '../tailor/similarity.ts';
import { styleRedoNote } from '../tailor/style.ts';
import { PAGE } from './page.ts';

/*
 * The review page coordinates a whole run: start Scout, watch matches arrive as they're scored, pick
 * jobs, follow the Tailor, approve applications, and follow the Submitter.
 *
 * With the LangGraph server up, every step runs there (visible in Studio): a waiting pipeline run is
 * continued at its pick and approval pauses, and anything else starts the matching single-agent graph.
 * With it down, this process runs the agents itself, so the flow never depends on which server is on.
 */

const envFile = path.join(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const PORT = Number(process.env.REVIEW_PORT ?? 4100);
const LANGGRAPH = (process.env.LANGGRAPH_URL ?? 'http://127.0.0.1:2024').replace(/\/+$/, '');
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// ---------------------------------------------------------------- phone access
// Off by default: the page answers only this Mac. REVIEW_REMOTE=true also answers your network (Wi-Fi,
// Tailscale), but only to devices that opened the secret link once: it sets a lasting cookie.
const REMOTE = process.env.REVIEW_REMOTE === 'true';
const COOKIE = 'review_key';

function remoteKey(): string {
  const file = path.join(resolvePaths().dataDir, 'review-key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(24).toString('base64url');
  writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}
const KEY = REMOTE ? remoteKey() : '';

const sameKey = (given: string | null | undefined) => {
  if (!given || !KEY) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
};
const fromThisMac = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
const cookieKey = (req: IncomingMessage) =>
  (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];

/** Addresses your phone can use: Tailscale (100.64.0.0/10) and your Wi-Fi network. */
function phoneLinks() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === 'IPv4' && !a.internal))
    .map((a) => {
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = x === 100 && y! >= 64 && y! <= 127;
      return { via: tailscale ? 'Tailscale (works anywhere)' : 'Wi-Fi (same network as this Mac)', url: `http://${a.address}:${PORT}/?key=${KEY}` };
    })
    .sort((a, b) => Number(b.via.startsWith('Tailscale')) - Number(a.via.startsWith('Tailscale')));
}
const MODES = ['prepare', 'assist', 'auto'] as const;

/**
 * A meter for Claude calls this page makes itself (CV upload, a pasted link, "find the application
 * page"). Runs `fn`, then saves what it spent, whether or not it succeeded.
 */
async function metered<T>(fn: (meter: CostMeter) => Promise<T>): Promise<T> {
  const meter = new CostMeter('review');
  try {
    return await fn(meter);
  } finally {
    withStore((store) => {
      meter.attach(store);
      meter.detach();
    });
  }
}

function withStore<T>(fn: (store: JobStore) => T): T {
  const store = new JobStore(resolvePaths().db);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------- LangGraph

async function langgraph<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${LANGGRAPH}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`LangGraph ${route}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

type Stage = 'scouting' | 'pick' | 'tailoring' | 'review' | 'submitting' | 'done' | 'error' | 'working';
interface Pipeline {
  threadId: string;
  stage: Stage;
  mode: SubmitMode;
}

/** The newest pipeline run and where it is. Older runs left paused are ignored. */
async function currentPipeline(): Promise<Pipeline | null> {
  const threads = await langgraph<Array<{ thread_id: string; status: string; metadata?: { graph_id?: string } }>>('/threads/search', {
    metadata: { graph_id: 'pipeline' },
    limit: 1,
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  const t = threads[0];
  if (!t) return null;
  const state = await langgraph<{ next?: string[]; values?: { mode?: SubmitMode } }>(`/threads/${t.thread_id}/state`);
  const next = state.next ?? [];
  const stage: Stage =
    t.status === 'error'
      ? 'error'
      : t.status === 'interrupted'
        ? next.includes('pick') ? 'pick' : next.includes('review') ? 'review' : 'working'
        : t.status === 'busy'
          ? next.some((n) => n === 'notify' || n === 'scout') ? 'scouting' : next.includes('tailor') ? 'tailoring' : next.includes('submit') ? 'submitting' : 'working'
          : 'done';
  return { threadId: t.thread_id, stage, mode: state.values?.mode ?? 'assist' };
}

async function connection(): Promise<{ langgraph: boolean; pipeline: Pipeline | null }> {
  try {
    return { langgraph: true, pipeline: await currentPipeline() };
  } catch {
    return { langgraph: false, pipeline: null };
  }
}

// ---------------------------------------------------------------- work this page started

interface Task {
  kind: 'scout' | 'tailor' | 'submit';
  via: 'langgraph' | 'local';
  jobIds: number[];
  threadId?: string;
  startedAt: string;
  done: boolean;
  error?: string;
}
const tasks: Task[] = [];

function track(task: Omit<Task, 'startedAt' | 'done'>): Task {
  const t: Task = { ...task, startedAt: new Date().toISOString(), done: false };
  tasks.unshift(t);
  tasks.splice(20);
  return t;
}

/** Runs an agent on LangGraph when it's up, otherwise in this process. */
async function start(kind: Task['kind'], up: boolean, jobIds: number[], input: Record<string, unknown>, local: () => Promise<unknown>) {
  if (up) {
    const graph = { scout: 'scout', tailor: 'tailor', submit: 'submitter' }[kind];
    const thread = await langgraph<{ thread_id: string }>('/threads', {});
    await langgraph(`/threads/${thread.thread_id}/runs`, { assistant_id: graph, input });
    return track({ kind, via: 'langgraph', jobIds, threadId: thread.thread_id });
  }
  const t = track({ kind, via: 'local', jobIds });
  local().then(
    () => (t.done = true),
    (err: Error) => Object.assign(t, { done: true, error: err.message }),
  );
  return t;
}

async function refreshTasks() {
  for (const t of tasks.filter((x) => !x.done && x.via === 'langgraph')) {
    try {
      const thread = await langgraph<{ status: string }>(`/threads/${t.threadId}`);
      if (thread.status === 'idle') t.done = true;
      if (thread.status === 'error') Object.assign(t, { done: true, error: 'the run failed; see it in Studio' });
    } catch {
      // LangGraph went away mid-run: leave it, the job statuses still show progress.
    }
  }
}

// ---------------------------------------------------------------- what the page shows

const view = (j: JobRow) => ({
  id: j.id,
  score: j.score,
  status: j.status,
  reason: j.statusReason,
  company: j.company,
  title: j.title,
  location: j.location,
  workplaceType: j.workplaceType,
  source: j.source,
  partial: j.descriptionIsPartial,
  url: j.url,
  fullPosting: j.postingUrl,
  applyPage: j.enrichedAt && j.applyUrl ? j.applyUrl : null,
  postedAt: j.postedAt ?? null,
  verdict: j.scoreDetails?.verdict ?? null,
  summary: j.scoreDetails?.summary ?? '',
  matchReasons: j.scoreDetails?.matchReasons ?? [],
  gaps: j.scoreDetails?.gaps ?? [],
  dealbreakers: j.scoreDetails?.dealbreakers ?? [],
  description: j.descriptionIsPartial ? '' : j.description.slice(0, 6000),
});

function documents(store: JobStore, j: JobRow) {
  const app = store.latestApplication(j.id);
  if (!app || !existsSync(app.dir)) return null;
  const files = readdirSync(app.dir);
  const pick = (re: RegExp) => files.find((f) => re.test(f)) ?? null;
  const report = app.verification as VerificationReport;
  return {
    version: app.version,
    cv: pick(/-CV\.pdf$/) ?? pick(/-CV\.html$/),
    letter: pick(/-Cover-Letter\.pdf$/) ?? pick(/-Cover-Letter\.html$/),
    unverified: report.issues.filter((i) => i.severity === 'unresolved').map((i) => `${i.where}: ${i.message}`),
    report: files.includes('report.md') ? readFileSync(path.join(app.dir, 'report.md'), 'utf8').slice(0, 20_000) : '',
    feedback: app.feedback,
    keywords: report.keywords?.total ? { ...report.keywords, redoNote: redoNote(report.keywords) } : null,
    style: report.style?.length ? { notes: report.style, redoNote: styleRedoNote(report.style) } : null,
    letterReuse: report.letterSimilarity?.flagged
      ? {
          sameCompany: report.letterSimilarity.sameCompany,
          closest: report.letterSimilarity.closest,
          messages: report.issues.filter((i) => i.where === 'letter-wording').map((i) => i.message),
          redoNote: similarityRedoNote(report.letterSimilarity),
        }
      : null,
  };
}

function lastAttempt(store: JobStore, j: JobRow) {
  const s = store.submissions(j.id).filter((x) => x.mode !== 'manual').at(-1);
  if (!s) return null;
  const app = store.latestApplication(j.id);
  const shot = s.screenshots.at(-1);
  return {
    mode: s.mode,
    outcome: s.outcome,
    at: s.createdAt,
    reason: s.reason,
    confirmation: s.confirmation,
    screenshot: shot && app && shot.startsWith(app.dir) ? path.relative(app.dir, shot) : null,
    // What Claude wrote on the form, so nothing sent in your name goes unseen.
    modelAnswers: ((s.fields ?? []) as PlannedAnswer[])
      .filter((f) => MODEL_SOURCES.includes(f.source) && f.filled && f.value)
      .map((f) => ({ label: f.label, value: f.value, kind: f.source === 'model_draft' ? 'written' : 'from your CV' })),
  };
}

function scouting(store: JobStore) {
  const run = store.latestRun('scout');
  if (!run || run.finishedAt || Date.now() - Date.parse(run.startedAt) > 3 * 3_600_000) return null;
  const prefs = loadJsonFile(resolvePaths().preferences, PreferencesSchema);
  const scored = store.countScoredSince(run.startedAt);
  // Jobs in a batch aren't "to go": their scores arrive together, later.
  const waiting = Math.max(0, store.countScoringQueue(prefs.scoring.maxAttempts) - jobsInBatches(store).size);
  return { startedAt: run.startedAt, scored, remaining: Math.max(0, Math.min(waiting, prefs.scoring.maxJobsPerRun - scored)) };
}

/** Dollars of Claude calls tied to this job so far (scoring, lookup, tailoring, form answers), or null. */
const spentOn = (store: JobStore, jobId: number) => store.usageForJob(jobId) || null;

async function state() {
  await refreshTasks();
  const conn = await connection();
  const settings = (() => {
    try {
      return loadJsonFile(resolvePaths().submit, SubmitFileSchema);
    } catch {
      return null;
    }
  })();
  return {
    ...conn,
    autoSubmitAllowed: Boolean(settings?.autoSubmit),
    requireApproval: settings?.requireApproval ?? true,
    shortlistCutoff: shortlistCutoff(loadJsonFile(resolvePaths().preferences, PreferencesSchema)),
    cv: cvStatus(),
    tasks: tasks.filter((t) => !t.done || (t.error && Date.now() - Date.parse(t.startedAt) < 3_600_000)),
    ...withStore((store) => ({
      scouting: scouting(store),
      // Postings sent for batch scoring whose scores haven't arrived yet.
      inBatch: jobsInBatches(store).size,
      shortlist: store.listByStatus(['shortlisted']).map(view),
      tailoring: store.listByStatus(['selected', 'tailor_error']).map(view),
      ready: store.listByStatus(['tailored']).map((j) => ({ ...view(j), docs: documents(store, j), spent: spentOn(store, j.id) })),
      sending: store
        .listByStatus(['approved', 'needs_manual', 'failed'])
        .map((j) => ({ ...view(j), docs: documents(store, j), last: lastAttempt(store, j), spent: spentOn(store, j.id) })),
    })),
  };
}

// ---------------------------------------------------------------- your actions

const Ids = z.array(z.number().int().positive()).max(200);
const Mode = z.enum(MODES).default('assist');

/** Scouting already under way, here or in LangGraph. */
const scoutBusy = (s: Awaited<ReturnType<typeof state>>) =>
  Boolean(s.scouting) || s.pipeline?.stage === 'scouting' || s.tasks.some((t) => t.kind === 'scout' && !t.done);

/** Tailor, then (with "Review before sending" off) straight on to the Submitter. */
async function startTailor(up: boolean, jobIds: number[], mode: SubmitMode) {
  return start('tailor', up, jobIds, { jobIds, mode }, async () => {
    await tailorAgent(jobIds);
    await sendWithoutReview(jobIds, mode);
  });
}

/** Changes one setting in config/submit.json, keeping the rest of the file as you wrote it. */
function setSubmitSetting(key: string, value: boolean) {
  const file = resolvePaths().submit;
  let text = readFileSync(file, 'utf8');
  const line = new RegExp(`"${key}":\\s*(true|false)`);
  text = line.test(text) ? text.replace(line, `"${key}": ${value}`) : text.replace(/\{/, `{\n  "${key}": ${value},`);
  SubmitFileSchema.parse(JSON.parse(text));
  writeFileSync(file, text);
}

// ---------------------------------------------------------------- your CV

/** What the CV tab shows: the master CV the agents use, and your contact details for its header. */
function cvSummary() {
  const paths = resolvePaths();
  const contact = existsSync(paths.tailor) ? loadJsonFile(paths.tailor, TailorConfigSchema).contact : null;
  const certificates = listCertificates(paths.certificatesDir);
  if (!existsSync(paths.masterCv)) return { exists: false, path: paths.masterCv, contact, certificates };
  const raw = readFileSync(paths.masterCv, 'utf8');
  const cv = MasterCvSchema.parse(JSON.parse(raw));
  return { exists: true, path: paths.masterCv, contact, todos: (raw.match(/TODO/g) ?? []).length, cv, certificates };
}

const DOC_MAX_BYTES = 10 * 1024 * 1024;

/** How the Submitter sent an application (its confirmation, what Claude wrote on the form), if it did. */
function sentByTool(store: JobStore, ids: number[]) {
  for (const id of ids) {
    const job = store.get(id);
    const last = job && lastAttempt(store, job);
    if (last?.outcome === 'submitted') return { at: last.at, confirmation: last.confirmation, modelAnswers: last.modelAnswers };
  }
  return null;
}

/** The CV and cover letter of whichever of an application's job records was tailored. */
function documentsOf(store: JobStore, ids: number[]) {
  for (const id of ids) {
    const job = store.get(id);
    const docs = job && documents(store, job);
    if (docs) return { jobId: id, cv: docs.cv, letter: docs.letter, version: docs.version };
  }
  return null;
}

/**
 * The Archiver's report, plus when it last ran: what the Applied and Stats tabs and the Archive in
 * Settings show. Each application says whether it's archived (rejected, or nothing new for 30 days).
 */
function applicationsView() {
  return withStore((store) => {
    const now = new Date();
    const report = buildReport(store.sentApplications(), store.responses(), now);
    const last = store.latestRun('archiver');
    const strip = (r: { kind: string; receivedAt: string; subject: string; summary: string; action: string; fromName: string; company: string }) => ({
      kind: r.kind, receivedAt: r.receivedAt, subject: r.subject, summary: r.summary, action: r.action, from: r.company || r.fromName,
    });
    return {
      stats: report.stats,
      archiveAfterDays: ARCHIVE_AFTER_DAYS,
      rows: report.rows.map((r) => ({ ...r, replies: r.replies.map(strip), docs: documentsOf(store, r.jobIds), sent: sentByTool(store, r.jobIds), archived: isArchived(r, now) })),
      // Applications never sent and moved here after two weeks without a change.
      notSent: store.listByStatus(['archived']).map((j) => ({ ...view(j), docs: documentsOf(store, [j.id]), archivedAt: store.history(j.id).at(-1)?.at ?? null })),
      unmatched: report.unmatched.map(strip),
      lastRun: last ? { startedAt: last.startedAt, finishedAt: last.finishedAt } : null,
      // For Stats: the same applications by where Scout found them and by score, and what Claude has cost.
      breakdown: { ...outcomeReport(store, now), waitingDays: WAITING_DAYS },
      spending: spendingReport(store, now),
    };
  });
}

const actions: Record<string, (body: unknown) => Promise<unknown>> = {
  /**
   * Sets an application's stage by hand, or with "auto" goes back to reading it from email. Applies to
   * every record of the application, so Applied, Stats and the Archive agree.
   */
  async setStage(body) {
    const { id, stage } = z.object({ id: z.number().int().positive(), stage: z.enum(['auto', ...STAGES]) }).parse(body);
    return withStore((store) => {
      const group = groupApplications(store.sentApplications()).find((g) => g.jobIds.includes(id));
      if (!group) throw new Error(`#${id} isn't a sent application`);
      const now = new Date().toISOString();
      store.setOutcome(group.jobIds, stage === 'auto' ? null : stage, now);
      // Rejected by you: to the Archive, even one you'd kept in Applied.
      if (stage === 'rejected') store.setArchiveChoice(group.jobIds, null, now);
      return { ids: group.jobIds };
    });
  },
  /** "Send to archive" on an Applied card, or "Back to Applied" on an archived one. */
  async archiveApplication(body) {
    const { id, archive } = z.object({ id: z.number().int().positive(), archive: z.boolean() }).parse(body);
    return withStore((store) => {
      const group = groupApplications(store.sentApplications()).find((g) => g.jobIds.includes(id));
      if (!group) throw new Error(`#${id} isn't a sent application`);
      store.setArchiveChoice(group.jobIds, archive ? 'archived' : 'applied', new Date().toISOString());
      return { ids: group.jobIds, archived: archive };
    });
  },

  /** Puts an auto-archived application back where it was. */
  async restore(body) {
    const { id } = z.object({ id: z.number().int().positive() }).parse(body);
    return { status: withStore((store) => store.restoreArchived(id, new Date().toISOString())) };
  },
  /** Runs the Archiver now instead of waiting for its hourly run. */
  async archive() {
    const last = withStore((store) => store.latestRun('archiver'));
    if (last && !last.finishedAt && Date.now() - Date.parse(last.startedAt) < 2 * 3_600_000) return { started: false };
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'src', 'cli.ts'), 'archive'], { cwd: process.cwd(), stdio: 'ignore', detached: true });
    child.on('error', () => undefined).unref();
    return { started: true };
  },
  /** Converts an uploaded CV (PDF or Word) for preview. Nothing is saved yet. */
  async cvParse(body) {
    const { data } = z.object({ name: z.string().max(300), data: z.string().max(Math.ceil((DOC_MAX_BYTES * 4) / 3) + 8) }).parse(body);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    const file = Buffer.from(data, 'base64');
    // Decided by the file's content, not its name: a PDF starts with %PDF, a .docx is a zip.
    const kind = file.subarray(0, 4).toString('latin1') === '%PDF' ? 'pdf' : file[0] === 0x50 && file[1] === 0x4b ? 'docx' : null;
    if (!kind) throw new Error('Upload a PDF or a Word (.docx) file');
    return metered((meter) => importCv({ data: file, kind }, { model: process.env.TAILOR_MODEL, meter }));
  },

  /** Saves a previewed CV as the master CV (the old one is kept as a backup) and your contact details. */
  async cvSave(body) {
    const { cv, contact } = z
      .object({ cv: MasterCvSchema, contact: z.object({ email: z.string().max(200), phone: z.string().max(60) }) })
      .parse(body);
    const paths = resolvePaths();
    mkdirSync(path.dirname(paths.masterCv), { recursive: true });
    let backup: string | null = null;
    if (existsSync(paths.masterCv)) {
      backup = paths.masterCv.replace(/\.json$/, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      copyFileSync(paths.masterCv, backup);
    }
    writeFileSync(paths.masterCv, JSON.stringify(cv, null, 2) + '\n');
    if (!existsSync(paths.tailor)) {
      mkdirSync(path.dirname(paths.tailor), { recursive: true });
      copyFileSync(path.join(process.cwd(), 'examples', 'tailor.json'), paths.tailor);
    }
    const tailor = JSON.parse(readFileSync(paths.tailor, 'utf8'));
    tailor.contact = { ...tailor.contact, ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { phone: contact.phone } : {}) };
    TailorConfigSchema.parse(tailor);
    writeFileSync(paths.tailor, JSON.stringify(tailor, null, 2) + '\n');
    return { saved: paths.masterCv, backup };
  },

  async settings(body) {
    const { requireApproval } = z.object({ requireApproval: z.boolean() }).parse(body);
    setSubmitSetting('requireApproval', requireApproval);
    return { requireApproval };
  },

  /** The minimum score for your shortlist: saved to config/preferences.json and applied to the jobs already scored. */
  async shortlistCutoff(body) {
    const paths = resolvePaths();
    const prefs = saveShortlistCutoff(paths.preferences, body);
    const moved = withStore((store) => resortByCutoff(store, prefs, new Date().toISOString()));
    return { ...shortlistCutoff(prefs), ...moved };
  },

  /** A certificate you upload, with its title (and issuer, year) as it should read on your CV. */
  async certificateAdd(body) {
    const { name, data, title, issuer, year } = z
      .object({
        name: z.string().max(300),
        data: z.string().max(Math.ceil((CERTIFICATE_MAX_BYTES * 4) / 3) + 8),
        title: z.string().max(200),
        issuer: z.string().max(200).default(''),
        year: z.string().max(10).default(''),
      })
      .parse(body);
    return addCertificate(resolvePaths().certificatesDir, { data: Buffer.from(data, 'base64'), originalName: name, title, issuer, year });
  },

  async certificateRemove(body) {
    const { id } = z.object({ id: z.string().max(40) }).parse(body);
    if (!removeCertificate(resolvePaths().certificatesDir, id)) throw new Error('No such certificate');
    return { removed: id };
  },

  async run(body) {
    const { mode } = z.object({ mode: Mode }).parse(body);
    if (!cvStatus().ready) throw new Error(UPLOAD_CV_FIRST);
    const now = await state();
    if (scoutBusy(now)) throw new Error('Scout is already running');
    if (now.langgraph) {
      const thread = await langgraph<{ thread_id: string }>('/threads', {});
      await langgraph(`/threads/${thread.thread_id}/runs`, { assistant_id: 'pipeline', input: { mode, quiet: true } });
      return { via: 'pipeline' };
    }
    await start('scout', false, [], {}, () => scoutAgent());
    return { via: 'local' };
  },

  async pick(body) {
    const { ids, mode } = z.object({ ids: Ids.min(1), mode: Mode }).parse(body);
    if (!cvStatus().ready) throw new Error(UPLOAD_CV_FIRST);
    const { langgraph: up, pipeline } = await connection();
    if (pipeline?.stage === 'pick') {
      await langgraph(`/threads/${pipeline.threadId}/runs`, { assistant_id: 'pipeline', command: { resume: { pick: ids, dismiss: [] } } });
      return { via: 'pipeline', picked: ids };
    }
    const { picked, skipped } = withStore((store) => applyPicks(store, { pick: ids }));
    if (picked.length) await startTailor(up, picked, mode);
    return { via: up ? 'langgraph' : 'local', picked, skipped };
  },

  /** "Remove" on a card: the job leaves every list, whatever stage it's at. */
  async remove(body) {
    const { id } = z.object({ id: z.number().int().positive() }).parse(body);
    return withStore((store) => removeJob(store, id));
  },

  async dismiss(body) {
    const { ids } = z.object({ ids: Ids.min(1) }).parse(body);
    return withStore((store) => applyPicks(store, { dismiss: ids }));
  },

  async approve(body) {
    const { ids, force, mode } = z.object({ ids: Ids.min(1), force: z.boolean().default(false), mode: Mode }).parse(body);
    if (mode === 'auto') {
      const settings = loadJsonFile(resolvePaths().submit, SubmitFileSchema);
      if (!settings.autoSubmit) throw new Error('Auto mode is off: set "autoSubmit": true in config/submit.json');
    }
    const { langgraph: up, pipeline } = await connection();
    if (pipeline?.stage === 'review') {
      // The mode you pick now wins over the one the run started with.
      await langgraph(`/threads/${pipeline.threadId}/runs`, { assistant_id: 'pipeline', command: { resume: { approve: ids, reject: [], force, mode } } });
      return { via: 'pipeline', approved: ids, mode };
    }
    const { approved, skipped } = withStore((store) => applyReview(store, { approve: ids, force }));
    if (approved.length) await start('submit', up, approved, { jobIds: approved, mode }, () => submitAgent(approved, mode));
    return { via: up ? 'langgraph' : 'local', approved, skipped, mode };
  },

  async reject(body) {
    const { ids } = z.object({ ids: Ids.min(1) }).parse(body);
    return withStore((store) => applyReview(store, { reject: ids }));
  },

  async redo(body) {
    const { id, note, mode } = z.object({ id: z.number().int().positive(), note: z.string().trim().min(3).max(1000), mode: Mode }).parse(body);
    withStore((store) => {
      const job = store.get(id);
      if (!job || !['tailored', 'tailor_error', 'approved'].includes(job.status)) throw new Error(`#${id} can't be redone (${job?.status ?? 'not found'})`);
      store.setTailorFeedback(id, note);
      store.setStatus(id, 'selected', `redo: ${note}`, 'user', new Date().toISOString());
    });
    const { langgraph: up } = await connection();
    await startTailor(up, [id], mode);
    return { redo: id };
  },

  /**
   * A job stuck on LinkedIn or a copy site: look once more for the company's own application page
   * (about 7 cents), and hand it to the Submitter if found.
   */
  async findApplyPage(body) {
    const { id, mode } = z.object({ id: z.number().int().positive(), mode: Mode }).parse(body);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    const job = withStore((store) => store.get(id));
    if (!job) throw new Error(`#${id}: not found`);
    const result = await metered((meter) => new AnthropicEnricher({ model: process.env.ENRICH_MODEL, meter }).find(job));
    const cost = enrichCost(result.usage);
    const now = new Date().toISOString();
    if (result.closed) {
      withStore((store) => store.markClosed(id, result.reason, now));
      return { closed: true, reason: result.reason, cost };
    }
    if (!result.applyUrl) return { found: false, reason: result.reason, cost };
    withStore((store) => {
      store.setApplyUrl(id, result.applyUrl!, now);
      // Back to approved: the Submitter only takes approved jobs in Auto mode, so a job left in
      // needs_manual (LinkedIn, no form found) would otherwise be skipped without a word.
      if (['failed', 'needs_manual'].includes(store.get(id)!.status)) store.setStatus(id, 'approved', `application page found: ${result.applyUrl}`, 'user', now);
    });
    const { langgraph: up } = await connection();
    await start('submit', up, [id], { jobIds: [id], mode }, () => submitAgent([id], mode));
    return { found: true, applyUrl: result.applyUrl, cost, mode };
  },

  /**
   * A link you paste to the company's application page: read the full posting from it, score it again
   * on the full text, and tailor the application (again, if it was tailored from an alert's summary).
   */
  async useLink(body) {
    const { id, url, mode, force } = z
      .object({ id: z.number().int().positive(), url: z.string().trim().min(8).max(2000), mode: Mode, force: z.boolean().default(false) })
      .parse(body);
    if (!cvStatus().ready) throw new Error(UPLOAD_CV_FIRST);
    const job = withStore((store) => store.get(id));
    if (!job) throw new Error(`#${id}: not found`);
    if (job.status === 'submitted') throw new Error(`#${id} is already submitted`);
    const paths = resolvePaths();
    const settings = existsSync(paths.submit) ? loadJsonFile(paths.submit, SubmitFileSchema) : null;
    const now = () => new Date().toISOString();

    // Ready to send, or stuck in Sending: the application is written. The link is where to apply.
    if (['tailored', 'approved', 'needs_manual', 'failed'].includes(job.status)) {
      const page = await checkApplyPage(url, job.title, settings?.browserPath);
      if (!page.ok) {
        if (page.closed) withStore((store) => store.markClosed(id, `no longer accepting applications (${url})`, now()));
        return { ...page, cost: 0 };
      }
      withStore((store) => {
        store.setApplyUrl(id, page.finalUrl, now());
        // A job stuck in Sending goes back to approved, or Auto mode skips it as "waiting for you".
        if (job.status !== 'tailored') store.setStatus(id, 'approved', `where to apply, pasted by you: ${page.finalUrl}`, 'user', now());
      });
      const sent = job.status === 'tailored' ? await actions.approve!({ ids: [id], force, mode }) : await actions.retry!({ ids: [id], mode });
      return { ok: true, stage: 'send', applyUrl: page.finalUrl, mode, cost: 0, sent };
    }

    // Shortlist (or waiting to be tailored): read the full posting, score it, tailor from it.
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    const result = await metered((meter) =>
      postingFromLink(url, job, { model: process.env.ENRICH_MODEL ?? process.env.TAILOR_MODEL, browserPath: settings?.browserPath, meter }),
    );
    if (!result.ok) {
      if (result.closed) withStore((store) => store.markClosed(id, `no longer accepting applications (${url})`, now()));
      return result;
    }
    const p = result.posting;
    withStore((store) =>
      store.saveEnrichment(id, { description: p.description, postingUrl: result.finalUrl, applyUrl: result.finalUrl, location: p.location, workplaceType: p.workplaceType, postedAt: p.postedAt }, now()),
    );
    // A fresh score on the full text, so the card shows how well it really fits.
    let score: number | null = null;
    try {
      const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
      const full = withStore((store) => store.get(id)!);
      const { scored, scorer } = await metered(async (meter) => {
        const scorer = createScorer({
          cv: withCertificates(loadJsonFile(paths.masterCv, MasterCvSchema), paths.certificatesDir),
          prefs,
          model: process.env.SCOUT_MODEL,
          examples: () => withStore((store) => store.listClaudeScored()),
          meter,
        });
        return { scored: await scorer.score(full), scorer };
      });
      score = scored.score;
      withStore((store) => store.saveScore(id, scored, placeByScore(full, scored.score, prefs), now(), scorer.model ?? null));
    } catch {
      // Scoring is a nicety here: the posting is saved and tailoring goes ahead regardless.
    }
    withStore((store) => store.setStatus(id, 'selected', `full posting from ${new URL(result.finalUrl).hostname}`, 'user', now()));
    const { langgraph: up } = await connection();
    await startTailor(up, [id], mode);
    return { ok: true, stage: 'tailor', title: p.title, score, cost: result.cost, mode };
  },

  /**
   * A job you add from its link. Without a description the posting is read off the page; with one, your
   * text is the posting and the link is only where the Submitter applies. Either way it's scored onto
   * your shortlist ("score") or goes straight to the Tailor, unscored ("tailor").
   */
  async addJob(body) {
    const { url, description, next, mode } = z
      .object({ url: z.string().trim().min(8).max(2000), description: z.string().max(60_000).default(''), next: z.enum(['score', 'tailor']).default('score'), mode: Mode })
      .parse(body);
    if (!cvStatus().ready) throw new Error(UPLOAD_CV_FIRST);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    const paths = resolvePaths();
    const prefs = loadJsonFile(paths.preferences, PreferencesSchema);
    const settings = existsSync(paths.submit) ? loadJsonFile(paths.submit, SubmitFileSchema) : null;
    const model = process.env.ENRICH_MODEL ?? process.env.TAILOR_MODEL;
    const store = new JobStore(paths.db);
    let result;
    try {
      console.log(`Add a job: ${url}${description.trim() ? ' with a description' : ''}, then ${next}`);
      // What reading the posting and scoring it cost is saved as it happens.
      const meter = new CostMeter('review');
      meter.attach(store);
      result = await addManualJob(
        { url, description, next },
        {
          store,
          prefs,
          scorer: createScorer({ cv: withCertificates(loadJsonFile(paths.masterCv, MasterCvSchema), paths.certificatesDir), prefs, model: process.env.SCOUT_MODEL, examples: () => store.listClaudeScored(), meter }),
          readPage: (link) => postingFromLink(link, null, { model, browserPath: settings?.browserPath, meter }),
          readPasted: (text, link) => pastedPosting(text, link, { model, meter }),
        },
      );
    } catch (err) {
      console.log(`Add a job: ${url} failed: ${(err as Error).message}`);
      throw err;
    } finally {
      store.close();
    }
    console.log(
      result.ok
        ? `Add a job: added #${result.id} ${result.company} — ${result.title}, ${result.next === 'tailor' ? 'to the Tailor' : result.score !== null ? `score ${result.score}` : `not scored: ${result.scoreError}`}`
        : `Add a job: not added: ${result.reason}`,
    );
    if (result.ok && result.next === 'tailor') {
      const { langgraph: up } = await connection();
      await startTailor(up, [result.id], mode);
    }
    return { ...result, mode };
  },

  /** You applied yourself (on LinkedIn, say): record it so nothing applies again. */
  async markApplied(body) {
    const { id } = z.object({ id: z.number().int().positive() }).parse(body);
    // Other listings of the same job (another board, an alert email) leave your shortlist with it.
    const swept = withStore((store) => {
      markSubmitted(store, id, 'you applied yourself (review page)');
      return sweepAppliedListings(store, new Date().toISOString());
    });
    return { marked: id, otherListings: swept.applied };
  },

  /** Ends the current pipeline run where it's paused, e.g. an old one left waiting with another mode. */
  async end() {
    const { pipeline } = await connection();
    if (pipeline?.stage === 'pick') {
      await langgraph(`/threads/${pipeline.threadId}/runs`, { assistant_id: 'pipeline', command: { resume: { pick: [], dismiss: [] } } });
    } else if (pipeline?.stage === 'review') {
      await langgraph(`/threads/${pipeline.threadId}/runs`, { assistant_id: 'pipeline', command: { resume: { approve: [], reject: [] } } });
    } else {
      throw new Error('no pipeline run is paused');
    }
    return { ended: pipeline.threadId };
  },

  /** Tailor or submit again: failed tailoring, or a submission that needs you or failed. */
  async retry(body) {
    const { ids, mode } = z.object({ ids: Ids.min(1), mode: Mode }).parse(body);
    const { langgraph: up } = await connection();
    const { tailor, submit } = withStore((store) => {
      const now = new Date().toISOString();
      const jobs = ids.map((id) => store.get(id)).filter((j): j is JobRow => Boolean(j));
      for (const j of jobs) if (j.status === 'failed') store.setStatus(j.id, 'approved', 'retry requested', 'user', now);
      return {
        tailor: jobs.filter((j) => j.status === 'tailor_error').map((j) => j.id),
        submit: jobs.filter((j) => ['failed', 'needs_manual', 'approved'].includes(j.status)).map((j) => j.id),
      };
    });
    if (tailor.length) await startTailor(up, tailor, mode);
    if (submit.length) await start('submit', up, submit, { jobIds: submit, mode }, () => submitAgent(submit, mode));
    return { tailor, submit, mode };
  },
};

// ---------------------------------------------------------------- HTTP

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : (body as string | Buffer));
}

async function readJson(req: IncomingMessage, limit = 100_000): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('request too large');
  }
  return JSON.parse(data || '{}');
}

const FILE_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.html': 'text/html', '.md': 'text/plain', '.png': 'image/png' };

/** A file from a job's application folder (CV, letter, report, screenshot), and nothing outside it. */
function serveFile(res: ServerResponse, jobId: number, rel: string, download = false) {
  const dir = withStore((store) => store.latestApplication(jobId)?.dir);
  const type = FILE_TYPES[path.extname(rel).toLowerCase()];
  if (!dir || !type) return send(res, 404, { error: 'not found' });
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file)) return send(res, 404, { error: 'not found' });
  // Tailored HTML is your own CV, but it's still served without scripts.
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "script-src 'none'" };
  if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file).replace(/[^\w.\- ]/g, '_')}"`;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

/** One of your certificates, by id from the index: never a path from the request. */
function serveCertificate(res: ServerResponse, id: string, download: boolean) {
  const dir = resolvePaths().certificatesDir;
  const cert = listCertificates(dir).find((c) => c.id === id);
  const file = cert && certificateFile(dir, cert);
  if (!cert || !file || !existsSync(file)) return send(res, 404, { error: 'not found' });
  const headers: Record<string, string> = { 'content-type': CERTIFICATE_TYPES[cert.type].mime, 'cache-control': 'no-store', 'content-security-policy': "script-src 'none'" };
  if (download) headers['content-disposition'] = `attachment; filename="${cert.originalName.replace(/[^\w.\- ]/g, '_')}"`;
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    // Anything not from this Mac needs the key: from the link once, then from the cookie it sets.
    if (!fromThisMac(req)) {
      if (!REMOTE) return send(res, 403, { error: 'forbidden' });
      if (sameKey(url.searchParams.get('key'))) {
        res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${KEY}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (!sameKey(cookieKey(req))) return send(res, 401, 'Open the link from the "On your phone" panel on your Mac to use this page here.', 'text/plain');
    }
    if (req.method === 'GET' && url.pathname === '/api/phone') {
      if (!fromThisMac(req)) return send(res, 403, { error: 'only on the Mac' });
      if (!REMOTE) return send(res, 200, { enabled: false });
      const links = phoneLinks();
      const qr = links[0] ? await QRCode.toString(links[0].url, { type: 'svg', margin: 1, width: 220 }) : null;
      return send(res, 200, { enabled: true, links, qr });
    }
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html');
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await state());
    if (req.method === 'GET' && url.pathname === '/api/cv') return send(res, 200, cvSummary());
    if (req.method === 'GET' && url.pathname === '/api/applications') return send(res, 200, applicationsView());
    if (req.method === 'GET' && url.pathname === '/api/below-cutoff') {
      return send(res, 200, withStore((store) => store.listByStatus(['low_score']).map(view)));
    }
    const cert = /^\/certificates\/([\w-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && cert) return serveCertificate(res, cert[1]!, url.searchParams.has('download'));
    const file = /^\/files\/(\d+)\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && file) return serveFile(res, Number(file[1]), decodeURIComponent(file[2]!), url.searchParams.has('download'));
    const action = /^\/api\/(\w+)$/.exec(url.pathname)?.[1];
    if (req.method === 'POST' && action && actions[action]) {
      // Only this page may act: another site open in your browser can't post here.
      const origin = req.headers.origin ?? '';
      const sameSite = ORIGINS.has(origin) || (REMOTE && origin === `http://${req.headers.host}`);
      if (!sameSite || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 403, { error: 'forbidden' });
      }
      const limit = action === 'cvParse' ? 15_000_000 : action === 'certificateAdd' ? 8_000_000 : 1_000_000;
      return send(res, 200, await actions[action]!(await readJson(req, limit)));
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    const message = err instanceof z.ZodError ? 'invalid request' : (err as Error).message;
    send(res, 400, { error: message });
  }
});

server.listen(PORT, REMOTE ? '0.0.0.0' : '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`Review page: ${address}  (Ctrl+C to stop)`);
  if (REMOTE) for (const l of phoneLinks()) console.log(`On your phone, ${l.via}: ${l.url}`);
  if (process.platform === 'darwin' && !process.env.REVIEW_NO_OPEN) spawn('open', [address], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
});
