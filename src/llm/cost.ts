import { AsyncLocalStorage } from 'node:async_hooks';
import type { JobStore } from '../db/store.ts';

/*
 * What each Claude call costs, from the usage block every response carries. One price table for the
 * whole app; each agent reports its calls to a CostMeter, which stores them with the run and job they
 * belong to, so the review page can show what a run, an application or a callback cost.
 */

/** Dollars per million tokens. Anthropic first-party API rates; update here if they change. */
interface Rates {
  input: number;
  output: number;
  /** 5-minute cache writes (1.25x input). */
  cacheWrite: number;
  cacheRead: number;
}

export const PRICES: Record<string, Rates> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

/** Claude Haiku 5.5 charges more for prompts over 100K tokens. */
const HAIKU_LONG: Rates = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };

/** Web search is billed per search on top of tokens; web fetch only costs its tokens. */
export const WEB_SEARCH_DOLLARS = 0.01;

/** Models not in the table are priced as Sonnet 5.5 (the default model everywhere in this app). */
export const FALLBACK_MODEL = 'claude-sonnet-5-5';

/** The usage block of a Messages API response (both the regular and the beta client). */
export interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export function tokenCounts(u: ApiUsage): TokenCounts {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
  };
}

/** A dated snapshot ("claude-haiku-5-5-20260101") is priced as its model. */
function ratesFor(model: string, promptTokens: number): Rates {
  const id = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-2`)) ?? FALLBACK_MODEL;
  if (id === 'claude-haiku-5-5' && promptTokens > 100_000) return HAIKU_LONG;
  return PRICES[id]!;
}

/** Dollars for one call's tokens. */
export function tokenCost(model: string, t: TokenCounts): number {
  const r = ratesFor(model, t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens);
  return (t.inputTokens * r.input + t.outputTokens * r.output + t.cacheWriteTokens * r.cacheWrite + t.cacheReadTokens * r.cacheRead) / 1e6 + t.webSearches * WEB_SEARCH_DOLLARS;
}

export const usageCost = (model: string, u: ApiUsage) => tokenCost(model, tokenCounts(u));

/** What a call was for. Shown on the review page, so keep them short. */
export type UsagePurpose = 'score' | 'lookup' | 'draft' | 'fact-check' | 'revise' | 'form' | 'posting' | 'cv';

export const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  score: 'scoring jobs',
  lookup: 'looking up full postings',
  draft: 'writing CVs and letters',
  'fact-check': 'fact-checking',
  revise: 'revising letters',
  form: 'answering form questions',
  posting: 'reading pasted links',
  cv: 'converting your CV',
};

export type UsageAgent = 'scout' | 'tailor' | 'submitter' | 'review';

export interface UsageEntry extends TokenCounts {
  at: string;
  agent: UsageAgent;
  purpose: UsagePurpose;
  model: string;
  jobId: number | null;
  runId: number | null;
  cost: number;
}

const currentJob = new AsyncLocalStorage<number>();

/** Claude calls made inside `fn` (and anything it awaits) are counted against `jobId`. */
export function withJob<T>(jobId: number, fn: () => Promise<T>): Promise<T> {
  return currentJob.run(jobId, fn);
}

/**
 * Collects the cost of every Claude call an agent makes. Clients call record() after each response;
 * a run attach()es it to the database so calls are stored as they happen (a run that crashes halfway
 * still shows what it spent). Until then entries wait in memory.
 */
export class CostMeter {
  private pending: UsageEntry[] = [];
  private store: JobStore | null = null;
  private runId: number | null = null;
  private spent = 0;
  private readonly byPurpose = new Map<UsagePurpose, number>();

  constructor(
    private readonly agent: UsageAgent,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  record(purpose: UsagePurpose, model: string, usage: ApiUsage, jobId?: number | null): number {
    const counts = tokenCounts(usage);
    const cost = tokenCost(model, counts);
    const entry: UsageEntry = {
      ...counts,
      at: this.clock().toISOString(),
      agent: this.agent,
      purpose,
      model,
      jobId: jobId ?? currentJob.getStore() ?? null,
      runId: this.runId,
      cost,
    };
    this.spent += cost;
    this.byPurpose.set(purpose, (this.byPurpose.get(purpose) ?? 0) + cost);
    if (this.store) this.store.saveUsage(entry);
    else this.pending.push(entry);
    return cost;
  }

  /** From now on entries go straight to the database, tagged with this run. Waiting ones are saved too. */
  attach(store: JobStore, runId: number | null = null): void {
    this.store = store;
    this.runId = runId;
    for (const e of this.pending) store.saveUsage({ ...e, runId: e.runId ?? runId });
    this.pending = [];
  }

  /** Stops writing to the store (it may be about to close). Later calls wait in memory again. */
  detach(): void {
    this.store = null;
    this.runId = null;
  }

  /** Dollars spent since this meter was created, in total and by purpose. */
  totals(): { total: number; byPurpose: Partial<Record<UsagePurpose, number>> } {
    return { total: this.spent, byPurpose: Object.fromEntries(this.byPurpose) };
  }
}

export const formatDollars = (d: number) => (d === 0 ? '$0' : d < 0.01 ? '<$0.01' : `$${d.toFixed(2)}`);
