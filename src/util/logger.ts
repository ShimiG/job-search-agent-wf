const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info'): Logger {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const time = new Date().toISOString().slice(11, 19);
    const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
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
