import type { JobStore } from '../db/store.ts';
import type { JobRow } from '../types.ts';
import { detectPlatform, resolveApplyUrl } from './answers.ts';

/*
 * Sites the Submitter never acts on: LinkedIn and Indeed forbid automated applications, Workday and
 * its kind want an account per company, a job board wants you to apply on the board. A job whose
 * application lives on one of these has nothing for the Submitter to try, so it is handed to you as
 * soon as you approve it, without an attempt being made or recorded.
 */

export interface ManualOnly {
  /** "LinkedIn", "Workday"... */
  site: string;
  /** Why the Submitter doesn't apply there. */
  why: string;
  /** Where you apply. */
  applyUrl: string;
}

/** Whether this job's application is on a site the Submitter never acts on. Null when it can try. */
export function manualOnly(job: Pick<JobRow, 'url' | 'applyUrl' | 'source'>): ManualOnly | null {
  const applyUrl = resolveApplyUrl(job);
  const platform = detectPlatform(applyUrl);
  return platform.manualOnly ? { site: platform.name, why: platform.manualOnly, applyUrl } : null;
}

/** The reason kept with a job that waits for you to apply. */
export const manualOnlyReason = (m: ManualOnly, jobId: number) => `${m.site}: ${m.why}. Apply at ${m.applyUrl}, then click "I applied myself" (or run "mark-submitted ${jobId}")`;

/**
 * Hands an approved job on such a site to you: it moves to "needs you" with the reason, and no
 * attempt is recorded. Returns what it found, or null when the Submitter can try this job.
 */
export function parkManualOnly(store: JobStore, job: JobRow, now = new Date().toISOString()): ManualOnly | null {
  const manual = manualOnly(job);
  if (manual && job.status === 'approved') store.setStatus(job.id, 'needs_manual', manualOnlyReason(manual, job.id), 'submitter', now);
  return manual;
}
