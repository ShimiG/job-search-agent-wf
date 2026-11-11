import type { AppliedJobRow, JobStore, ResponseRecord } from '../db/store.ts';
import type { ReplyEmail, ReplyKind } from '../sources/replies.ts';
import { containsKeyword, normalizeCompany, normalizeForMatch } from '../util/text.ts';
import { origin } from './applied.ts';
import { isSameTitle } from './dedupe.ts';

/*
 * Which applications got a callback. Replies are matched to the jobs you applied to, then counted by
 * source, score band and how you applied, so you can see what actually works: which boards, which
 * score cutoff, tailored or not.
 */

export interface ReplyStats {
  /** Replies recorded this run, by kind. */
  recorded: Partial<Record<ReplyKind, number>>;
  /** Replies that didn't clearly belong to one application, so weren't counted. */
  unmatched: number;
}

const UNKNOWN_COMPANY = normalizeCompany('Unknown company');
/** Senders whose domain says nothing about the hiring company. */
const PLATFORM_DOMAIN =
  /(^|\.)(gmail|googlemail|outlook|hotmail|yahoo|icloud|greenhouse|greenhouse-mail|lever|hire\.lever|ashbyhq|workable|workablemail|comeet|myworkday|workday|smartrecruiters|bamboohr|teamtailor|recruitee|jobvite|icims|linkedin|breezy|pinpointhq|personio|hibob|sendgrid|mailgun|mandrillapp)\.[a-z.]+$/i;

const compact = (s: string) => normalizeForMatch(s).replace(/\s+/g, '');

/** "careers@mail.wsc-sports.com" → "wscsports"; null for an ATS or webmail sender. */
function senderDomainName(address: string): string | null {
  const host = (address.split('@')[1] ?? '').toLowerCase();
  if (!host || PLATFORM_DOMAIN.test(host)) return null;
  const labels = host.split('.');
  // co.il, co.uk, com.au: the name is one label further left.
  const name = labels.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(labels.at(-2)!) ? labels.at(-3) : labels.at(-2);
  return name ? compact(name) : null;
}

/**
 * The application a reply is about, or undefined when it can't be told apart. Strongest evidence first:
 * the company LinkedIn names, then the sender's domain or name, then the subject, and last the start of
 * the body (an ATS sending for "Acme"), which only counts when exactly one company you applied to is in it.
 */
export function matchReply(reply: ReplyEmail, jobs: AppliedJobRow[]): AppliedJobRow | undefined {
  const sent = jobs.filter((j) => j.normCompany && j.normCompany !== UNKNOWN_COMPANY && Date.parse(j.appliedAt) <= Date.parse(reply.receivedAt) + 86_400_000);
  const named = (text: string) => sent.filter((j) => containsKeyword(text, j.company) || containsKeyword(text, j.normCompany));

  let candidates: AppliedJobRow[] = [];
  if (reply.company) {
    candidates = sent.filter((j) => j.normCompany === normalizeCompany(reply.company!));
  } else {
    const domain = senderDomainName(reply.fromAddress);
    const tiers = [
      () => (domain ? sent.filter((j) => compact(j.normCompany) === domain || (domain.length >= 4 && compact(j.normCompany).startsWith(domain))) : []),
      () => named(reply.fromName),
      () => named(reply.subject),
      () => named(reply.excerpt),
    ];
    for (const tier of tiers) {
      candidates = tier();
      if (candidates.length) break;
    }
  }
  if (new Set(candidates.map((j) => j.normCompany)).size !== 1) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Several applications to the same company: the one the email names, else the latest before it.
  const text = `${reply.title ?? ''}\n${reply.subject}\n${reply.excerpt}`;
  const byTitle = candidates.filter(
    (j) => (reply.title && isSameTitle(normalizeForMatch(reply.title), j.normTitle)) || containsKeyword(text, j.title),
  );
  const pool = byTitle.length ? byTitle : candidates;
  return [...pool].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))[0];
}

/** Stores each reply against its application, once. Safe to run every time over the same emails. */
export function recordReplies(store: JobStore, replies: ReplyEmail[], now: string): ReplyStats {
  const stats: ReplyStats = { recorded: {}, unmatched: 0 };
  const jobs = store.appliedJobs();
  for (const reply of [...replies].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const job = matchReply(reply, jobs);
    if (!job) {
      stats.unmatched++;
      continue;
    }
    const sender = reply.fromName ? `${reply.fromName} <${reply.fromAddress}>` : reply.fromAddress;
    const added = store.saveResponse({ jobId: job.id, kind: reply.kind, receivedAt: reply.receivedAt, sender, subject: reply.subject, messageKey: reply.messageKey, createdAt: now });
    if (added) stats.recorded[reply.kind] = (stats.recorded[reply.kind] ?? 0) + 1;
  }
  return stats;
}

// ------------------------------------------------------------------ the report

/** An application's furthest stage. An interview followed by a rejection still counts as a callback. */
export type Outcome = 'offer' | 'callback' | 'rejected' | 'waiting' | 'no_reply';

/** Applications this recent with no reply are "waiting", not "no reply": too early to count against a source. */
export const WAITING_DAYS = 14;

export interface OutcomeGroup {
  label: string;
  applied: number;
  /** Interviews, assignments and offers. */
  callbacks: number;
  offers: number;
  rejected: number;
  noReply: number;
  waiting: number;
  /** callbacks / (applied - waiting), or null when nothing is old enough to judge. */
  rate: number | null;
}

export interface OutcomeReport {
  total: OutcomeGroup;
  bySource: OutcomeGroup[];
  byScore: OutcomeGroup[];
  byMethod: OutcomeGroup[];
  recent: Array<{ jobId: number; company: string; title: string; kind: ResponseRecord['kind']; receivedAt: string; subject: string }>;
}

export function outcomeOf(job: Pick<AppliedJobRow, 'appliedAt'>, responses: ResponseRecord[], now: Date): Outcome {
  if (responses.some((r) => r.kind === 'offer')) return 'offer';
  if (responses.some((r) => r.kind === 'interview' || r.kind === 'assessment')) return 'callback';
  if (responses.some((r) => r.kind === 'rejection')) return 'rejected';
  return now.getTime() - Date.parse(job.appliedAt) < WAITING_DAYS * 86_400_000 ? 'waiting' : 'no_reply';
}

const SOURCE_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn alerts',
  indeed: 'Indeed alerts',
  drushim: 'Drushim alerts',
  alljobs: 'AllJobs alerts',
  applied: 'Not found by Scout',
  greenhouse: 'Greenhouse boards',
  lever: 'Lever boards',
  ashby: 'Ashby boards',
  workable: 'Workable boards',
  comeet: 'Comeet boards',
};

export function sourceLabel(job: Pick<AppliedJobRow, 'source' | 'externalId'>): string {
  const key = origin(job);
  return SOURCE_NAMES[key] ?? `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

export function scoreBand(score: number | null): string {
  if (score === null) return 'Not scored';
  if (score >= 85) return 'Strong (85+)';
  if (score >= 70) return 'Good (70–84)';
  if (score >= 50) return 'Stretch (50–69)';
  return 'Poor (under 50)';
}
const BAND_ORDER = ['Strong (85+)', 'Good (70–84)', 'Stretch (50–69)', 'Poor (under 50)', 'Not scored'];

export function methodLabel(job: Pick<AppliedJobRow, 'bySubmitter' | 'tailored'>): string {
  if (job.bySubmitter) return 'Sent by the Submitter';
  return job.tailored ? 'You, with the tailored CV' : 'You, on your own';
}

function group(label: string, outcomes: Outcome[]): OutcomeGroup {
  const count = (o: Outcome) => outcomes.filter((x) => x === o).length;
  const g = {
    label,
    applied: outcomes.length,
    callbacks: count('callback') + count('offer'),
    offers: count('offer'),
    rejected: count('rejected'),
    noReply: count('no_reply'),
    waiting: count('waiting'),
  };
  const judged = g.applied - g.waiting;
  return { ...g, rate: judged > 0 ? g.callbacks / judged : null };
}

function groupBy(rows: Array<{ key: string; outcome: Outcome }>, order?: string[]): OutcomeGroup[] {
  const keys = [...new Set(rows.map((r) => r.key))];
  const groups = keys.map((k) => group(k, rows.filter((r) => r.key === k).map((r) => r.outcome)));
  if (order) return groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  return groups.sort((a, b) => b.applied - a.applied || a.label.localeCompare(b.label));
}

export function outcomeReport(store: JobStore, now = new Date(), recentLimit = 20): OutcomeReport {
  const jobs = store.appliedJobs();
  const responses = store.responses();
  const byJob = new Map<number, ResponseRecord[]>();
  for (const r of responses) byJob.set(r.jobId, [...(byJob.get(r.jobId) ?? []), r]);
  const rows = jobs.map((j) => ({ job: j, outcome: outcomeOf(j, byJob.get(j.id) ?? [], now) }));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  return {
    total: group('All applications', rows.map((r) => r.outcome)),
    bySource: groupBy(rows.map((r) => ({ key: sourceLabel(r.job), outcome: r.outcome }))),
    byScore: groupBy(rows.map((r) => ({ key: scoreBand(r.job.score), outcome: r.outcome })), BAND_ORDER),
    byMethod: groupBy(rows.map((r) => ({ key: methodLabel(r.job), outcome: r.outcome }))),
    recent: responses
      .filter((r) => jobById.has(r.jobId))
      .slice(0, recentLimit)
      .map((r) => ({ jobId: r.jobId, company: jobById.get(r.jobId)!.company, title: jobById.get(r.jobId)!.title, kind: r.kind, receivedAt: r.receivedAt, subject: r.subject })),
  };
}

const pct = (rate: number | null) => (rate === null ? '–' : `${Math.round(rate * 100)}%`);

/** Plain-text tables for the CLI. */
export function formatOutcomeReport(report: OutcomeReport): string {
  if (report.total.applied === 0) return 'No applications recorded yet.';
  const table = (title: string, groups: OutcomeGroup[]) => {
    const width = Math.max(title.length, ...groups.map((g) => g.label.length));
    const head = `${title.padEnd(width)}  applied  callbacks  rate  rejected  no reply  waiting`;
    const lines = groups.map(
      (g) =>
        `${g.label.padEnd(width)}  ${String(g.applied).padStart(7)}  ${String(g.callbacks).padStart(9)}  ${pct(g.rate).padStart(4)}  ${String(g.rejected).padStart(8)}  ${String(g.noReply).padStart(8)}  ${String(g.waiting).padStart(7)}`,
    );
    return [head, ...lines].join('\n');
  };
  const t = report.total;
  const out = [
    `${t.applied} applications: ${t.callbacks} callback(s)${t.offers ? `, ${t.offers} offer(s)` : ''}, ${t.rejected} rejected, ${t.noReply} no reply, ${t.waiting} sent in the last ${WAITING_DAYS} days. Callback rate ${pct(t.rate)}.`,
    '',
    table('By source', report.bySource),
    '',
    table('By score', report.byScore),
    '',
    table('By how you applied', report.byMethod),
  ];
  if (report.recent.length) {
    out.push('', 'Latest replies:');
    for (const r of report.recent) out.push(`  ${r.receivedAt.slice(0, 10)}  ${r.kind.padEnd(10)}  #${r.jobId} ${r.company} — ${r.title}`);
  }
  out.push('', `Callback rate counts interviews, assignments and offers, out of applications older than ${WAITING_DAYS} days.`);
  return out.join('\n');
}
