import type { Preferences } from '../config.ts';
import type { JobRow, ScoreResult } from '../types.ts';
import type { JobStore } from '../db/store.ts';
import type { Scorer } from '../llm/scorer.ts';
import { collectBatches, jobsInBatches, pendingBatches, pollCount, POLL_SECONDS, rememberBatch, type BatchStats, type Collected } from './batch.ts';
import type { CostMeter, UsagePurpose } from '../llm/cost.ts';
import type { SourceAdapter } from '../sources/common.ts';
import type { Http } from '../sources/http.ts';
import type { Logger } from '../util/logger.ts';
import { mapWithConcurrency, sleep } from '../util/limiter.ts';
import { enrichCost, type Enricher } from '../llm/enrich.ts';
import type { AppliedEmail } from '../sources/applications.ts';
import { linkedinIdClock, linkedinJobId } from './age.ts';
import { checkLinkedInJob, checkPostingPage, isLinkedInJob, type PageCheck } from './closed.ts';
import { recordApplications, sweepAppliedListings } from './applied.ts';
import { decideDuplicate } from './dedupe.ts';
import { applyHardFilters } from './filters.ts';

export interface RunDeps {
  store: JobStore;
  adapters: SourceAdapter[];
  http: Http;
  prefs: Preferences;
  logger: Logger;
  /** Omit to run filters and dedupe only (no LLM cost). */
  scorer?: Scorer;
  /** Confirmation emails for applications you sent yourself. */
  applied?: () => Promise<AppliedEmail[]>;
  /** Finds full postings for shortlisted alert-email jobs. Needs a scorer, to score them again. */
  enricher?: Enricher;
  /** Re-checks found posting pages. Tests replace it; defaults to a plain HTTP check. */
  checkPage?: (url: string) => Promise<PageCheck>;
  /** Re-opens LinkedIn alert jobs' public pages. Tests replace it; null turns it off (emailAlerts.checkClosed). */
  checkLinkedIn?: ((url: string) => Promise<PageCheck>) | null;
  clock?: () => Date;
  /** The meter the scorer and enricher report to; stored with this run. */
  meter?: CostMeter;
  /** Score through the Batch API: half the price, scores later. Ignored by a scorer that has no batches (a local model). */
  batch?: boolean;
  /** Waits between checks on a batch. Tests replace it. */
  wait?: (ms: number) => Promise<void>;
}

export interface RunStats {
  sources: { ok: number; failed: number; errors: Array<{ source: string; error: string }> };
  fetched: number;
  inserted: number;
  changed: number;
  closed: number;
  /** Jobs marked as applied from your confirmation emails (matched + added). */
  alreadyApplied: number;
  /** Listings taken off because you already applied to that job, it's on its way to being sent, or you dismissed it. */
  appliedListings: number;
  evaluated: number;
  filteredOut: number;
  duplicates: number;
  queued: number;
  scored: number;
  shortlisted: number;
  lowScore: number;
  scoreErrors: number;
  /** LinkedIn alert jobs dropped because their job ID shows they were posted long ago. */
  oldAlerts: number;
  /** Jobs whose posting page says (or shows) they stopped taking applications. */
  closedPostings: number;
  /** Shortlisted alert jobs looked up on the web, how many full postings were found, and the cost in dollars. */
  enrich: { tried: number; found: number; cost: number };
  /** Batch scoring: jobs sent this run, scores that arrived, and jobs still waiting in a batch. */
  batch: BatchStats;
  /** Dollars spent on Claude this run, by what it was for (scoring, web lookups). */
  cost: { total: number; byPurpose: Partial<Record<UsagePurpose, number>> };
  /** Still waiting after this run hit maxJobsPerRun. */
  scoringBacklog: number;
  filterReasons: Record<string, number>;
}

function emptyStats(): RunStats {
  return {
    sources: { ok: 0, failed: 0, errors: [] },
    fetched: 0, inserted: 0, changed: 0, closed: 0, alreadyApplied: 0, appliedListings: 0,
    evaluated: 0, filteredOut: 0, duplicates: 0, queued: 0,
    scored: 0, shortlisted: 0, lowScore: 0, scoreErrors: 0, scoringBacklog: 0,
    enrich: { tried: 0, found: 0, cost: 0 },
    cost: { total: 0, byPurpose: {} },
    batch: { submitted: 0, collected: 0, pending: 0 },
    oldAlerts: 0,
    closedPostings: 0,
    filterReasons: {},
  };
}

export async function runScout(deps: RunDeps): Promise<RunStats> {
  const { store, logger, prefs } = deps;
  const clock = deps.clock ?? (() => new Date());
  const iso = () => clock().toISOString();
  const stats = emptyStats();
  const runId = store.startRun('scout', iso());
  deps.meter?.attach(store, runId);

  await collect(deps, stats, iso);
  await markApplied(deps, stats, iso);
  removeAppliedListings(deps, stats, iso);
  evaluate(deps, stats, clock);
  dropOldAlertJobs(deps, stats, clock);
  if (deps.scorer) {
    await score(deps, deps.scorer, stats, iso, clock);
  } else {
    logger.info('Scoring skipped (--no-score). Filtered jobs are waiting in the "queued" state.');
  }
  applyThresholds(deps, iso);
  if (deps.scorer && deps.enricher) {
    await enrichShortlist(deps, deps.enricher, deps.scorer, stats, iso, clock);
    // A found posting's address can show it's the same page you applied on.
    removeAppliedListings(deps, stats, iso);
  }
  await dropClosedPostings(deps, stats, iso);
  // Jobs in a batch are being scored already: they aren't backlog.
  stats.scoringBacklog = Math.max(0, store.countScoringQueue(prefs.scoring.maxAttempts) - stats.batch.pending);

  if (deps.meter) stats.cost = deps.meter.totals();
  deps.meter?.detach();
  store.finishRun(runId, stats, iso());
  return stats;
}

/** Step 1: pull every source and upsert. One broken source never stops the others. */
async function collect(deps: RunDeps, stats: RunStats, iso: () => string) {
  const { store, logger } = deps;
  for (const adapter of deps.adapters) {
    const startedAt = iso();
    try {
      const jobs = await adapter.fetchJobs(deps.http);
      const write = store.db.transaction(() => {
        for (const job of jobs) {
          const { outcome } = store.upsert(job, iso());
          if (outcome === 'inserted') stats.inserted++;
          else if (outcome === 'changed') stats.changed++;
        }
      });
      write();
      stats.fetched += jobs.length;
      if (adapter.snapshotPrefix && (adapter.lastFetchComplete?.() ?? true)) {
        stats.closed += store.markMissingAsClosed(adapter.kind, adapter.snapshotPrefix, startedAt, iso());
      }
      store.sourceSucceeded(adapter.key, jobs.length, iso());
      stats.sources.ok++;
      logger.info(`${adapter.key}: ${jobs.length} posting${jobs.length === 1 ? '' : 's'}`);
    } catch (err) {
      const message = (err as Error).message;
      store.sourceFailed(adapter.key, message, iso());
      stats.sources.failed++;
      stats.sources.errors.push({ source: adapter.key, error: message });
      logger.warn(`${adapter.key} failed: ${message}`);
    }
  }
}

/**
 * Alert emails don't carry a posting date, so the age filter can't see a months-old job LinkedIn is
 * still suggesting. Its job ID can: see age.ts. The estimate can be off by half, so only jobs clearly
 * past the limit (twice maxAgeDays) are dropped. Runs before scoring, so they cost nothing.
 */
function dropOldAlertJobs(deps: RunDeps, stats: RunStats, clock: () => Date) {
  const { store, prefs, logger } = deps;
  if (!prefs.maxAgeDays) return;
  const now = clock();
  const idClock = linkedinIdClock(store.linkedinAlertFrontier(new Date(now.getTime() - 30 * 86_400_000).toISOString()), now);
  if (!idClock) return;
  const limit = prefs.maxAgeDays * 2;
  store.db.transaction(() => {
    for (const job of store.listByStatus(['queued', 'score_error', 'low_score', 'shortlisted'])) {
      const id = job.source === 'email' ? linkedinJobId(job.externalId) : null;
      if (id === null) continue;
      const days = Math.round(idClock.daysAgo(id));
      if (days <= limit) continue;
      store.setStatus(job.id, 'filtered_out', `posted about ${days} days ago (estimated from its LinkedIn job ID)`, 'scout', now.toISOString());
      stats.oldAlerts++;
    }
  })();
  if (stats.oldAlerts) logger.info(`Dropped ${stats.oldAlerts} LinkedIn alert job(s) posted over ~${limit} days ago`);
}

/**
 * Company pages found by the web lookup are re-opened each run (no model, no cost). A posting that's
 * gone or says it's closed leaves your shortlist. Board jobs don't need this: they close when they
 * disappear from the board's API.
 */
async function dropClosedPostings(deps: RunDeps, stats: RunStats, iso: () => string) {
  const { store, logger } = deps;
  const check = deps.checkPage ?? checkPostingPage;
  const closeIt = (job: JobRow, page: string) => {
    store.markClosed(job.id, `no longer accepting applications (${page})`, iso());
    stats.closedPostings++;
    logger.info(`#${job.id} ${job.company} — ${job.title}: no longer accepting applications`);
  };
  const jobs = store.listByStatus(['shortlisted', 'low_score']).filter((j) => j.enrichedAt && (j.postingUrl || j.applyUrl));
  for (const job of jobs) {
    const page = job.applyUrl ?? job.postingUrl!;
    if ((await check(page)) === 'closed') closeIt(job, page);
  }

  // LinkedIn alert jobs say so on their public page. Checked for jobs in your hands, from the
  // shortlist to one stuck in Sending, a few dozen a run and unhurried, so LinkedIn sees a reader.
  if (deps.checkLinkedIn === null) return;
  const checkLinkedIn = deps.checkLinkedIn ?? checkLinkedInJob;
  const alerts = store
    .listByStatus(LINKEDIN_CHECK_STATUSES)
    .filter((j) => j.source === 'email' && isLinkedInJob(j.url) && !j.closedAt)
    .slice(0, LINKEDIN_CHECKS_PER_RUN);
  for (const [i, job] of alerts.entries()) {
    if (i > 0 && !deps.checkLinkedIn) await new Promise((r) => setTimeout(r, LINKEDIN_PAUSE_MS));
    if ((await checkLinkedIn(job.url)) === 'closed') closeIt(job, job.url);
  }
}

/** Where a LinkedIn alert job is worth a look: yours to act on, not yet sent. */
const LINKEDIN_CHECK_STATUSES: readonly JobRow['status'][] = ['shortlisted', 'selected', 'tailor_error', 'tailored', 'approved', 'needs_manual', 'failed'];
const LINKEDIN_CHECKS_PER_RUN = 40;
const LINKEDIN_PAUSE_MS = 1500;

/** Step 1b: jobs you applied to yourself leave Scout's queue before they're filtered or scored. */
async function markApplied(deps: RunDeps, stats: RunStats, iso: () => string) {
  if (!deps.applied) return;
  try {
    const apps = await deps.applied();
    const result = deps.store.db.transaction(() => recordApplications(deps.store, apps, iso()))();
    stats.alreadyApplied = result.matched + result.added;
    if (stats.alreadyApplied) {
      deps.logger.info(`applications: ${result.matched} job(s) you already applied to, ${result.added} more added from your confirmation emails`);
    }
  } catch (err) {
    deps.logger.warn(`could not read application confirmation emails: ${(err as Error).message}`);
  }
}

/**
 * Step 1c: listings of jobs you've already applied to (by the Submitter, or yourself, from confirmation
 * emails), are applying to, or dismissed leave Scout before filtering and scoring, so they cost nothing
 * and never reach your shortlist. Also clears ones already on it when you applied somewhere else.
 */
function removeAppliedListings(deps: RunDeps, stats: RunStats, iso: () => string) {
  const result = deps.store.db.transaction(() => sweepAppliedListings(deps.store, iso()))();
  const removed = result.applied + result.inProgress + result.dismissed;
  if (!removed) return;
  stats.appliedListings += removed;
  const parts = [
    result.applied && `${result.applied} you already applied to`,
    result.inProgress && `${result.inProgress} already being applied to`,
    result.dismissed && `${result.dismissed} you dismissed`,
  ].filter(Boolean);
  deps.logger.info(`Skipped ${removed} listing(s) of jobs ${parts.join(', ')}`);
}

/** Step 2: cheap deterministic work. Hard filters first, then dedupe the survivors. */
function evaluate(deps: RunDeps, stats: RunStats, clock: () => Date) {
  const { store, prefs } = deps;
  const discovered = store.listByStatus(['discovered']);
  const now = clock();
  const iso = now.toISOString();

  store.db.transaction(() => {
    for (const job of discovered) {
      stats.evaluated++;
      const filter = applyHardFilters(job, prefs, now);
      if (!filter.pass) {
        store.setStatus(job.id, 'filtered_out', filter.reason, 'scout', iso);
        stats.filteredOut++;
        stats.filterReasons[filter.code] = (stats.filterReasons[filter.code] ?? 0) + 1;
        continue;
      }

      const decision = decideDuplicate(job, store.dedupeCandidates(job.normCompany, job.id));
      if (decision.kind === 'duplicate') {
        store.setStatus(job.id, 'duplicate', `same job as #${decision.canonicalId}`, 'scout', iso, {
          duplicateOf: decision.canonicalId,
        });
        stats.duplicates++;
        continue;
      }
      if (decision.kind === 'replace') {
        store.setStatus(decision.demoteId, 'duplicate', `richer posting found: #${job.id}`, 'scout', iso, {
          duplicateOf: job.id,
        });
        stats.duplicates++;
      }
      store.setStatus(job.id, 'queued', null, 'scout', iso);
      stats.queued++;
    }
  })();
}

/** Step 3: LLM scoring for survivors only, capped per run to keep cost predictable. */
/** Summary-only postings (alert emails) get their own, lower cutoff: their scores are conservative by design. */
export function cutoff(job: Pick<JobRow, 'descriptionIsPartial'>, prefs: Preferences): number {
  const { threshold, partialThreshold } = prefs.scoring;
  return job.descriptionIsPartial ? (partialThreshold ?? threshold) : threshold;
}

/** Where a scored job goes. One you added yourself stays on your shortlist: you chose it, the score only informs. */
export function placeByScore(job: Pick<JobRow, 'descriptionIsPartial' | 'source'>, score: number, prefs: Preferences): 'shortlisted' | 'low_score' {
  return job.source === 'manual' || score >= cutoff(job, prefs) ? 'shortlisted' : 'low_score';
}

/**
 * Re-sorts already-scored jobs against the current cutoffs, so editing a threshold takes effect on the
 * next run without paying to score anything again. Only touches jobs still in Scout's hands.
 */
function applyThresholds(deps: RunDeps, iso: () => string) {
  const { up, down } = resortByCutoff(deps.store, deps.prefs, iso());
  if (up || down) deps.logger.info(`Thresholds: ${up} job(s) moved onto your shortlist, ${down} off it`);
}

/** Moves scored jobs onto or off your shortlist by the current cutoffs. Also run when you change them in Settings. */
export function resortByCutoff(store: JobStore, prefs: Preferences, now: string): { up: number; down: number } {
  let up = 0;
  let down = 0;
  store.db.transaction(() => {
    for (const job of store.listByStatus(['shortlisted', 'low_score'])) {
      if (job.score === null) continue;
      const should = placeByScore(job, job.score, prefs);
      if (should === job.status) continue;
      const kind = job.descriptionIsPartial ? 'partial posting, ' : '';
      store.setStatus(job.id, should, `${kind}score ${job.score}, cutoff ${cutoff(job, prefs)}`, 'scout', now);
      if (should === 'shortlisted') up++;
      else down++;
    }
  })();
  return { up, down };
}

/**
 * Shortlisted alert-email jobs were scored on a title alone. Look each one up once; when the full
 * posting turns up, it replaces the summary and the job is scored again against the full-posting cutoff.
 */
async function enrichShortlist(deps: RunDeps, enricher: Enricher, scorer: Scorer, stats: RunStats, iso: () => string, clock: () => Date) {
  const { store, prefs, logger } = deps;
  if (!prefs.enrich.enabled || prefs.enrich.maxPerRun === 0) return;
  const jobs = store
    .listByStatus(['shortlisted'])
    .filter((j) => j.descriptionIsPartial && !j.enrichedAt)
    .slice(0, prefs.enrich.maxPerRun);
  for (const job of jobs) {
    try {
      const { posting, applyUrl, closed, reason, usage } = await enricher.find(job);
      stats.enrich.tried++;
      stats.enrich.cost += enrichCost(usage);
      if (closed) {
        store.saveEnrichment(job.id, null, iso());
        store.markClosed(job.id, reason, iso());
        stats.closedPostings++;
        logger.info(`#${job.id} ${job.company} — ${job.title}: ${reason}`);
        continue;
      }
      store.saveEnrichment(
        job.id,
        posting && { description: posting.description, postingUrl: posting.url, applyUrl, location: posting.location, workplaceType: posting.workplaceType, postedAt: posting.postedAt },
        iso(),
      );
      if (!posting && applyUrl) store.setApplyUrl(job.id, applyUrl, iso());
      if (!posting) {
        logger.info(`#${job.id} ${job.company} — ${job.title}: full posting not found (${reason})`);
        continue;
      }
      stats.enrich.found++;
      const full = store.get(job.id)!;
      // The full posting can show what the alert couldn't: its real date, "fluent German required".
      const filter = applyHardFilters(full, prefs, clock());
      if (!filter.pass) {
        store.setStatus(job.id, 'filtered_out', filter.reason, 'scout', iso());
        logger.info(`#${job.id} ${job.company} — ${job.title}: full posting found, but ${filter.reason}`);
        continue;
      }
      const result = await scorer.score(full);
      const status = placeByScore(full, result.score, prefs);
      store.saveScore(job.id, result, status, iso(), scorer.model ?? null);
      logger.info(`#${job.id} ${job.company} — ${job.title}: full posting found, score ${job.score} → ${result.score}${status === 'low_score' ? ' (off your shortlist)' : ''}`);
    } catch (err) {
      // Left without enriched_at, so it's tried again next run.
      logger.warn(`#${job.id}: looking up the full posting failed: ${(err as Error).message}`);
    }
  }
}

async function score(deps: RunDeps, scorer: Scorer, stats: RunStats, iso: () => string, clock: () => Date) {
  const { store, prefs, logger } = deps;
  const { maxJobsPerRun, concurrency, maxAttempts } = prefs.scoring;
  const batcher = scorer.batch;
  if (deps.batch && !batcher) logger.info('Batch scoring is for Claude only: this scorer scores now');

  const save = (job: JobRow, result: ScoreResult, model: string | null) => {
    const status = placeByScore(job, result.score, prefs);
    store.saveScore(job.id, result, status, iso(), model);
    stats.scored++;
    if (status === 'shortlisted') stats.shortlisted++;
    else stats.lowScore++;
    logger.debug(`#${job.id} ${result.score} ${job.company} — ${job.title}`);
  };
  const fail = (job: JobRow, error: string) => {
    store.recordScoreError(job.id, error, iso());
    stats.scoreErrors++;
    logger.warn(`Scoring #${job.id} failed: ${error}`);
  };
  const scoreNow = (jobs: JobRow[]) =>
    mapWithConcurrency(jobs, concurrency, async (job) => {
      try {
        save(job, await scorer.score(job), scorer.model ?? null);
      } catch (err) {
        fail(job, (err as Error).message);
      }
    });
  /** Saves what a batch returned; jobs whose request never ran are handed back to be scored now. */
  const take = (got: Collected): JobRow[] => {
    for (const s of got.scored) save(s.job, s.result, s.model);
    for (const f of got.failed) fail(f.job, f.error);
    stats.batch.collected += got.scored.length + got.failed.length;
    if (got.retry.length) logger.warn(`${got.retry.length} job(s) came back from a scoring batch without a score: scoring them now`);
    return got.retry;
  };

  // Scores from batches sent by earlier runs come first, whatever kind of run this is.
  const again: JobRow[] = [];
  if (batcher && pendingBatches(store).length) {
    const got = await collectBatches(store, batcher, logger, clock());
    if (got.scored.length) logger.info(`${got.scored.length} score(s) arrived from an earlier batch`);
    again.push(...take(got));
  }

  // Jobs in a batch that's still being processed aren't scored twice.
  const inBatch = jobsInBatches(store);
  const queue = store
    .listScoringQueue(maxAttempts, maxJobsPerRun + inBatch.size + again.length)
    .filter((j) => !inBatch.has(j.id) && !again.some((a) => a.id === j.id))
    .slice(0, maxJobsPerRun);

  if (deps.batch && batcher && queue.length) {
    let id: string | null = null;
    try {
      id = await batcher.submit(queue);
    } catch (err) {
      logger.warn(`Could not send the scoring batch (${(err as Error).message}): scoring now instead`);
    }
    if (id === null) await scoreNow(queue);
    else {
      rememberBatch(store, { id, jobIds: queue.map((j) => j.id), submittedAt: iso(), model: scorer.model ?? null });
      stats.batch.submitted = queue.length;
      const polls = pollCount(prefs);
      logger.info(`Sent ${queue.length} postings for batch scoring at half price${polls ? `; waiting up to ${prefs.scoring.batchWaitMinutes} minutes for the scores` : ''}`);
      const wait = deps.wait ?? sleep;
      for (let i = 0; i < polls; i++) {
        await wait(POLL_SECONDS * 1000);
        const got = await collectBatches(store, batcher, logger, clock(), id);
        if (got.stillPending) continue;
        again.push(...take(got));
        break;
      }
    }
  } else if (queue.length) {
    logger.info(`Scoring ${queue.length} postings (concurrency ${concurrency})`);
    await scoreNow(queue);
  }

  if (again.length) await scoreNow(again);
  stats.batch.pending = jobsInBatches(store).size;
  if (stats.batch.pending) logger.info(`${stats.batch.pending} posting(s) are still being scored in a batch: the next run collects their scores`);
}
