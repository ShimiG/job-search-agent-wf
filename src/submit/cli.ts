import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, MasterCvSchema, imapCredentialsFromEnv, loadJsonFile, resolvePaths } from '../config.ts';
import { JobStore } from '../db/store.ts';
import { TailorConfigSchema } from '../tailor/schema.ts';
import { createLogger } from '../util/logger.ts';
import { AnthropicFieldMapper } from './llm.ts';
import { createImapCodeSource } from './otp.ts';
import { markSubmitted, openBrowser, runSubmitter, type AssistInfo } from './run.ts';
import { SubmitFileSchema, type PlannedAnswer, type SubmitMode } from './schema.ts';

const HELP = `job-submitter — Agent 3: fill and submit applications you approved

Usage: npm run submit -- <command> [options]

Commands:
  run [--mode assist|prepare|auto] [--job 12,15]
        assist  (default) opens a browser, fills the form, and waits for YOU to review and click Submit
        prepare fills the form invisibly, saves a screenshot, never submits
        auto    submits by itself, only if autoSubmit is on in config/submit.json and every answer
                came from your own data (no model-written answers, no CAPTCHA, nothing missing)
  list                       Approved, needing you, submitted
  show <job-id>              Last attempt: every field, what was filled and where it came from
  mark-submitted <job-id> [--note "..."]   You applied yourself (LinkedIn, Workday, ...)
  retry <job-id>             Put a failed job back in the queue
`;

const parseId = (v: string | undefined) => {
  const id = Number(String(v ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new ConfigError('Pass a numeric job ID');
  return id;
};

function printAssist(info: AssistInfo) {
  console.log(`\n#${info.job.id} ${info.job.company} — ${info.job.title}`);
  console.log(`The form is open in the browser. Review every field before submitting.`);
  if (info.blockers.length) console.log(`  The page shows: ${info.blockers.join(', ')}. That part is yours.`);
  if (info.unresolved.length) {
    console.log(`  Needs you (outlined in red):`);
    for (const u of info.unresolved) console.log(`    - ${u.label}${u.error ? ` (${u.error})` : ''}${u.detail ? `  [${u.detail}]` : ''}`);
  }
  if (info.modelAnswers.length) {
    console.log(`  Written by the model, check these:`);
    for (const m of info.modelAnswers) console.log(`    - ${m.label}: "${m.value.slice(0, 100)}${m.value.length > 100 ? '…' : ''}"`);
  }
  console.log(`Click Submit in the browser when you're happy. I'll detect the confirmation and record it.`);
}

const sourceLabel: Record<PlannedAnswer['source'], string> = {
  profile: 'profile',
  answer_bank: 'answer bank',
  document: 'document',
  demographics: 'declined',
  consent: 'consent',
  model_fact: 'MODEL (fact)',
  model_draft: 'MODEL (draft)',
  none: '—',
};

async function main() {
  const root = process.cwd();
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const paths = resolvePaths(root);
  const logger = createLogger();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      job: { type: 'string' },
      note: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  const loadSubmit = () => {
    if (!existsSync(paths.submit)) throw new ConfigError(`Missing ${paths.submit}. Run "npm run scout -- init" to create it.`);
    return loadJsonFile(paths.submit, SubmitFileSchema);
  };

  switch (command) {
    case 'run': {
      const mode = (values.mode ?? 'assist') as SubmitMode;
      if (!['assist', 'prepare', 'auto'].includes(mode)) throw new ConfigError('--mode must be assist, prepare or auto');
      const settings = loadSubmit();
      if (mode === 'auto' && !settings.autoSubmit) {
        throw new ConfigError('Auto mode is off. Set "autoSubmit": true in config/submit.json if you want it, or use --mode assist.');
      }
      const cv = loadJsonFile(paths.masterCv, MasterCvSchema);
      const tailor = loadJsonFile(paths.tailor, TailorConfigSchema);
      const mapper = process.env.ANTHROPIC_API_KEY ? new AnthropicFieldMapper({ model: process.env.TAILOR_MODEL }) : null;
      if (!mapper) logger.warn('ANTHROPIC_API_KEY not set: unusual questions will be left for you');
      const imap = imapCredentialsFromEnv();
      if (!imap) logger.warn('IMAP_USER / IMAP_PASSWORD not set: emailed security codes will be left for you');
      const store = new JobStore(paths.db);
      const browser = await openBrowser({ browserPath: settings.browserPath, headless: mode !== 'assist', userDataDir: paths.browserProfile });
      try {
        const jobIds = values.job ? values.job.split(',').map(parseId) : undefined;
        const stats = await runSubmitter(
          { store, cv, answers: settings, contact: tailor.contact, cfg: settings, mapper, browser, logger, onAssist: printAssist, codes: imap ? createImapCodeSource(imap, logger) : null },
          mode,
          { jobIds },
        );
        if (stats.attempted) {
          console.log(
            `\n${stats.submitted} submitted, ${stats.prepared} prepared, ${stats.needsManual} need you, ${stats.failed} failed.` +
              (stats.needsManual ? ' See: npm run submit -- list' : ''),
          );
        }
      } finally {
        await browser.close();
        store.close();
      }
      return;
    }

    case 'list': {
      const store = new JobStore(paths.db);
      try {
        const groups: Array<[string, Parameters<typeof store.listByStatus>[0]]> = [
          ['Approved, ready to submit', ['approved']],
          ['Needs you', ['needs_manual']],
          ['Failed', ['failed']],
          ['Submitted', ['submitted']],
        ];
        for (const [title, statuses] of groups) {
          const jobs = store.listByStatus(statuses, { includeClosed: true });
          if (!jobs.length) continue;
          console.log(`\n${title}:`);
          for (const j of jobs) {
            const last = store.submissions(j.id).at(-1);
            console.log(`  #${j.id}  ${j.company} — ${j.title}`);
            if (last && j.status !== 'approved') console.log(`        ${last.createdAt.slice(0, 16).replace('T', ' ')}  ${last.reason ?? last.confirmation ?? ''}`);
          }
        }
      } finally {
        store.close();
      }
      return;
    }

    case 'show': {
      const id = parseId(args[0]);
      const store = new JobStore(paths.db);
      try {
        const job = store.get(id);
        const last = store.submissions(id).at(-1);
        if (!job || !last) throw new ConfigError(`#${id}: no submission attempts yet`);
        console.log(`#${id} ${job.company} — ${job.title}  [${job.status}]`);
        console.log(`Last attempt: ${last.mode} → ${last.outcome}  ${last.createdAt.slice(0, 16).replace('T', ' ')}`);
        if (last.reason) console.log(`Reason: ${last.reason}`);
        if (last.confirmation) console.log(`Confirmation: ${last.confirmation}`);
        console.log(`URL: ${last.applyUrl}`);
        const fields = (last.fields ?? []) as PlannedAnswer[];
        if (fields.length) {
          console.log('\nFields:');
          for (const f of fields) {
            const mark = f.filled ? '✓' : f.required ? '✗' : ' ';
            const value = f.value ? `"${f.value.slice(0, 70)}${f.value.length > 70 ? '…' : ''}"` : '';
            console.log(`  ${mark} ${f.label}${f.required ? ' *' : ''}  ${value}  [${sourceLabel[f.source]}]${f.error ? `  error: ${f.error}` : ''}`);
          }
        }
        if (last.screenshots.length) console.log(`\nScreenshots:\n${last.screenshots.map((s) => `  ${s}`).join('\n')}`);
      } finally {
        store.close();
      }
      return;
    }

    case 'mark-submitted': {
      const id = parseId(args[0]);
      const store = new JobStore(paths.db);
      try {
        markSubmitted(store, id, values.note ?? null);
        console.log(`#${id}: recorded as submitted.`);
      } finally {
        store.close();
      }
      return;
    }

    case 'retry': {
      const id = parseId(args[0]);
      const store = new JobStore(paths.db);
      try {
        const job = store.get(id);
        if (!job || !['failed', 'needs_manual'].includes(job.status)) throw new ConfigError(`#${id} is not failed or waiting for you`);
        store.setStatus(id, 'approved', 'retry requested', 'user', new Date().toISOString());
        console.log(`#${id}: back in the queue.`);
      } finally {
        store.close();
      }
      return;
    }

    default:
      console.log(HELP);
      if (command && command !== 'help' && !values.help) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exitCode = 1;
});
