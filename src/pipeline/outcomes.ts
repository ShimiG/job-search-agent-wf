import { buildReport, type ApplicationRow } from '../archiver/report.ts';
import type { JobStore } from '../db/store.ts';
import type { JobRow } from '../types.ts';
import { origin } from './applied.ts';

/*
 * Which applications got a callback, by source, score band and how you applied, so you can see what
 * actually works: which boards, which score cutoff, sent by the Submitter or by you. The applications
 * and the replies to them are the Archiver's (a local model reads your mail and files each reply);
 * this only counts them.
 */

/** An application's furthest stage. An interview followed by a rejection still counts as a callback. */
export type Outcome = 'offer' | 'callback' | 'rejected' | 'waiting' | 'no_reply';

/** Applications this recent with no reply are "waiting", not "no reply": too early to count against a source. */
export const WAITING_DAYS = 14;

export interface OutcomeGroup {
  label: string;
  applied: number;
  /** Assessments, interviews and offers. */
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
}

/** From the Archiver's stage for an application: how far it got, and where it stands. */
export function outcomeOf(row: Pick<ApplicationRow, 'stage' | 'reached' | 'appliedAt'>, now: Date): Outcome {
  if (row.reached === 'offer') return 'offer';
  if (row.reached === 'interview' || row.reached === 'assessment') return 'callback';
  if (row.stage === 'rejected') return 'rejected';
  return now.getTime() - Date.parse(row.appliedAt) < WAITING_DAYS * 86_400_000 ? 'waiting' : 'no_reply';
}

export interface ApplicationOutcome {
  row: ApplicationRow;
  /** Every job record of the application: the alert Scout found, the confirmation's record... */
  jobs: JobRow[];
  outcome: Outcome;
}

/** Each application the Archiver knows (one per job, however many records it has), with its outcome. */
export function applicationOutcomes(store: JobStore, now = new Date()): ApplicationOutcome[] {
  const { rows } = buildReport(store.sentApplications(), store.responses(), now, WAITING_DAYS);
  return rows.map((row) => ({
    row,
    jobs: row.jobIds.map((id) => store.get(id)).filter((j): j is JobRow => Boolean(j)),
    outcome: outcomeOf(row, now),
  }));
}

const SOURCE_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn alerts',
  indeed: 'Indeed alerts',
  drushim: 'Drushim alerts',
  alljobs: 'AllJobs alerts',
  jobmaster: 'JobMaster alerts',
  ziprecruiter: 'ZipRecruiter alerts',
  'greenhouse-alerts': 'Greenhouse alerts',
  applied: 'Not found by Scout',
  greenhouse: 'Greenhouse boards',
  lever: 'Lever boards',
  ashby: 'Ashby boards',
  workable: 'Workable boards',
  comeet: 'Comeet boards',
  manual: 'Jobs you added',
  workday: 'Workday boards',
  smartrecruiters: 'SmartRecruiters boards',
};

/** Where Scout found the job: the record that came from a board or an alert, when the application has one. */
export function sourceLabel(jobs: Array<Pick<JobRow, 'source' | 'externalId'>>): string {
  const key = jobs.map((j) => origin(j)).find((o) => o !== 'applied') ?? 'applied';
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

/** "this tool" is the Archiver's name for an application the Submitter sent. */
export function methodLabel(row: Pick<ApplicationRow, 'via'>, tailored: boolean): string {
  if (row.via.includes('this tool')) return 'Sent by the Submitter';
  return tailored ? 'You, with the tailored CV' : 'You, on your own';
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

export function outcomeReport(store: JobStore, now = new Date()): OutcomeReport {
  const apps = applicationOutcomes(store, now);
  const bestScore = (jobs: JobRow[]) => jobs.reduce<number | null>((best, j) => (j.score !== null && (best === null || j.score > best) ? j.score : best), null);
  return {
    total: group('All applications', apps.map((a) => a.outcome)),
    bySource: groupBy(apps.map((a) => ({ key: sourceLabel(a.jobs), outcome: a.outcome }))),
    byScore: groupBy(apps.map((a) => ({ key: scoreBand(bestScore(a.jobs)), outcome: a.outcome })), BAND_ORDER),
    byMethod: groupBy(apps.map((a) => ({ key: methodLabel(a.row, a.jobs.some((j) => store.latestApplication(j.id))), outcome: a.outcome }))),
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
  out.push('', `Callback rate counts assessments, interviews and offers, out of applications older than ${WAITING_DAYS} days. Replies are read by the Archiver (npm run archive).`);
  return out.join('\n');
}
