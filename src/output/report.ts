import type { RunStats } from '../pipeline/run.ts';
import type { JobRow } from '../types.ts';

const date = (iso?: string | null) => (iso ? iso.slice(0, 10) : '—');

function flags(job: JobRow): string {
  const parts = [job.location || 'location n/a', job.workplaceType !== 'unknown' ? job.workplaceType : '', job.source];
  if (job.postedAt) parts.push(`posted ${date(job.postedAt)}`);
  if (job.descriptionIsPartial) parts.push('PARTIAL INFO');
  return parts.filter(Boolean).join(' · ');
}

export function formatJobList(jobs: JobRow[], opts: { details?: boolean } = {}): string {
  if (jobs.length === 0) return 'No jobs to show.';
  return jobs
    .map((job) => {
      const s = job.scoreDetails;
      const head = `#${job.id}  [${job.score ?? '--'}${s ? ' ' + s.verdict : ''}]  ${job.company} — ${job.title}`;
      const lines = [head, `      ${flags(job)}`];
      if (s && opts.details !== false) {
        if (s.summary) lines.push(`      ${s.summary}`);
        for (const r of s.matchReasons) lines.push(`      + ${r}`);
        for (const g of s.gaps) lines.push(`      - ${g}`);
        for (const d of s.dealbreakers) lines.push(`      ! ${d}`);
      }
      if (!s && job.statusReason) lines.push(`      (${job.status}: ${job.statusReason})`);
      lines.push(`      ${job.url}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export function formatJobDetail(job: JobRow, history: Array<{ to_status: string; reason: string | null; actor: string; at: string }>): string {
  const s = job.scoreDetails;
  return [
    `#${job.id}  ${job.company} — ${job.title}`,
    `Status: ${job.status}${job.statusReason ? ` (${job.statusReason})` : ''}${job.closedAt ? `  CLOSED ${date(job.closedAt)}` : ''}`,
    flags(job),
    job.url,
    '',
    s
      ? [
          `Score ${s.score} (${s.verdict}, seniority ${s.seniorityFit})`,
          s.summary,
          ...s.matchReasons.map((r) => `+ ${r}`),
          ...s.gaps.map((g) => `- ${g}`),
          ...s.dealbreakers.map((d) => `! ${d}`),
        ].join('\n')
      : 'Not scored.',
    '',
    'History:',
    ...history.map((h) => `  ${h.at.slice(0, 16).replace('T', ' ')}  ${h.actor.padEnd(9)} → ${h.to_status}${h.reason ? `  (${h.reason})` : ''}`),
    '',
    'Description:',
    job.description.slice(0, 3000) + (job.description.length > 3000 ? '\n[...]' : ''),
  ].join('\n');
}

export function formatMarkdown(jobs: JobRow[], generatedAt: Date): string {
  const lines = [`# Job shortlist — ${generatedAt.toISOString().slice(0, 10)}`, '', `${jobs.length} jobs, best first.`, ''];
  for (const job of jobs) {
    const s = job.scoreDetails;
    lines.push(`## ${job.score ?? '--'} · ${job.company} — ${job.title} (#${job.id})`);
    lines.push('', `${flags(job)}  `, `[Open posting](${job.url})`, '');
    if (s) {
      lines.push(s.summary, '');
      for (const r of s.matchReasons) lines.push(`- ✅ ${r}`);
      for (const g of s.gaps) lines.push(`- ⚠️ ${g}`);
      for (const d of s.dealbreakers) lines.push(`- ⛔ ${d}`);
      lines.push('');
    }
  }
  lines.push('---', 'Pick jobs for the Tailor agent with `npm run scout -- pick <id> [id...]`.');
  return lines.join('\n') + '\n';
}

export function formatRunStats(stats: RunStats): string {
  const reasons = Object.entries(stats.filterReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const lines = [
    `Sources: ${stats.sources.ok} ok, ${stats.sources.failed} failed`,
    `Postings: ${stats.fetched} fetched, ${stats.inserted} new, ${stats.changed} changed, ${stats.closed} closed`,
    ...(stats.alreadyApplied ? [`Applied: ${stats.alreadyApplied} job(s) marked from your confirmation emails`] : []),
    `Evaluated: ${stats.evaluated} → ${stats.filteredOut} filtered out${reasons ? ` (${reasons})` : ''}, ${stats.duplicates} duplicates, ${stats.queued} queued`,
    `Scored: ${stats.scored} → ${stats.shortlisted} shortlisted, ${stats.lowScore} below threshold, ${stats.scoreErrors} errors`,
  ];
  if (stats.closedPostings) lines.push(`Closed: ${stats.closedPostings} posting(s) no longer accepting applications`);
  if (stats.oldAlerts) lines.push(`Old alerts: ${stats.oldAlerts} LinkedIn job(s) dropped, posted long ago (estimated from job IDs)`);
  if (stats.enrich?.tried) {
    lines.push(`Looked up: ${stats.enrich.tried} shortlisted alert job(s) on the web, ${stats.enrich.found} full posting(s) found (about $${stats.enrich.cost.toFixed(2)})`);
  }
  if (stats.scoringBacklog > 0) lines.push(`Backlog: ${stats.scoringBacklog} still waiting for a score (raise scoring.maxJobsPerRun or run again)`);
  for (const e of stats.sources.errors) lines.push(`  ✗ ${e.source}: ${e.error}`);
  return lines.join('\n');
}
