import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { z } from 'zod';
import { loadJsonFile, MasterCvSchema, PreferencesSchema, resolvePaths } from '../config.ts';
import { importCv } from '../cv/import.ts';
import { cvStatus, UPLOAD_CV_FIRST } from '../cv/ready.ts';
import { applyPicks, applyReview } from '../decisions.ts';
import { JobStore } from '../db/store.ts';
import { scoutAgent, sendWithoutReview, submitAgent, tailorAgent } from '../graph/graphs.ts';
import { AnthropicEnricher, enrichCost } from '../llm/enrich.ts';
import { markSubmitted } from '../submit/run.ts';
import { MODEL_SOURCES, SubmitFileSchema, type PlannedAnswer, type SubmitMode } from '../submit/schema.ts';
import { TailorConfigSchema, type VerificationReport } from '../tailor/schema.ts';
import type { JobRow } from '../types.ts';
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
  const waiting = store.countScoringQueue(prefs.scoring.maxAttempts);
  return { startedAt: run.startedAt, scored, remaining: Math.max(0, Math.min(waiting, prefs.scoring.maxJobsPerRun - scored)) };
}

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
  const recent = Date.now() - 14 * 86_400_000;
  return {
    ...conn,
    autoSubmitAllowed: Boolean(settings?.autoSubmit),
    requireApproval: settings?.requireApproval ?? true,
    cv: cvStatus(),
    tasks: tasks.filter((t) => !t.done || (t.error && Date.now() - Date.parse(t.startedAt) < 3_600_000)),
    ...withStore((store) => ({
      scouting: scouting(store),
      shortlist: store.listByStatus(['shortlisted']).map(view),
      tailoring: store.listByStatus(['selected', 'tailor_error']).map(view),
      ready: store.listByStatus(['tailored']).map((j) => ({ ...view(j), docs: documents(store, j) })),
      sending: store.listByStatus(['approved', 'needs_manual', 'failed']).map((j) => ({ ...view(j), docs: documents(store, j), last: lastAttempt(store, j) })),
      sent: store
        .listByStatus(['submitted'])
        .map((j) => ({ job: j, last: lastAttempt(store, j) }))
        .filter((x) => x.last?.outcome === 'submitted' && Date.parse(x.last.at) > recent)
        .map((x) => ({ ...view(x.job), last: x.last })),
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
  if (!existsSync(paths.masterCv)) return { exists: false, path: paths.masterCv, contact };
  const raw = readFileSync(paths.masterCv, 'utf8');
  const cv = MasterCvSchema.parse(JSON.parse(raw));
  return { exists: true, path: paths.masterCv, contact, todos: (raw.match(/TODO/g) ?? []).length, cv };
}

const DOC_MAX_BYTES = 10 * 1024 * 1024;

const actions: Record<string, (body: unknown) => Promise<unknown>> = {
  /** Converts an uploaded CV (PDF or Word) for preview. Nothing is saved yet. */
  async cvParse(body) {
    const { data } = z.object({ name: z.string().max(300), data: z.string().max(Math.ceil((DOC_MAX_BYTES * 4) / 3) + 8) }).parse(body);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    const file = Buffer.from(data, 'base64');
    // Decided by the file's content, not its name: a PDF starts with %PDF, a .docx is a zip.
    const kind = file.subarray(0, 4).toString('latin1') === '%PDF' ? 'pdf' : file[0] === 0x50 && file[1] === 0x4b ? 'docx' : null;
    if (!kind) throw new Error('Upload a PDF or a Word (.docx) file');
    return importCv({ data: file, kind }, { model: process.env.TAILOR_MODEL });
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
    const result = await new AnthropicEnricher({ model: process.env.ENRICH_MODEL }).find(job);
    const cost = enrichCost(result.usage);
    const now = new Date().toISOString();
    if (result.closed) {
      withStore((store) => store.markClosed(id, result.reason, now));
      return { closed: true, reason: result.reason, cost };
    }
    if (!result.applyUrl) return { found: false, reason: result.reason, cost };
    withStore((store) => {
      store.setApplyUrl(id, result.applyUrl!, now);
      if (store.get(id)!.status === 'failed') store.setStatus(id, 'approved', 'application page found', 'user', now);
    });
    const { langgraph: up } = await connection();
    await start('submit', up, [id], { jobIds: [id], mode }, () => submitAgent([id], mode));
    return { found: true, applyUrl: result.applyUrl, cost, mode };
  },

  /** You applied yourself (on LinkedIn, say): record it so nothing applies again. */
  async markApplied(body) {
    const { id } = z.object({ id: z.number().int().positive() }).parse(body);
    withStore((store) => markSubmitted(store, id, 'you applied yourself (review page)'));
    return { marked: id };
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
function serveFile(res: ServerResponse, jobId: number, rel: string) {
  const dir = withStore((store) => store.latestApplication(jobId)?.dir);
  const type = FILE_TYPES[path.extname(rel).toLowerCase()];
  if (!dir || !type) return send(res, 404, { error: 'not found' });
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file)) return send(res, 404, { error: 'not found' });
  // Tailored HTML is your own CV, but it's still served without scripts.
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "script-src 'none'" });
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
    if (req.method === 'GET' && url.pathname === '/api/below-cutoff') {
      return send(res, 200, withStore((store) => store.listByStatus(['low_score']).map(view)));
    }
    const file = /^\/files\/(\d+)\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && file) return serveFile(res, Number(file[1]), decodeURIComponent(file[2]!));
    const action = /^\/api\/(\w+)$/.exec(url.pathname)?.[1];
    if (req.method === 'POST' && action && actions[action]) {
      // Only this page may act: another site open in your browser can't post here.
      const origin = req.headers.origin ?? '';
      const sameSite = ORIGINS.has(origin) || (REMOTE && origin === `http://${req.headers.host}`);
      if (!sameSite || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 403, { error: 'forbidden' });
      }
      return send(res, 200, await actions[action]!(await readJson(req, action === 'cvParse' ? 15_000_000 : 1_000_000)));
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
