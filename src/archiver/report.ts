import type { ArchiveChoice, ResponseRecord, SentApplication } from '../db/store.ts';
import { diceSimilarity, normalizeCompany, normalizeForMatch, normalizeTitle } from '../util/text.ts';

/*
 * Your applications and what came back: one row per application (the same job applied to through
 * LinkedIn and the company site counts once), its furthest stage, and the totals.
 */

export type Stage = 'awaiting' | 'viewed' | 'assessment' | 'interview' | 'offer' | 'rejected';

export interface ApplicationRow {
  /** Every job record of this application; the first is the one shown. */
  jobIds: number[];
  company: string;
  title: string;
  url: string;
  appliedAt: string;
  via: string[];
  stage: Stage;
  /** The furthest it got before a rejection, e.g. "interview" for a rejection after interviewing. */
  reached: Stage;
  lastReplyAt: string | null;
  replies: ResponseRecord[];
  /** Something you're asked to do, from the latest reply that asked. */
  action: string;
  /** The stage was set by you, not read from email. */
  manual: boolean;
  /** You sent it to the Archive, or kept it in Applied. null: the rules decide. */
  archiveChoice: ArchiveChoice | null;
}

export interface Stats {
  applied: number;
  awaiting: number;
  viewed: number;
  assessment: number;
  interview: number;
  offer: number;
  rejected: number;
  /** Awaiting a reply for `quietDays` or more. */
  quiet: number;
  quietDays: number;
  /** Share that got a human answer: a rejection, an assessment, an interview or an offer. */
  responseRate: number;
  /** Share that reached an interview or an offer, rejected afterwards or not. */
  interviewRate: number;
  avgDaysToReply: number | null;
  unmatched: number;
  /** Applications sent with this tool, and ones you sent yourself (recorded from your email, or marked by you). `applied` is both. */
  viaTool: number;
  manual: number;
}

const UNTITLED = '(title not in the email)';
const isUntitled = (title: string) => !title || title === UNTITLED;

/** One application per job: the LinkedIn and company-site records of the same job are merged. */
export const STAGES: readonly Stage[] = ['awaiting', 'viewed', 'assessment', 'interview', 'offer', 'rejected'];

type Group = Omit<ApplicationRow, 'stage' | 'reached' | 'lastReplyAt' | 'replies' | 'action' | 'manual'> & { outcome: SentApplication['outcome'] };

/** Emoji, "@ Company" and "at Company" tails that confirmation emails add to a role's name. */
export function cleanTitle(title: string, company = ''): string {
  if (isUntitled(title)) return '';
  let t = title.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s*@\s*.*$/, '');
  if (company) t = t.replace(new RegExp(`\\s+at\\s+${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '');
  t = t.replace(/\s+/g, ' ').replace(/^[\s\-–—:|,.]+|[\s\-–—:|,.]+$/g, '');
  // A phrase cut out of a sentence ("needs of this specific") rather than a role's name.
  return /^[a-z]/.test(t) && !/^[a-z][A-Z]/.test(t) ? '' : t;
}

const UNKNOWN_COMPANY = 'Unknown company';

/** A company name that's a sentence ("…your career at Noma Security") is cut to what follows "at". */
function cleanCompany(name: string): string {
  if (name === UNKNOWN_COMPANY) return '';
  const at = /\bat\s+([^.!,]+)$/i.exec(name);
  return (name.split(/\s+/).length >= 5 && at ? at[1]! : name).replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '').trim();
}

/**
 * The same company under different names: "Ocean" and "Ocean Security", "InfinityLabs R&D" and
 * "Infinity Labs R&D", "Cust2Mate" and "Cust2Mate - A2Z (NASDAQ: AZ)".
 */
export function sameCompany(a: string, b: string): boolean {
  const [x, y] = [normalizeCompany(a), normalizeCompany(b)];
  if (!x || !y) return false;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  const [short, long] = x.length <= y.length ? [x.split(' '), y.split(' ')] : [y.split(' '), x.split(' ')];
  return short.join('').length >= 3 && short.every((w, i) => long[i] === w);
}

const similarTitles = (a: string, b: string) => !a || !b || a === b || diceSimilarity(a, b) >= 0.8;

export function groupApplications(apps: SentApplication[]): Group[] {
  type G = { companies: string[]; title: string; rows: SentApplication[] };
  const groups: G[] = [];
  // Oldest first, titled before untitled, known companies before unknown ones, so an untitled "thanks
  // for applying to Acme" or Indeed's company-less email joins the application it belongs to.
  const info = apps.map((app) => {
    const company = cleanCompany(app.job.company);
    return { app, company, title: normalizeTitle(cleanTitle(app.job.title, company)) };
  });
  info.sort((a, b) => Number(!a.company) - Number(!b.company) || Number(!a.title) - Number(!b.title) || a.app.appliedAt.localeCompare(b.app.appliedAt));
  for (const { app, company, title } of info) {
    let same: G | undefined;
    if (company) same = groups.find((g) => g.companies.some((c) => sameCompany(c, company)) && similarTitles(g.title, title));
    else if (title) {
      const hits = groups.filter((g) => g.title && diceSimilarity(g.title, title) >= 0.9);
      if (hits.length === 1) same = hits[0];
    }
    if (same) {
      same.rows.push(app);
      if (company && !same.companies.includes(company)) same.companies.push(company);
      same.title ||= title;
    } else groups.push({ companies: company ? [company] : [], title, rows: [app] });
  }
  return groups.map((g) => {
    const titled = g.rows.filter((r) => cleanTitle(r.job.title, cleanCompany(r.job.company)));
    // The plainest version of the role's name: the shortest one, once cleaned.
    const shown = [...(titled.length ? titled : g.rows)].sort((a, b) => cleanTitle(a.job.title).length - cleanTitle(b.job.title).length)[0]!;
    const docsFirst = [shown, ...g.rows.filter((r) => r !== shown)];
    return {
      jobIds: docsFirst.map((r) => r.job.id),
      // The shortest name is usually the company's own ("Ocean", not "Ocean Security Ltd").
      company: [...g.companies].sort((a, b) => a.length - b.length)[0] ?? UNKNOWN_COMPANY,
      title: cleanTitle(shown.job.title, cleanCompany(shown.job.company)),
      url: shown.job.applyUrl ?? shown.job.postingUrl ?? shown.job.url,
      appliedAt: g.rows.map((r) => r.appliedAt).sort()[0]!,
      via: [...new Set(g.rows.map((r) => r.via))],
      outcome: g.rows.map((r) => r.outcome).filter((o) => o !== null).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null,
      archiveChoice: g.rows.find((r) => r.archiveChoice)?.archiveChoice ?? null,
    };
  });
}

/**
 * The application an email is about: same company (from the model, the sender or the subject),
 * then the closest title. Null if no application fits.
 */
export function matchApplication(
  r: Pick<ResponseRecord, 'company' | 'title' | 'fromName' | 'fromAddress' | 'subject' | 'receivedAt'>,
  rows: Array<Pick<ApplicationRow, 'jobIds' | 'company' | 'title' | 'appliedAt'>>,
): number | null {
  const words = (s: string) => ` ${normalizeForMatch(s)} `;
  const said = normalizeCompany(r.company);
  const context = words(`${r.fromName} ${r.fromAddress.split('@')[1]?.split('.')[0] ?? ''} ${r.subject}`);
  // A reply comes after the application; a day's slack for time zones and late records.
  const before = rows.filter((a) => a.appliedAt <= new Date(Date.parse(r.receivedAt) + 86_400_000).toISOString());
  const atCompany = before.filter((a) => {
    const norm = normalizeCompany(a.company);
    if (norm.length < 2) return false;
    if (said && (said === norm || (Math.min(said.length, norm.length) >= 4 && (said.includes(norm) || norm.includes(said))))) return true;
    return norm.length >= 3 && context.includes(` ${norm} `);
  });
  const title = normalizeTitle(r.title);
  const byTitle = (pool: typeof rows) =>
    title ? pool.map((a) => ({ a, sim: diceSimilarity(normalizeTitle(a.title), title) })).filter((x) => x.sim >= 0.5).sort((x, y) => y.sim - x.sim)[0]?.a : undefined;
  if (atCompany.length) {
    const best = byTitle(atCompany) ?? [...atCompany].sort((x, y) => y.appliedAt.localeCompare(x.appliedAt))[0]!;
    return best.jobIds[0]!;
  }
  // Indeed's confirmations carry no company: a title alone is enough only when one application has it.
  if (said) return null;
  const titled = before.filter((a) => title && diceSimilarity(normalizeTitle(a.title), title) >= 0.85);
  return titled.length === 1 ? titled[0]!.jobIds[0]! : null;
}

const ORDER: Stage[] = ['awaiting', 'viewed', 'assessment', 'interview', 'offer'];

function stageOf(replies: ResponseRecord[]): { stage: Stage; reached: Stage } {
  let reached: Stage = 'awaiting';
  let rejected = false;
  for (const r of replies) {
    const s = ({ viewed: 'viewed', assessment: 'assessment', interview: 'interview', offer: 'offer' } as Record<string, Stage>)[r.kind];
    if (s && ORDER.indexOf(s) > ORDER.indexOf(reached)) reached = s;
    if (r.kind === 'rejection') rejected = true;
    // A new step after a rejection (a different role, a change of mind) reopens it.
    else if (s && s !== 'viewed') rejected = false;
  }
  return { stage: rejected && reached !== 'offer' ? 'rejected' : reached, reached };
}

export const ARCHIVE_AFTER_DAYS = 30;

/**
 * Whether an application has left Applied for the Archive. Your choice (the buttons) wins; otherwise
 * it goes when you set its stage to Rejected yourself, or ARCHIVE_AFTER_DAYS after you applied,
 * whatever its stage. A rejection read from email alone doesn't move it.
 */
export function isArchived(row: Pick<ApplicationRow, 'stage' | 'manual' | 'appliedAt' | 'archiveChoice'>, now: Date): boolean {
  if (row.archiveChoice) return row.archiveChoice === 'archived';
  if (row.manual && row.stage === 'rejected') return true;
  return now.getTime() - Date.parse(row.appliedAt) >= ARCHIVE_AFTER_DAYS * 86_400_000;
}

export function buildReport(apps: SentApplication[], responses: ResponseRecord[], now: Date, quietDays = 14): { rows: ApplicationRow[]; stats: Stats; unmatched: ResponseRecord[] } {
  const groups = groupApplications(apps);
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.jobIds.forEach((id) => groupOf.set(id, i)));
  const replies: ResponseRecord[][] = groups.map(() => []);
  const unmatched: ResponseRecord[] = [];
  for (const r of responses) {
    const i = r.jobId === null ? undefined : groupOf.get(r.jobId);
    if (i === undefined) {
      // Confirmations of applications Scout hasn't recorded yet aren't worth listing.
      if (r.kind !== 'confirmation' && r.kind !== 'viewed') unmatched.push(r);
    } else replies[i]!.push(r);
  }
  const rows: ApplicationRow[] = groups.map(({ outcome, ...g }, i) => {
    const mine = replies[i]!;
    const answers = mine.filter((r) => r.kind !== 'confirmation');
    const lastReplyAt = answers.at(-1)?.receivedAt ?? null;
    let { stage, reached } = stageOf(mine);
    // A stage you set wins until a reply newer than it arrives.
    const manual = Boolean(outcome && STAGES.includes(outcome.stage as Stage) && (!lastReplyAt || outcome.at >= lastReplyAt));
    if (manual) {
      stage = outcome!.stage as Stage;
      if (ORDER.indexOf(stage) > ORDER.indexOf(reached)) reached = stage;
    }
    return {
      ...g,
      stage,
      reached,
      manual,
      replies: mine,
      lastReplyAt,
      action: [...mine].reverse().find((r) => r.action)?.action ?? '',
    };
  });
  const count = (s: Stage) => rows.filter((r) => r.stage === s).length;
  const answered = rows.filter(
    (r) => r.replies.some((x) => ['rejection', 'assessment', 'interview', 'offer'].includes(x.kind)) || ['rejected', 'assessment', 'interview', 'offer'].includes(r.stage),
  );
  // Only replies that came by email have a date to measure the wait by.
  const waits = answered.flatMap((r) => {
    const first = r.replies.find((x) => ['rejection', 'assessment', 'interview', 'offer'].includes(x.kind));
    return first ? [(Date.parse(first.receivedAt) - Date.parse(r.appliedAt)) / 86_400_000] : [];
  });
  const applied = rows.length;
  return {
    rows: rows.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)),
    unmatched,
    stats: {
      applied,
      awaiting: count('awaiting'),
      viewed: count('viewed'),
      assessment: count('assessment'),
      interview: count('interview'),
      offer: count('offer'),
      rejected: count('rejected'),
      quiet: rows.filter((r) => (r.stage === 'awaiting' || r.stage === 'viewed') && now.getTime() - Date.parse(r.appliedAt) >= quietDays * 86_400_000).length,
      quietDays,
      responseRate: applied ? answered.length / applied : 0,
      interviewRate: applied ? rows.filter((r) => r.reached === 'interview' || r.reached === 'offer').length / applied : 0,
      avgDaysToReply: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
      unmatched: unmatched.length,
      viaTool: rows.filter((r) => r.via.includes('this tool')).length,
      manual: rows.filter((r) => !r.via.includes('this tool')).length,
    },
  };
}

const STAGE_LABEL: Record<Stage, string> = {
  awaiting: 'Waiting',
  viewed: 'Viewed',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};

export function formatReport(report: ReturnType<typeof buildReport>, now: Date): string {
  const { stats: s, rows, unmatched } = report;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
  const cell = (t: string) => t.replace(/\|/g, '/');
  return [
    '# Applications',
    '',
    `Updated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC by the Archiver.`,
    '',
    '| Applied | Waiting | Viewed | Assessment | Interview | Offer | Rejected |',
    '|---|---|---|---|---|---|---|',
    `| ${s.applied} | ${s.awaiting} | ${s.viewed} | ${s.assessment} | ${s.interview} | ${s.offer} | ${s.rejected} |`,
    '',
    `- Sent with this tool: ${s.viaTool} · by you: ${s.manual} · ${s.applied} in all`,
    `- Response rate: ${pct(s.responseRate)} (a rejection, assessment, interview or offer)`,
    `- Reached an interview: ${pct(s.interviewRate)}`,
    `- Average wait for a reply: ${s.avgDaysToReply === null ? 'no replies yet' : `${s.avgDaysToReply.toFixed(1)} days`}`,
    `- No reply after ${s.quietDays}+ days: ${s.quiet}`,
    '',
    '| Company | Role | Applied | Via | Status | Last reply | Latest |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      const latest = [...r.replies].reverse().find((x) => x.kind !== 'confirmation');
      return `| ${cell(r.company)} | ${cell(r.title || '—')} | ${day(r.appliedAt)} | ${r.via.join(', ')} | ${STAGE_LABEL[r.stage]} | ${day(r.lastReplyAt)} | ${cell(latest?.summary ?? '')}${r.action ? ` **To do:** ${cell(r.action)}` : ''} |`;
    }),
    ...(unmatched.length
      ? ['', `## Replies not matched to an application (${unmatched.length})`, '', ...unmatched.map((r) => `- ${day(r.receivedAt)} ${r.kind}: ${r.company || r.fromName} — ${r.subject}`)]
      : []),
    '',
  ].join('\n');
}
