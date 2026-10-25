import { z } from 'zod';
import type { JobStore } from './db/store.ts';
import type { VerificationReport } from './tailor/schema.ts';
import type { JobStatus } from './types.ts';

// Your two decisions in the pipeline: which jobs to tailor, and which applications to send.
// Used by the LangGraph pipeline's pauses and by the review page, with the same rules as the CLIs.

export interface Skipped {
  id: number;
  reason: string;
}

const Ids = z.array(z.number().int().positive()).default([]);
// Studio's resume box sends the JSON you type as a string.
const parsed = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);
export const PickAnswerSchema = parsed(z.object({ pick: Ids, dismiss: Ids }));
export const ReviewAnswerSchema = parsed(
  z.object({
    approve: Ids,
    reject: Ids,
    force: z.boolean().default(false),
    /** Submitter mode for what you approve; overrides the one the pipeline run started with. */
    mode: z.enum(['prepare', 'assist', 'auto']).optional(),
  }),
);

// Same transitions as "npm run scout -- pick/dismiss".
const PICK_FROM: Record<'selected' | 'dismissed', JobStatus[]> = {
  selected: ['shortlisted', 'low_score', 'dismissed', 'queued', 'score_error'],
  dismissed: ['shortlisted', 'low_score', 'selected', 'queued', 'score_error'],
};

function move(store: JobStore, ids: number[], to: JobStatus, allowedFrom: JobStatus[], reason: string | null, skipped: Skipped[]): number[] {
  const now = new Date().toISOString();
  const moved: number[] = [];
  for (const id of ids) {
    const job = store.get(id);
    if (!job) skipped.push({ id, reason: 'not found' });
    else if (!allowedFrom.includes(job.status)) skipped.push({ id, reason: `is "${job.status}", can't move to "${to}"` });
    else {
      store.setStatus(id, to, reason, 'user', now);
      moved.push(id);
    }
  }
  return moved;
}

export function applyPicks(store: JobStore, answer: z.input<typeof PickAnswerSchema>): { picked: number[]; skipped: Skipped[] } {
  const { pick, dismiss } = PickAnswerSchema.parse(answer);
  const skipped: Skipped[] = [];
  const picked = move(store, pick, 'selected', PICK_FROM.selected, null, skipped);
  move(store, dismiss, 'dismissed', PICK_FROM.dismissed, null, skipped);
  return { picked, skipped };
}

// Same rules as "npm run tailor -- approve/reject": unverified claims need force.
export function applyReview(
  store: JobStore,
  answer: z.input<typeof ReviewAnswerSchema>,
): { approved: number[]; skipped: Skipped[]; mode?: 'prepare' | 'assist' | 'auto' } {
  const { approve, reject, force, mode } = ReviewAnswerSchema.parse(answer);
  const skipped: Skipped[] = [];
  const now = new Date().toISOString();
  const approved: number[] = [];
  for (const id of approve) {
    const job = store.get(id);
    if (!job || job.status !== 'tailored') {
      skipped.push({ id, reason: job ? `is "${job.status}"; only tailored jobs can be approved` : 'not found' });
      continue;
    }
    const open = unresolvedCount(store, id);
    if (open && !force) {
      skipped.push({ id, reason: `${open} unverified item(s); check "npm run tailor -- show ${id}", or resume with force: true` });
      continue;
    }
    store.setStatus(id, 'approved', open ? `approved with ${open} unverified item(s)` : null, 'user', now);
    approved.push(id);
  }
  move(store, reject, 'dismissed', ['tailored', 'selected', 'tailor_error', 'approved'], 'rejected at review', skipped);
  return { approved, skipped, ...(mode ? { mode } : {}) };
}

export function unresolvedCount(store: JobStore, jobId: number): number {
  const report = store.latestApplication(jobId)?.verification as VerificationReport | undefined;
  return report?.issues.filter((i) => i.severity === 'unresolved').length ?? 0;
}
