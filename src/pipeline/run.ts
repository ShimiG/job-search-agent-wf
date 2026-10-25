import type { Preferences } from '../config.ts';
import type { JobRow } from '../types.ts';
import type { JobStore } from '../db/store.ts';
import type { Scorer } from '../llm/scorer.ts';
import type { SourceAdapter } from '../sources/common.ts';
import type { Http } from '../sources/http.ts';
import type { Logger } from '../util/logger.ts';
import { mapWithConcurrency } from '../util/limiter.ts';
import { enrichCost, type Enricher } from '../llm/enrich.ts';
import type { AppliedEmail } from '../sources/applications.ts';
import { linkedinIdClock, linkedinJobId } from './age.ts';
import { checkPostingPage, type PageCheck } from './closed.ts';
import { recordApplications } from './applied.ts';
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
  clock?: () => Date;
}

export interface RunStats {
  sources: { ok: number; failed: number; errors: Array<{ source: string; error: string }> };
  fetched: number;
  inserted: number;
  changed: number;
  closed: number;
  /** Jobs marked as applied from your confirmation emails (matched + added). */
  alreadyApplied: number;
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
  /** Still waiting after this run hit maxJobsPerRun. */
  scoringBacklog: number;
  filterReasons: Record<string, number>;
}

function emptyStats(): RunStats {
  return {
    sources: { ok: 0, failed: 0, errors: [] },
    fetched: 0, inserted: 0, changed: 0, closed: 0, alreadyApplied: 0,
    evaluated: 0, filteredOut: 0, duplicates: 0, queued: 0,
    scored: 0, shortlisted: 0, lowScore: 0, scoreErrors: 0, scoringBacklog: 0,
    enrich: { tried: 0, found: 0, cost: 0 },
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

  await collect(deps, stats, iso);
  await markApplied(deps, stats, iso);
  evaluate(deps, stats, clock);
  dropOldAlertJobs(deps, stats, clock);
  if (deps.scorer) {
    await score(deps, deps.scorer, stats, iso);
  } else {
    logger.info('Scoring skipped (--no-score). Filtered jobs are waiting in the "queued" state.');
  }
  applyThresholds(deps, iso);
  if (deps.scorer && deps.enricher) await enrichShortlist(deps, deps.enricher, deps.scorer, stats, iso, clock);
  await dropClosedPostings(deps, stats, iso);
  stats.scoringBacklog = store.countScoringQueue(prefs.scoring.maxAttempts);

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
      if (adapter.snapshotPrefix) {
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
  const jobs = store.listByStatus(['shortlisted', 'low_score']).filter((j) => j.enrichedAt && (j.postingUrl || j.applyUrl));
  for (const job of jobs) {
    const page = job.applyUrl ?? job.postingUrl!;
    if ((await check(page)) !== 'closed') continue;
    store.markClosed(job.id, `no longer accepting applications (${page})`, iso());
    stats.closedPostings++;
    logger.info(`#${job.id} ${job.company} — ${job.title}: no longer accepting applications`);
  }
}

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

/**
 * Re-sorts already-scored jobs against the current cutoffs, so editing a threshold takes effect on the
 * next run without paying to score anything again. Only touches jobs still in Scout's hands.
 */
function applyThresholds(deps: RunDeps, iso: () => string) {
  const { store, prefs, logger } = deps;
  let up = 0;
  let down = 0;
  store.db.transaction(() => {
    for (const job of store.listByStatus(['shortlisted', 'low_score'])) {
      if (job.score === null) continue;
      const should = job.score >= cutoff(job, prefs) ? 'shortlisted' : 'low_score';
      if (should === job.status) continue;
      const kind = job.descriptionIsPartial ? 'partial posting, ' : '';
      store.setStatus(job.id, should, `${kind}score ${job.score}, cutoff ${cutoff(job, prefs)}`, 'scout', iso());
      if (should === 'shortlisted') up++;
      else down++;
    }
  })();
  if (up || down) logger.info(`Thresholds: ${up} job(s) moved onto your shortlist, ${down} off it`);
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
      const status = result.score >= cutoff(full, prefs) ? 'shortlisted' : 'low_score';
      store.saveScore(job.id, result, status, iso());
      logger.info(`#${job.id} ${job.company} — ${job.title}: full posting found, score ${job.score} → ${result.score}${status === 'low_score' ? ' (off your shortlist)' : ''}`);
    } catch (err) {
      // Left without enriched_at, so it's tried again next run.
      logger.warn(`#${job.id}: looking up the full posting failed: ${(err as Error).message}`);
    }
  }
}

async function score(deps: RunDeps, scorer: Scorer, stats: RunStats, iso: () => string) {
  const { store, prefs, logger } = deps;
  const { maxJobsPerRun, concurrency, maxAttempts } = prefs.scoring;
  const queue = store.listScoringQueue(maxAttempts, maxJobsPerRun);
  if (queue.length === 0) return;
  logger.info(`Scoring ${queue.length} postings (concurrency ${concurrency})`);

  await mapWithConcurrency(queue, concurrency, async (job) => {
    try {
      const result = await scorer.score(job);
      const status = result.score >= cutoff(job, prefs) ? 'shortlisted' : 'low_score';
      store.saveScore(job.id, result, status, iso());
      stats.scored++;
      if (status === 'shortlisted') stats.shortlisted++;
      else stats.lowScore++;
      logger.debug(`#${job.id} ${result.score} ${job.company} — ${job.title}`);
    } catch (err) {
      store.recordScoreError(job.id, (err as Error).message, iso());
      stats.scoreErrors++;
      logger.warn(`Scoring #${job.id} failed: ${(err as Error).message}`);
    }
  });
}
