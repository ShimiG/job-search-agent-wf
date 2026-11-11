import type { Preferences } from '../config.ts';
import type { JobStore } from '../db/store.ts';
import type { BatchScoring } from '../llm/scorer.ts';
import type { JobRow, ScoreResult } from '../types.ts';
import type { Logger } from '../util/logger.ts';

/*
 * Scoring through Claude's Message Batches API: half the price of scoring now, with results usually
 * within the hour and 24 hours at most. For runs nobody is waiting on, like the scheduled one.
 *
 * A run submits its queue as one batch and waits for it for a while. If the scores arrive in time the
 * run carries on as usual; if not, the batch is remembered and whichever run comes next collects it.
 * Jobs in a batch that's still being processed are never scored a second time.
 */

export interface PendingBatch {
  id: string;
  jobIds: number[];
  submittedAt: string;
  /** The scorer that sent it, saved with each score. */
  model: string | null;
}

export interface BatchStats {
  /** Jobs sent for scoring this run. */
  submitted: number;
  /** Jobs whose batch score arrived this run. */
  collected: number;
  /** Jobs in batches still being processed when the run ended: the next run collects them. */
  pending: number;
}

const KEY = 'scoring_batches';
/** Batches expire after 24 hours; one older than this with no result is given up on. */
const GIVE_UP_HOURS = 30;
export const POLL_SECONDS = 30;

export function pendingBatches(store: JobStore): PendingBatch[] {
  try {
    const list = JSON.parse(store.getKv(KEY) ?? '[]') as PendingBatch[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const save = (store: JobStore, list: PendingBatch[]) => store.setKv(KEY, JSON.stringify(list));

export function rememberBatch(store: JobStore, batch: PendingBatch): void {
  save(store, [...pendingBatches(store), batch]);
}

/** Jobs being scored in a batch right now: left out of every scoring queue until it ends. */
export function jobsInBatches(store: JobStore): Set<number> {
  return new Set(pendingBatches(store).flatMap((b) => b.jobIds));
}

export interface Collected {
  /** A score arrived for a job still waiting for one. */
  scored: Array<{ job: JobRow; result: ScoreResult; model: string | null }>;
  /** The model answered, but not with a usable score (declined, cut off): counts as a failed attempt. */
  failed: Array<{ job: JobRow; error: string }>;
  /** The request never ran (errored, expired, cancelled, or the batch was lost): score these now. */
  retry: JobRow[];
  /** Batches still being processed. */
  stillPending: number;
}

/** Still waiting for a score: a job you applied to, removed, or that closed meanwhile is skipped. */
const waiting = (job: JobRow | undefined): job is JobRow => Boolean(job && (job.status === 'queued' || job.status === 'score_error') && !job.closedAt);

/**
 * Fetches the results of every batch that has ended and forgets it. Nothing is written to the jobs:
 * the caller saves the scores, so placing them follows the same rules as live scoring.
 */
export async function collectBatches(store: JobStore, batcher: BatchScoring, logger: Logger, now: Date, only?: string): Promise<Collected> {
  const out: Collected = { scored: [], failed: [], retry: [], stillPending: 0 };
  for (const batch of pendingBatches(store)) {
    if (only && batch.id !== only) continue;
    const jobs = batch.jobIds.map((id) => store.get(id)).filter(waiting);
    const forget = () => save(store, pendingBatches(store).filter((b) => b.id !== batch.id));
    let results;
    try {
      results = await batcher.collect(batch.id);
    } catch (err) {
      const tooOld = now.getTime() - Date.parse(batch.submittedAt) > GIVE_UP_HOURS * 3_600_000;
      logger.warn(`could not read scoring batch ${batch.id}: ${(err as Error).message}${tooOld ? '; giving up on it' : ''}`);
      if (tooOld) {
        forget();
        out.retry.push(...jobs);
      } else out.stillPending += jobs.length;
      continue;
    }
    if (results === null) {
      if (now.getTime() - Date.parse(batch.submittedAt) > GIVE_UP_HOURS * 3_600_000) {
        forget();
        out.retry.push(...jobs);
      } else out.stillPending += jobs.length;
      continue;
    }
    forget();
    for (const job of jobs) {
      const r = results.get(job.id);
      if (!r) out.retry.push(job);
      else if (r.ok) out.scored.push({ job, result: r.result, model: batch.model });
      else if (r.retry) out.retry.push(job);
      else out.failed.push({ job, error: r.error });
    }
  }
  return out;
}

/** How many times to ask whether a batch has ended before leaving it for the next run. */
export const pollCount = (prefs: Preferences) => Math.ceil((prefs.scoring.batchWaitMinutes * 60) / POLL_SECONDS);
