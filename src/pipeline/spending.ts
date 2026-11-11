import type { JobStore } from '../db/store.ts';
import { formatDollars, PURPOSE_LABELS, type UsagePurpose } from '../llm/cost.ts';
import { outcomeOf } from './outcomes.ts';

/*
 * What the job search costs in Claude calls: in total, over the last 30 days by what the calls were
 * for, and per application and per callback, counting everything (the scoring of jobs you never
 * applied to is part of what an application costs).
 */

export interface SpendingReport {
  /** When spending was first recorded; null if nothing has been recorded yet. */
  since: string | null;
  total: number;
  last30Days: number;
  /** The last 30 days, largest first. */
  byPurpose: Array<{ label: string; calls: number; cost: number }>;
  /** Applications sent since recording began, and how many of them got a callback. */
  applications: number;
  callbacks: number;
  perApplication: number | null;
  perCallback: number | null;
}

export function spendingReport(store: JobStore, now = new Date()): SpendingReport {
  const since = store.usageSince() ?? null;
  const sum = (rows: Array<{ cost: number }>) => rows.reduce((n, r) => n + r.cost, 0);
  const total = sum(store.usageByPurpose());
  const recent = store.usageByPurpose(new Date(now.getTime() - 30 * 86_400_000).toISOString());

  // Only applications sent since recording began: earlier ones cost something too, but it wasn't counted.
  const sent = since ? store.appliedJobs().filter((j) => j.appliedAt >= since) : [];
  const responses = store.responses();
  const callbacks = sent.filter((j) => {
    const outcome = outcomeOf(j, responses.filter((r) => r.jobId === j.id), now);
    return outcome === 'callback' || outcome === 'offer';
  }).length;

  return {
    since,
    total,
    last30Days: sum(recent),
    byPurpose: recent.map((r) => ({ label: PURPOSE_LABELS[r.purpose as UsagePurpose] ?? r.purpose, calls: r.calls, cost: r.cost })),
    applications: sent.length,
    callbacks,
    perApplication: sent.length ? total / sent.length : null,
    perCallback: callbacks ? total / callbacks : null,
  };
}

/** Plain text for the CLI. */
export function formatSpendingReport(r: SpendingReport): string {
  if (!r.since) return 'Spending: nothing recorded yet. Costs are recorded from the next run on.';
  const lines = [
    `Spending on Claude since ${r.since.slice(0, 10)}: about ${formatDollars(r.total)} (${formatDollars(r.last30Days)} in the last 30 days).`,
  ];
  for (const p of r.byPurpose) lines.push(`  ${formatDollars(p.cost).padStart(7)}  ${p.label} (${p.calls} call${p.calls === 1 ? '' : 's'})`);
  if (r.perApplication !== null) {
    lines.push(
      `About ${formatDollars(r.perApplication)} per application sent (${r.applications})` +
        (r.perCallback !== null ? `, ${formatDollars(r.perCallback)} per callback (${r.callbacks}).` : '.') +
        ' Everything is included: scoring jobs you skipped, too.',
    );
  }
  lines.push('Estimated from token counts at list prices; your Anthropic console has the exact bill.');
  return lines.join('\n');
}
