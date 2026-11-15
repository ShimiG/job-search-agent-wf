import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Where a logger also keeps its lines: one JSON object per line, one file per day. */
export interface LogFile {
  /** The folder for the daily files, e.g. data/logs. */
  dir: string;
  /** Which agent is writing: scout, tailor, submitter, archiver. */
  agent: string;
}

/** Log files older than this are deleted when an agent starts. LOG_KEEP_DAYS changes it. */
export const LOG_KEEP_DAYS = 30;

const dayFile = (dir: string, at: Date) => path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`);

/** Deletes daily log files older than `keepDays`. Returns how many went. */
export function pruneLogs(dir: string, keepDays: number, now = new Date()): number {
  const oldest = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (!day || day >= oldest) continue;
    try {
      unlinkSync(path.join(dir, name));
      removed++;
    } catch {
      // Someone else has it open: it goes next time.
    }
  }
  return removed;
}

/**
 * Prints to the terminal at `level` and above. With `file`, every line (debug ones too) is also kept
 * in <dir>/<date>.jsonl as {"t","level","agent","msg","meta"}, so a run can be looked into afterwards:
 * what failed, when, and for which job. LOG_TO_FILE=false turns the file off. A log that can't be
 * written never stops an agent.
 */
export function createLogger(level: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info', file?: LogFile, clock: () => Date = () => new Date()): Logger {
  const min = LEVELS[level] ?? LEVELS.info;
  let sink = file && process.env.LOG_TO_FILE !== 'false' ? file : null;
  if (sink) {
    try {
      mkdirSync(sink.dir, { recursive: true });
      pruneLogs(sink.dir, Number(process.env.LOG_KEEP_DAYS) || LOG_KEEP_DAYS, clock());
    } catch {
      sink = null;
    }
  }
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    const at = clock();
    const hasMeta = meta && Object.keys(meta).length > 0;
    if (sink) {
      try {
        appendFileSync(dayFile(sink.dir, at), JSON.stringify({ t: at.toISOString(), level: lvl, agent: sink.agent, msg, ...(hasMeta ? { meta } : {}) }) + '\n');
      } catch {
        sink = null;
      }
    }
    if (LEVELS[lvl] < min) return;
    const time = at.toISOString().slice(11, 19);
    const extra = hasMeta ? ' ' + JSON.stringify(meta) : '';
    const line = `${time} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`;
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
