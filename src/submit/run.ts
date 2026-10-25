import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, LaunchOptions, Page } from 'playwright-core';
import type { MasterCv } from '../config.ts';
import type { JobStore, SubmissionRecord } from '../db/store.ts';
import type { TailorConfig, TailoredContent } from '../tailor/schema.ts';
import { SUBMIT_INPUT_STATUSES, type JobRow } from '../types.ts';
import { sleep } from '../util/limiter.ts';
import type { Logger } from '../util/logger.ts';
import { buildProfile, detectPlatform, forModel, planDeterministic, resolveApplyUrl, type Documents } from './answers.ts';
import { detectBlockers, detectConfirmation, extractFields, fillAnswer, fillCode, findCodeFields, findFormFrame, findSubmitButton, guardSubmit, highlight, pageMentionsTitle, revealForm } from './form.ts';
import { applyMapped, type FieldMapper } from './llm.ts';
import type { CodeSource } from './otp.ts';
import { MODEL_SOURCES, type AnswersConfig, type PlannedAnswer, type SubmitConfig, type SubmitMode } from './schema.ts';

// ---------------------------------------------------------------- browser

export interface BrowserSession {
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * A persistent profile (data/browser-profile) so cookies and site preferences survive between runs.
 * Uses your installed Chrome, then Edge, unless browserPath is set. No stealth tricks: the Submitter
 * behaves like an ordinary browser and stops when a site asks it to prove it's human.
 */
export async function openBrowser(opts: { browserPath: string; headless: boolean; userDataDir: string }): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core');
  mkdirSync(opts.userDataDir, { recursive: true });
  const attempts: Array<{ label: string; launch: LaunchOptions }> = opts.browserPath
    ? [{ label: opts.browserPath, launch: { executablePath: opts.browserPath } }]
    : [
        { label: 'Google Chrome', launch: { channel: 'chrome' } },
        { label: 'Microsoft Edge', launch: { channel: 'msedge' } },
      ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const context = await chromium.launchPersistentContext(opts.userDataDir, {
        ...a.launch,
        headless: opts.headless,
        viewport: { width: 1280, height: 900 },
      });
      return { context, close: () => context.close() };
    } catch (err) {
      errors.push(`${a.label}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`Could not start a browser (${errors.join('; ')}). Install Chrome or set browserPath in config/submit.json.`);
}

// ---------------------------------------------------------------- deps

export interface AssistInfo {
  job: JobRow;
  page: Page;
  applyUrl: string;
  unresolved: PlannedAnswer[];
  modelAnswers: PlannedAnswer[];
  blockers: string[];
}

export interface SubmitDeps {
  store: JobStore;
  cv: MasterCv;
  answers: AnswersConfig;
  contact: TailorConfig['contact'];
  cfg: SubmitConfig;
  mapper: FieldMapper | null;
  browser: BrowserSession;
  logger: Logger;
  /** Reads emailed security codes (Greenhouse sends one after Submit). Without it, you type the code. */
  codes?: CodeSource | null;
  /** Called in assist mode once the form is filled, before waiting for you to submit. */
  onAssist?: (info: AssistInfo) => Promise<void> | void;
  clock?: () => Date;
  timing?: Partial<Timing>;
}

interface Timing {
  settleMs: number;
  confirmTimeoutMs: number;
  pollMs: number;
  /** Pause between automatic submissions. */
  betweenMs: number;
  /** How long to wait for an emailed security code. */
  codeTimeoutMs: number;
}

const DEFAULT_TIMING: Timing = { settleMs: 8000, confirmTimeoutMs: 30_000, pollMs: 2000, betweenMs: 20_000, codeTimeoutMs: 180_000 };
const MAX_FAILED_ATTEMPTS = 3;

function findDocuments(dir: string, tailored: TailoredContent | null): Documents {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const pick = (re: RegExp) => {
    const f = files.find((x) => re.test(x));
    return f ? path.join(dir, f) : null;
  };
  const letter = tailored?.coverLetter;
  return {
    cvPdf: pick(/-CV\.pdf$/),
    letterPdf: pick(/-Cover-Letter\.pdf$/),
    letterText: letter ? [letter.greeting, ...letter.paragraphs, letter.closing].join('\n\n') : '',
  };
}

interface CodeStep {
  codes: CodeSource;
  /** Only codes emailed after this count: older ones belong to other applications. */
  since: Date;
  timeoutMs: number;
  logger: Logger;
  jobId: number;
}

/**
 * Watches for the confirmation page. If the site asks for an emailed security code first, reads it
 * from the inbox, types it, and clicks Submit again: that's the step you already took, now completed.
 */
async function waitForConfirmation(page: Page, timeoutMs: number, pollMs: number, code?: CodeStep): Promise<string | null> {
  let deadline = Date.now() + timeoutMs;
  let codeTried = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;
    const found = await detectConfirmation(page).catch(() => null);
    if (found) return found;
    const prompt = code && !codeTried ? await findCodeFields(page) : null;
    if (code && prompt) {
      codeTried = true;
      code.logger.info(`#${code.jobId}: the site emailed a security code; reading it from the inbox`);
      const value = await code.codes.waitForCode({ since: code.since, timeoutMs: code.timeoutMs });
      if (!value) {
        code.logger.warn(`#${code.jobId}: no security code arrived; type it into the page yourself`);
      } else if (!page.isClosed()) {
        await fillCode(prompt, value);
        const again = await findSubmitButton(prompt.frame);
        if (again) await again.click();
        code.logger.info(`#${code.jobId}: security code entered`);
      }
      deadline = Date.now() + timeoutMs;
      continue;
    }
    await sleep(pollMs);
  }
  return null;
}

/** Field list for the record: file paths shortened to names, everything else as filled. */
const fieldsForRecord = (plan: PlannedAnswer[]) =>
  plan.map((p) => ({ ...p, value: p.kind === 'file' && p.value ? path.basename(p.value) : p.value }));

// ---------------------------------------------------------------- one job

export async function submitJob(job: JobRow, mode: SubmitMode, deps: SubmitDeps): Promise<SubmissionRecord> {
  const { store, logger, cfg } = deps;
  const t = { ...DEFAULT_TIMING, ...deps.timing };
  const now = () => (deps.clock ?? (() => new Date()))();
  const app = store.latestApplication(job.id) ?? null;
  const applyUrl = resolveApplyUrl(job);
  let fields: unknown = null;
  const screenshots: string[] = [];

  const finish = (outcome: SubmissionRecord['outcome'], reason: string | null, confirmation: string | null = null): SubmissionRecord => {
    const record = store.saveSubmission({
      jobId: job.id,
      applicationId: app?.id ?? null,
      mode,
      outcome,
      applyUrl,
      reason,
      fields,
      screenshots,
      confirmation,
      createdAt: now().toISOString(),
    });
    const at = now().toISOString();
    if (outcome === 'submitted') store.setStatus(job.id, 'submitted', confirmation, 'submitter', at);
    else if (outcome === 'needs_manual') store.setStatus(job.id, 'needs_manual', reason, 'submitter', at);
    else if (outcome === 'failed') {
      const failures = store.submissions(job.id).filter((s) => s.outcome === 'failed').length;
      if (failures >= MAX_FAILED_ATTEMPTS) store.setStatus(job.id, 'failed', `${failures} failed attempts; last: ${reason}`, 'submitter', at);
    }
    logger.info(`#${job.id}: ${outcome}${reason ? ` (${reason})` : ''}`);
    return record;
  };

  // --- guards that need no browser
  if (!SUBMIT_INPUT_STATUSES.includes(job.status)) throw new Error(`#${job.id} is "${job.status}", not approved`);
  if (store.submissions(job.id).some((s) => s.outcome === 'submitted')) throw new Error(`#${job.id} was already submitted`);
  const platform = detectPlatform(applyUrl);
  if (platform.manualOnly) {
    return finish('needs_manual', `${platform.name}: ${platform.manualOnly}. Apply at ${applyUrl}, then run "mark-submitted ${job.id}"`);
  }
  if (!app) return finish('needs_manual', 'no tailored documents; run the Tailor first');
  const tailored = app.content as TailoredContent;
  const documents = findDocuments(app.dir, tailored);
  if (!documents.cvPdf) return finish('needs_manual', `no CV PDF in ${app.dir}; enable pdf in config/tailor.json and run "tailor render ${job.id}"`);
  const since = new Date(now().getTime() - 30 * 86_400_000).toISOString();
  const recent = store.recentSubmissionsToCompany(job.normCompany, since);
  if (recent >= cfg.maxPerCompanyPer30Days) {
    return finish('needs_manual', `already applied to ${job.company} ${recent} time(s) in 30 days (limit ${cfg.maxPerCompanyPer30Days})`);
  }

  const shotDir = path.join(app.dir, 'submission');
  mkdirSync(shotDir, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const code: CodeStep | undefined = deps.codes
    ? { codes: deps.codes, since: new Date(Date.now() - 60_000), timeoutMs: t.codeTimeoutMs, logger, jobId: job.id }
    : undefined;
  const page = await deps.browser.context.newPage();
  let clicked = false;
  const shoot = async (name: string) => {
    if (page.isClosed()) return;
    const file = path.join(shotDir, `${stamp}-${mode}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
    if (existsSync(file)) screenshots.push(file);
  };

  try {
    logger.info(`#${job.id}: opening ${applyUrl} (${platform.name}, ${mode} mode)`);
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: t.settleMs }).catch(() => undefined);

    let { frame, count } = await findFormFrame(page);
    if (count < 2 && (await revealForm(page))) ({ frame, count } = await findFormFrame(page));
    const blockers = await detectBlockers(page);
    if (blockers.includes('sign-in or account creation')) {
      await shoot('blocked');
      return finish('needs_manual', `the site asks you to sign in or create an account. Apply at ${applyUrl}, then run "mark-submitted ${job.id}"`);
    }
    if (count < 2) {
      await shoot('no-form');
      return finish('needs_manual', `no application form found at ${applyUrl}`);
    }
    // The apply page of an alert job was found by the web lookup: make sure it's this job's page.
    if (job.enrichedAt && job.applyUrl && !(await pageMentionsTitle(page, job.title))) {
      await shoot('wrong-page');
      return finish('needs_manual', `the page at ${applyUrl} doesn't mention "${job.title}"; check it's the right job before applying`);
    }

    // --- plan answers: your data first, the model only for what's left
    const formFields = await extractFields(frame);
    const profile = buildProfile(deps.cv, deps.answers, deps.contact);
    const plan = planDeterministic(formFields, { job, profile, answers: deps.answers, documents });
    const ask = forModel(plan);
    if (ask.length && deps.mapper) {
      try {
        const mapped = await deps.mapper.map({
          fields: formFields.filter((f) => ask.some((a) => a.key === f.key)),
          job: { title: job.title, company: job.company, location: job.location },
          profile,
          answers: deps.answers,
          cv: deps.cv,
          tailored,
        });
        applyMapped(plan, formFields, new Set(ask.map((a) => a.key)), mapped);
      } catch (err) {
        logger.warn(`#${job.id}: model could not help with ${ask.length} question(s): ${(err as Error).message}`);
      }
    }

    await guardSubmit(frame, true);
    for (const answerPlan of plan) {
      const field = formFields.find((f) => f.key === answerPlan.key)!;
      await fillAnswer(frame, field, answerPlan);
    }
    await guardSubmit(frame, false);
    fields = fieldsForRecord(plan);
    const unresolved = plan.filter((p) => p.required && (!p.value || p.filled === false));
    const modelAnswers = plan.filter((p) => MODEL_SOURCES.includes(p.source) && p.filled);
    await shoot('filled');

    const summary = [
      `${plan.filter((p) => p.filled).length}/${plan.length} fields filled`,
      unresolved.length ? `${unresolved.length} required need you: ${unresolved.map((u) => `"${u.label}"`).join(', ')}` : '',
      modelAnswers.length ? `${modelAnswers.length} written by the model` : '',
      blockers.length ? `page shows ${blockers.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');

    if (mode === 'prepare') return finish('prepared', summary);

    if (mode === 'auto') {
      const stop: string[] = [];
      if (blockers.length) stop.push(`the page shows ${blockers.join(', ')}`);
      if (unresolved.length) stop.push(`${unresolved.length} required question(s) need you: ${unresolved.map((u) => `"${u.label}"`).join(', ')}`);
      const held = modelAnswers.filter((a) => cfg.autoSubmitModelAnswers === 'none' || (cfg.autoSubmitModelAnswers === 'facts' && a.source === 'model_draft'));
      if (held.length) stop.push(`${held.length} answer(s) were written by the model and need your review`);
      if (stop.length) return finish('needs_manual', `${stop.join('; ')}. Finish with: run --mode assist --job ${job.id}`);

      const submit = await findSubmitButton(frame);
      if (!submit) return finish('needs_manual', 'no submit button found');
      clicked = true;
      await submit.click();
      const confirmation = await waitForConfirmation(page, t.confirmTimeoutMs, t.pollMs, code);
      await shoot(confirmation ? 'confirmed' : 'after-submit');
      if (confirmation) return finish('submitted', null, confirmation);
      const after = await detectBlockers(page);
      if (after.some((b) => b.startsWith('CAPTCHA'))) {
        return finish('needs_manual', `a CAPTCHA appeared after clicking Submit. Finish with: run --mode assist --job ${job.id}`);
      }
      return finish(
        'needs_manual',
        `clicked Submit but saw no confirmation. Check your email before retrying; if it went through, run "mark-submitted ${job.id}"`,
      );
    }

    // --- assist: you review and click Submit; we watch for the confirmation
    await highlight(frame, unresolved.map((u) => u.key));
    await deps.onAssist?.({ job, page, applyUrl, unresolved, modelAnswers, blockers });
    const confirmation = await waitForConfirmation(page, cfg.assistTimeoutMinutes * 60_000, t.pollMs, code);
    if (confirmation) {
      await shoot('confirmed');
      return finish('submitted', null, confirmation);
    }
    return finish('needs_manual', `no confirmation seen (browser closed or timed out). If you did submit, run "mark-submitted ${job.id}"`);
  } catch (err) {
    const message = (err as Error).message.split('\n')[0]!;
    await shoot('error');
    if (clicked) return finish('needs_manual', `error after clicking Submit (${message}). Check your email; if it went through, run "mark-submitted ${job.id}"`);
    return finish('failed', message);
  } finally {
    if (!page.isClosed()) await page.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- a run

export interface SubmitRunStats {
  attempted: number;
  submitted: number;
  prepared: number;
  needsManual: number;
  failed: number;
}

export async function runSubmitter(deps: SubmitDeps, mode: SubmitMode, opts: { jobIds?: number[] } = {}): Promise<SubmitRunStats> {
  const { store, logger } = deps;
  const t = { ...DEFAULT_TIMING, ...deps.timing };
  const stats: SubmitRunStats = { attempted: 0, submitted: 0, prepared: 0, needsManual: 0, failed: 0 };
  // Auto never retries needs_manual jobs: those are waiting for you.
  const eligible = mode === 'auto' ? (['approved'] as const) : SUBMIT_INPUT_STATUSES;
  const jobs = (opts.jobIds?.length ? opts.jobIds.map((id) => store.get(id)) : store.listByStatus(eligible))
    .filter((j): j is JobRow => Boolean(j && eligible.includes(j.status)))
    .filter((j) => !store.submissions(j.id).some((s) => s.outcome === 'submitted'))
    .slice(0, deps.cfg.maxPerRun);
  if (jobs.length === 0) {
    logger.info('Nothing to submit. Approve tailored jobs first: npm run tailor -- approve <id>');
    return stats;
  }

  const runId = store.startRun('submitter', new Date().toISOString());
  for (const [i, job] of jobs.entries()) {
    if (mode === 'auto' && i > 0 && t.betweenMs > 0) await sleep(t.betweenMs);
    stats.attempted++;
    try {
      const record = await submitJob(job, mode, deps);
      if (record.outcome === 'submitted') stats.submitted++;
      else if (record.outcome === 'prepared') stats.prepared++;
      else if (record.outcome === 'needs_manual') stats.needsManual++;
      else stats.failed++;
    } catch (err) {
      stats.failed++;
      logger.warn(`#${job.id}: ${(err as Error).message}`);
    }
  }
  store.finishRun(runId, { mode, ...stats }, new Date().toISOString());
  return stats;
}

/** For jobs you applied to yourself (LinkedIn, Workday, a CAPTCHA you finished by hand). */
export function markSubmitted(store: JobStore, jobId: number, note: string | null, now = new Date()): SubmissionRecord {
  const job = store.get(jobId);
  if (!job) throw new Error(`#${jobId}: not found`);
  if (store.submissions(jobId).some((s) => s.outcome === 'submitted')) throw new Error(`#${jobId} is already marked submitted`);
  const app = store.latestApplication(jobId);
  const record = store.saveSubmission({
    jobId,
    applicationId: app?.id ?? null,
    mode: 'manual',
    outcome: 'submitted',
    applyUrl: resolveApplyUrl(job),
    reason: note,
    fields: null,
    screenshots: [],
    confirmation: 'marked submitted by you',
    createdAt: now.toISOString(),
  });
  store.setStatus(jobId, 'submitted', note ?? 'applied manually', 'user', now.toISOString());
  return record;
}
