import { createHash } from 'node:crypto';
import type { JobStore } from '../db/store.ts';
import type { AppliedEmail } from '../sources/applications.ts';
import { markSubmitted } from '../submit/run.ts';
import type { JobRow, JobStatus } from '../types.ts';
import { normalizeCompany, normalizeForMatch, normalizeTitle } from '../util/text.ts';
import { isSameTitle } from './dedupe.ts';

export interface AppliedStats {
  /** Jobs already in the database that you turned out to have applied to. */
  matched: number;
  /** Applications for jobs Scout hadn't seen, added so later postings of them are caught as duplicates. */
  added: number;
}

/** You applied: Scout must never show you this job again, from any source. */
export const APPLIED_STATUSES: readonly JobStatus[] = ['submitted'];
/** On its way to being sent: another listing of it would mean applying twice. */
export const IN_PROGRESS_STATUSES: readonly JobStatus[] = ['selected', 'tailored', 'tailor_error', 'approved', 'needs_manual'];
/** You said no to this job: another listing of it is no more welcome. */
export const DISMISSED_STATUSES: readonly JobStatus[] = ['dismissed'];
/** Listings still in Scout's hands, which the sweep below may take off. */
const SWEPT_STATUSES: readonly JobStatus[] = ['discovered', 'queued', 'score_error', 'low_score', 'shortlisted'];

const UNKNOWN_COMPANY = normalizeCompany('Unknown company');

type Listing = Pick<JobRow, 'source' | 'externalId' | 'normCompany' | 'normTitle' | 'location' | 'url' | 'postingUrl'>;

/** Where a listing came from: the board, or for alert emails the feed ("linkedin", "drushim", "applied"...). */
export const origin = (job: Pick<Listing, 'source' | 'externalId'>) => (job.source === 'email' ? job.externalId.split(':')[0]! : job.source);

/** A job page's address without tracking parameters, or null for a home page or anything unparseable. */
export function normalizeJobUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_\w+|ref|refid|source|src|trackingid|from|gh_src|lever-source)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${url.hostname.replace(/^www\./i, '')}${path}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Same job page? A listing's own address (url) is always one job's page. A looked-up one (postingUrl)
 * might be a general careers page, so two looked-up addresses alone never make a match.
 */
function samePage(a: Pick<Listing, 'url' | 'postingUrl'>, b: Pick<Listing, 'url' | 'postingUrl'>): boolean {
  const [aUrl, aPosting, bUrl, bPosting] = [a.url, a.postingUrl, b.url, b.postingUrl].map(normalizeJobUrl);
  return (aUrl !== null && (aUrl === bUrl || aUrl === bPosting)) || (aPosting !== null && aPosting === bUrl);
}

/**
 * Is `job` a listing of the job you applied to? Looser than dedupe on purpose: the same job page,
 * or the same company and title, unless both come from one board (or one alert feed) with different
 * locations, which is a separate opening. Confirmation emails carry no location, so that never blocks.
 */
export function isListingOfApplied(applied: Listing, job: Listing): boolean {
  if (samePage(applied, job)) return true;
  if (!applied.normCompany || applied.normCompany === UNKNOWN_COMPANY || applied.normCompany !== job.normCompany) return false;
  if (!isSameTitle(applied.normTitle, job.normTitle)) return false;
  if (!applied.location.trim() || !job.location.trim() || origin(applied) !== origin(job)) return true;
  return normalizeForMatch(applied.location) === normalizeForMatch(job.location);
}

const appliedRecord = (normCompany: string, normTitle: string): Listing => ({
  source: 'email', externalId: 'applied:', normCompany, normTitle, location: '', url: '', postingUrl: null,
});
const sameTitle = (normTitle: string, job: JobRow) => isListingOfApplied(appliedRecord(job.normCompany, normTitle), job);

/** A duplicate's canonical job is the one on your shortlist, so that's the one to mark. */
function canonical(store: JobStore, job: JobRow): JobRow {
  return job.duplicateOf ? (store.get(job.duplicateOf) ?? job) : job;
}

function note(app: AppliedEmail): string {
  const via = { linkedin: 'on LinkedIn', indeed: 'on Indeed', company: 'on the company site', email: 'per your email', drushim: 'on Drushim', jobmaster: 'on JobMaster' }[app.via];
  return `you applied ${via} on ${app.appliedAt.slice(0, 10)}${app.rejected ? '; they declined' : ''}`;
}

/**
 * Marks jobs you applied to yourself as submitted. LinkedIn emails carry the job ID and match alert
 * jobs exactly; others match on company and a near-identical title, the same rule as dedupe.
 * Safe to run every time: applications already recorded are skipped.
 */
export function recordApplications(store: JobStore, apps: AppliedEmail[], now: string, opts: { repliesToo?: boolean } = {}): AppliedStats {
  const stats: AppliedStats = { matched: 0, added: 0 };
  // Titled ones first, so "Thanks for applying to Acme" (no title) can see Acme is already covered.
  const ordered = [...apps].sort((a, b) => Number(!a.title) - Number(!b.title) || a.appliedAt.localeCompare(b.appliedAt));

  for (const app of ordered) {
    const normCompany = app.company ? normalizeCompany(app.company) : '';
    const normTitle = app.title ? normalizeTitle(app.title) : '';
    const atCompany = normCompany ? store.dedupeCandidates(normCompany, -1) : [];

    let job = app.linkedinId ? store.findByExternalId('email', `linkedin:${app.linkedinId}`) : undefined;
    if (!job && normTitle && normCompany) job = atCompany.find((c) => sameTitle(normTitle, c));
    // Indeed's emails have no company: accept a title match only when it's unambiguous.
    if (!job && normTitle && !normCompany) {
      const hits = store.findByNormTitle(normTitle);
      if (hits.length === 1) job = hits[0];
    }

    if (job) {
      const target = canonical(store, job);
      if (target.status !== 'submitted') {
        markSubmitted(store, target.id, note(app), new Date(app.appliedAt));
        stats.matched++;
      }
      continue;
    }

    // A rejection with no matching job is a reply to an application recorded some other way (or
    // under another name), not a new one. The Archiver files it, and records it when nothing else has.
    if (app.rejected && !opts.repliesToo) continue;

    // The same application often sends two emails (LinkedIn's and the company's). Record it once.
    const submitted = atCompany.filter((c) => c.status === 'submitted');
    if (normTitle ? submitted.some((c) => sameTitle(normTitle, c)) : submitted.length > 0) continue;
    if (!normCompany && store.findByNormTitle(normTitle).some((c) => c.status === 'submitted')) continue;

    const key = createHash('sha256').update(`${normCompany}\u0000${normTitle}`).digest('hex').slice(0, 16);
    const { id } = store.upsert(
      {
        source: 'email',
        externalId: app.linkedinId ? `linkedin:${app.linkedinId}` : `applied:${key}`,
        company: app.company || 'Unknown company',
        title: app.title || '(title not in the email)',
        location: '',
        workplaceType: 'unknown',
        url: app.linkedinId ? `https://www.linkedin.com/jobs/view/${app.linkedinId}/` : '',
        description: app.subject,
        descriptionIsPartial: true,
        postedAt: app.appliedAt,
      },
      now,
    );
    markSubmitted(store, id, note(app), new Date(app.appliedAt));
    stats.added++;
  }
  return stats;
}

export interface SweepStats {
  /** Listings of jobs you applied to. */
  applied: number;
  /** Listings of jobs the Tailor or Submitter are already working on. */
  inProgress: number;
  /** Listings of jobs you dismissed. */
  dismissed: number;
}

/**
 * Takes every listing of a job you've applied to, are applying to, or dismissed out of Scout's hands,
 * before it's filtered or scored: a re-post, the same job from another board or alert feed, or a row you
 * had on your shortlist when you applied elsewhere. Each becomes a duplicate of the applied job, so it stays out of
 * every list and is never scored or picked again. Safe to run any number of times.
 */
export function sweepAppliedListings(store: JobStore, now: string): SweepStats {
  const stats: SweepStats = { applied: 0, inProgress: 0, dismissed: 0 };
  // In this order, so a listing matching several is filed under the job you actually sent.
  const taken = [APPLIED_STATUSES, IN_PROGRESS_STATUSES, DISMISSED_STATUSES].flatMap((statuses) => store.listByStatus(statuses, { includeClosed: true }));
  if (taken.length === 0) return stats;

  const byCompany = new Map<string, JobRow[]>();
  const byPage = new Map<string, JobRow[]>();
  const titleOnly: JobRow[] = [];
  for (const job of taken) {
    if (job.normCompany === UNKNOWN_COMPANY) titleOnly.push(job);
    else byCompany.set(job.normCompany, [...(byCompany.get(job.normCompany) ?? []), job]);
    for (const url of new Set([job.url, job.postingUrl].map(normalizeJobUrl))) {
      if (url) byPage.set(url, [...(byPage.get(url) ?? []), job]);
    }
  }

  const listings = store.listByStatus(SWEPT_STATUSES);
  for (const job of listings) {
    const pages = [job.url, job.postingUrl].map(normalizeJobUrl).flatMap((u) => (u ? (byPage.get(u) ?? []) : []));
    let match = pages.find((a) => samePage(a, job));
    match ??= byCompany.get(job.normCompany)?.find((a) => isListingOfApplied(a, job));
    // Indeed's confirmations name the job but not the company: accept the one Indeed listing with that title.
    if (!match && origin(job) === 'indeed') {
      match = titleOnly.find(
        (a) => isSameTitle(a.normTitle, job.normTitle) && listings.filter((l) => origin(l) === 'indeed' && isSameTitle(a.normTitle, l.normTitle)).length === 1,
      );
    }
    if (!match) continue;

    const kind = APPLIED_STATUSES.includes(match.status) ? 'applied' : DISMISSED_STATUSES.includes(match.status) ? 'dismissed' : 'inProgress';
    const reason = {
      applied: `you already applied to this job (#${match.id}${match.statusReason ? `: ${match.statusReason}` : ''})`,
      inProgress: `already being applied to as #${match.id} (${match.status.replace('_', ' ')})`,
      dismissed: `you dismissed this job (#${match.id}${match.statusReason ? `: ${match.statusReason}` : ''})`,
    }[kind];
    store.setStatus(job.id, 'duplicate', reason, 'scout', now, { duplicateOf: match.id });
    stats[kind]++;
  }
  return stats;
}
