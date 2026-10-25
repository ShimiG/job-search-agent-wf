import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, MasterCvSchema, loadJsonFile, resolvePaths } from '../config.ts';
import { JobStore } from '../db/store.ts';
import type { JobStatus } from '../types.ts';
import { createLogger } from '../util/logger.ts';
import { AnthropicTailor } from './llm.ts';
import { launchPdfEngine, type PdfEngine } from './render.ts';
import { rerender, runTailor } from './run.ts';
import { TailorConfigSchema, type VerificationReport } from './schema.ts';

const HELP = `job-tailor — Agent 2: a grounded CV and cover letter for each job you picked

Usage: npm run tailor -- <command> [options]

Commands:
  run [--job 12,15] [--no-pdf]   Tailor picked jobs (default: all picked, up to maxJobsPerRun)
  list                           Jobs waiting for you, plus anything picked or failed
  show <job-id>                  The review report: unverified claims, gaps, reworded bullets
  open <job-id>                  Open the latest CV and cover letter
  approve <job-id> [--force]     Mark ready for the Submitter (--force if items still need review)
  redo <job-id> --note "..."     Regenerate with your instructions ("lead with the integration work")
  reject <job-id>                Not applying after all (status → dismissed)
  render <job-id>                Re-render after you edit content.json by hand
`;

function parseId(value: string | undefined): number {
  const id = Number(String(value ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new ConfigError('Pass a numeric job ID, e.g. "show 12"');
  return id;
}

function openFile(file: string) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function withPdf<T>(enabled: boolean, browserPath: string, fn: (pdf: PdfEngine | null) => Promise<T>): Promise<T> {
  const pdf = enabled ? await launchPdfEngine(browserPath) : null;
  try {
    return await fn(pdf);
  } finally {
    await pdf?.close();
  }
}

async function main() {
  const root = process.cwd();
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const paths = resolvePaths(root);
  const logger = createLogger();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      job: { type: 'string' },
      'no-pdf': { type: 'boolean' },
      force: { type: 'boolean' },
      note: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  const store = () => new JobStore(paths.db);
  const loadTailorConfig = () => {
    if (!existsSync(paths.tailor)) throw new ConfigError(`Missing ${paths.tailor}. Run "npm run scout -- init" to create it.`);
    return loadJsonFile(paths.tailor, TailorConfigSchema);
  };

  switch (command) {
    case 'run': {
      if (!process.env.ANTHROPIC_API_KEY) throw new ConfigError('ANTHROPIC_API_KEY is not set. Add it to .env.');
      const cfg = loadTailorConfig();
      const cv = loadJsonFile(paths.masterCv, MasterCvSchema);
      const llm = new AnthropicTailor({ model: process.env.TAILOR_MODEL });
      const jobIds = values.job ? values.job.split(',').map((v) => parseId(v)) : undefined;
      const db = store();
      try {
        const stats = await withPdf(cfg.pdf.enabled && !values['no-pdf'], cfg.pdf.browserPath, (pdf) =>
          runTailor({ store: db, cv, cfg, writer: llm, verifier: llm, pdf, outDir: paths.applicationsDir, logger, model: llm.model }, { jobIds }),
        );
        if (stats.attempted) {
          console.log(`\nTailored ${stats.tailored}/${stats.attempted}${stats.needsReview ? `, ${stats.needsReview} need your review` : ''}${stats.errors.length ? `, ${stats.errors.length} failed` : ''}.`);
          console.log('Review with: npm run tailor -- list');
        }
      } finally {
        db.close();
      }
      return;
    }

    case 'list': {
      const db = store();
      try {
        const groups: Array<[string, JobStatus[]]> = [
          ['Waiting for your review', ['tailored']],
          ['Picked, not tailored yet', ['selected']],
          ['Failed (will retry on next run)', ['tailor_error']],
          ['Approved for the Submitter', ['approved']],
        ];
        for (const [title, statuses] of groups) {
          const jobs = db.listByStatus(statuses);
          if (!jobs.length) continue;
          console.log(`\n${title}:`);
          for (const j of jobs) {
            const app = db.latestApplication(j.id);
            const flag = app && !(app.verification as VerificationReport).ok ? '  ⚠ needs review' : '';
            console.log(`  #${j.id}  ${j.company} — ${j.title}${app ? `  (v${app.version})` : ''}${flag}${j.status === 'tailor_error' ? `\n        ${j.statusReason}` : ''}`);
          }
        }
      } finally {
        db.close();
      }
      return;
    }

    case 'show':
    case 'open': {
      const id = parseId(args[0]);
      const db = store();
      try {
        const app = db.latestApplication(id);
        if (!app) throw new ConfigError(`#${id} has no tailored version yet.`);
        if (command === 'show') {
          console.log(readFileSync(path.join(app.dir, 'report.md'), 'utf8'));
          console.log(`Folder: ${app.dir}`);
        } else {
          const files = readdirSync(app.dir).filter((f) => f.endsWith('.pdf'));
          const targets = files.length ? files : readdirSync(app.dir).filter((f) => f.endsWith('.html'));
          for (const f of targets) openFile(path.join(app.dir, f));
          console.log(`Opened ${targets.join(', ')}`);
        }
      } finally {
        db.close();
      }
      return;
    }

    case 'approve':
    case 'reject':
    case 'redo': {
      const id = parseId(args[0]);
      const db = store();
      try {
        const job = db.get(id);
        if (!job) throw new ConfigError(`#${id}: not found`);
        const now = new Date().toISOString();
        if (command === 'approve') {
          if (job.status !== 'tailored') throw new ConfigError(`#${id} is "${job.status}"; only tailored jobs can be approved.`);
          const report = db.latestApplication(id)!.verification as VerificationReport;
          const open = report.issues.filter((i) => i.severity === 'unresolved');
          if (open.length && !values.force) {
            throw new ConfigError(`#${id} has ${open.length} unverified item(s). Check "npm run tailor -- show ${id}", then fix, redo, or approve --force.`);
          }
          db.setStatus(id, 'approved', open.length ? `approved with ${open.length} unverified item(s)` : null, 'user', now);
          console.log(`#${id}: approved. The Submitter will pick it up.`);
        } else if (command === 'reject') {
          if (!['tailored', 'selected', 'tailor_error', 'approved'].includes(job.status)) throw new ConfigError(`#${id} is "${job.status}".`);
          db.setStatus(id, 'dismissed', 'rejected at review', 'user', now);
          console.log(`#${id}: dismissed.`);
        } else {
          if (!values.note) throw new ConfigError('Say what to change: redo <id> --note "lead with the integration work"');
          if (!['tailored', 'tailor_error', 'approved'].includes(job.status)) throw new ConfigError(`#${id} is "${job.status}".`);
          db.setTailorFeedback(id, values.note);
          db.setStatus(id, 'selected', `redo: ${values.note}`, 'user', now);
          console.log(`#${id}: queued for a new version. Run: npm run tailor -- run --job ${id}`);
        }
      } finally {
        db.close();
      }
      return;
    }

    case 'render': {
      const id = parseId(args[0]);
      const cfg = loadTailorConfig();
      const cv = loadJsonFile(paths.masterCv, MasterCvSchema);
      const db = store();
      try {
        const { app, report } = await withPdf(cfg.pdf.enabled && !values['no-pdf'], cfg.pdf.browserPath, (pdf) =>
          rerender(id, { store: db, cv, cfg, pdf }),
        );
        const notes = report.issues.length - 1;
        console.log(`#${id}: re-rendered v${app.version}${notes > 0 ? ` with ${notes} warning(s), see "show ${id}"` : ''}.`);
      } finally {
        db.close();
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
