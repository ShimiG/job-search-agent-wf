import { sleep } from '../util/limiter.ts';

export interface Http {
  getJson(url: string): Promise<unknown>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
  }
}

export interface FetchHttpOptions {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

/** fetch() wrapper: timeouts, retries on network errors / 429 / 5xx, honors Retry-After. */
export class FetchHttp implements Http {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FetchHttpOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.userAgent = opts.userAgent ?? 'job-scout/0.1 (personal job search tool)';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getJson(url: string): Promise<unknown> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoff(attempt, lastError));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = new HttpError(`Network error: ${(err as Error).message}`, null, url);
        continue;
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new HttpError('Response was not valid JSON', res.status, url);
        }
      }
      const error = new HttpError(`HTTP ${res.status} ${res.statusText}`.trim(), res.status, url);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        lastError = Object.assign(error, { retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 });
        continue;
      }
      // 4xx other than 429: retrying won't help. A 404 almost always means a wrong board token.
      if (res.status === 404) error.message += ' (board not found: check the token in config/sources.json)';
      throw error;
    }
    throw lastError ?? new HttpError('Request failed', null, url);
  }

  private backoff(attempt: number, err?: Error): number {
    const retryAfterMs = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0;
    const exp = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.baseDelayMs * 0.25;
    return Math.min(Math.max(retryAfterMs, exp + jitter), 60_000);
  }
}
