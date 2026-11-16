import type { JobStore } from '../db/store.ts';
import type { Preferences } from '../config.ts';
import type { JobRow } from '../types.ts';

/*
 * What you did with the jobs you were shown: the ones you picked or applied to, and the ones you
 * looked at and passed on. Scores are good at telling a clear fit from a clear miss, and weak in the
 * middle, where a posting is a title and a line and the difference between a yes and a no is your own
 * taste. Shown to the scorer as examples, your past decisions are the only place that taste is written
 * down.
 */

export interface PastDecision {
  jobId: number;
  decision: 'picked' | 'dismissed';
  /** When you decided. */
  at: string;
  job: JobRow;
  /** It was on your shortlist: you looked at it and chose, rather than clearing out low scores. */
  shortlisted: boolean;
}

/** One line of a past posting, as the scorer is shown it. */
export interface ExampleLine {
  title: string;
  company: string;
  location: string;
  workplaceType: string;
}

export interface DecisionExamples {
  picked: ExampleLine[];
  dismissed: ExampleLine[];
}

/** Fewer than this on either side says too little about taste to be worth showing. */
export const MIN_EXAMPLES = 3;

/**
 * Every job you decided on, oldest decision first. A job you picked and later turned down (rejected
 * at review, removed) is left out: it is evidence for both sides.
 */
export function pastDecisions(store: JobStore): PastDecision[] {
  const picked = new Map<number, string>();
  const dismissed = new Map<number, string>();
  const shortlisted = new Set<number>();
  for (const h of store.allHistory()) {
    if (h.to === 'shortlisted') shortlisted.add(h.jobId);
    if ((h.to === 'selected' || h.to === 'submitted') && !picked.has(h.jobId)) picked.set(h.jobId, h.at);
    if (h.to === 'dismissed') dismissed.set(h.jobId, h.at);
  }
  const out: PastDecision[] = [];
  const add = (jobId: number, decision: PastDecision['decision'], at: string) => {
    const job = store.get(jobId);
    if (job) out.push({ jobId, decision, at, job, shortlisted: shortlisted.has(jobId) });
  };
  for (const [jobId, at] of picked) if (!dismissed.has(jobId)) add(jobId, 'picked', at);
  for (const [jobId, at] of dismissed) if (!picked.has(jobId)) add(jobId, 'dismissed', at);
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.jobId - b.jobId);
}

const line = (job: JobRow): ExampleLine => ({ title: job.title, company: job.company, location: job.location, workplaceType: job.workplaceType });

/**
 * Your latest decisions as examples: up to `perSide` jobs you picked and as many you passed on, most
 * recent first, the same job listed twice counted once. A job you passed on counts only if it was on
 * your shortlist: clearing out the low scores says what the scorer already knew. `before` keeps to
 * decisions made earlier than that moment.
 */
export function decisionExamples(store: JobStore, perSide: number, opts: { before?: string } = {}): DecisionExamples {
  const out: DecisionExamples = { picked: [], dismissed: [] };
  const seen = new Set<string>();
  const all = pastDecisions(store).filter((d) => !opts.before || d.at < opts.before);
  for (const d of all.reverse()) {
    if (d.decision === 'dismissed' && !d.shortlisted) continue;
    const side = out[d.decision];
    const key = `${d.job.normCompany}|${d.job.normTitle}`;
    if (side.length >= perSide || seen.has(key)) continue;
    seen.add(key);
    side.push(line(d.job));
  }
  return out;
}

/** The examples Scout scores with, from scoring.decisionExamples: null when it is off, or there are too few to show anything. */
export function examplesFor(store: JobStore, prefs: Preferences): DecisionExamples | null {
  const perSide = prefs.scoring.decisionExamples;
  if (!perSide) return null;
  const examples = decisionExamples(store, perSide);
  return examples.picked.length >= MIN_EXAMPLES && examples.dismissed.length >= MIN_EXAMPLES ? examples : null;
}
