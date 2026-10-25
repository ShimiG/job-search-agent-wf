import { createHash } from 'node:crypto';
import type { JobStore } from '../db/store.ts';
import type { AppliedEmail } from '../sources/applications.ts';
import { markSubmitted } from '../submit/run.ts';
import type { JobRow } from '../types.ts';
import { normalizeCompany, normalizeTitle } from '../util/text.ts';
import { isSameJob } from './dedupe.ts';

export interface AppliedStats {
  /** Jobs already in the database that you turned out to have applied to. */
  matched: number;
  /** Applications for jobs Scout hadn't seen, added so later postings of them are caught as duplicates. */
  added: number;
}

const sameTitle = (a: string, b: JobRow) =>
  isSameJob({ id: -1, source: 'email', normTitle: a, location: '', descriptionIsPartial: true, firstSeenAt: '', status: 'submitted' }, b);

/** A duplicate's canonical job is the one on your shortlist, so that's the one to mark. */
function canonical(store: JobStore, job: JobRow): JobRow {
  return job.duplicateOf ? (store.get(job.duplicateOf) ?? job) : job;
}

function note(app: AppliedEmail): string {
  const via = { linkedin: 'on LinkedIn', indeed: 'on Indeed', company: 'on the company site' }[app.via];
  return `you applied ${via} on ${app.appliedAt.slice(0, 10)}${app.rejected ? '; they declined' : ''}`;
}

/**
 * Marks jobs you applied to yourself as submitted. LinkedIn emails carry the job ID and match alert
 * jobs exactly; others match on company and a near-identical title, the same rule as dedupe.
 * Safe to run every time: applications already recorded are skipped.
 */
export function recordApplications(store: JobStore, apps: AppliedEmail[], now: string): AppliedStats {
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
