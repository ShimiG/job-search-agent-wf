import type { JobStore, JobSummary } from '../db/store.ts';
import { isLocalModel, PURPOSE_LABELS, tokenCost, type UsageEntry, type UsagePurpose } from '../llm/cost.ts';
import { origin } from '../pipeline/applied.ts';
import { applicationOutcomes, outcomeReport, scoreBand, sourceLabel, type OutcomeReport } from '../pipeline/outcomes.ts';
import { spendingReport } from '../pipeline/spending.ts';
import type { PlannedAnswer } from '../submit/schema.ts';
import { pdfTextOk } from '../tailor/pdf-text.ts';
import type { TailoredContent, VerificationReport } from '../tailor/schema.ts';

/*
 * The numbers for a write-up of how the pipeline performs: how many jobs it found and where they went,
 * how its scores line up with what you chose, what the Tailor's checks caught, how the Submitter and
 * the Archiver did, what it all cost and how reliably it ran.
 *
 * Everything is counted from the database, nothing is estimated, and nothing here names a company, a
 * job or a person: only counts, rates, dollars and times, so the result can be published as it is.
 * A rate always comes with the counts behind it, because most of these samples are small.
 */

export interface Count {
  n: number;
  of: number;
  /** n / of, or null when there is nothing to divide by. */
  rate: number | null;
}
const count = (n: number, of: number): Count => ({ n, of, rate: of > 0 ? n / of : null });

export interface SourceRow {
  label: string;
  found: number;
  /** Not filtered out and not a duplicate. */
  passedFilters: number;
  scored: number;
  shortlisted: number;
  picked: number;
  applied: number;
  medianScore: number | null;
}

export interface ScoringMetrics {
  scored: number;
  byBand: Array<{ label: string; jobs: number }>;
  byScorer: Array<{ model: string; jobs: number }>;
  /** Jobs where the cheap model asked the stronger one, out of jobs scored by a model that could. */
  advisor: Count | null;
  /** Scored jobs you said yes to (picked or applied) and no to (dismissed). */
  decisions: {
    picked: number;
    dismissed: number;
    medianPicked: number | null;
    medianDismissed: number | null;
    /** The chance that a job you picked scored higher than one you dismissed: 0.5 is a coin flip, 1 is perfect. */
    auc: number | null;
    /**
     * The same, among shortlisted jobs only. The stricter number: a job below the cutoff was shown to you
     * as a poor fit, so dismissing it mostly repeats the score rather than testing it.
     */
    aucShortlisted: number | null;
    shortlisted: { picked: number; dismissed: number };
    /** What each cutoff would have put on your shortlist, of the jobs you decided on. */
    cutoffs: Array<{ cutoff: number; picked: Count; dismissed: Count }>;
    /** Of the shortlisted jobs you decided on, how many you picked. */
    shortlistPrecision: Count;
    /** Jobs you picked although they scored under the cutoff, out of all you picked. */
    pickedBelowCutoff: Count;
    /** Shortlisted jobs you haven't decided on. */
    undecided: number;
  };
}

export interface TailorMetrics {
  jobs: number;
  versions: number;
  /** Jobs tailored more than once. */
  redone: Count;
  /** Versions written after a note from you. */
  withNote: number;
  /** Versions you edited by hand afterwards (re-checked by rules only). */
  handEdited: number;
  /** Counted over every version the model wrote. */
  bullets: {
    total: number;
    /** Printed in your CV's exact words. */
    verbatim: number;
    reworded: number;
    /** Rewordings taken back because they added something your CV doesn't say. */
    revertedByRules: number;
    revertedByFactCheck: number;
  };
  /** Other things the rule checks removed: unknown highlights, skills that aren't yours... */
  otherRuleFixes: number;
  lettersRevised: Count;
  /** Versions with at least one claim neither check could settle, left for you to approve or not. */
  needingReview: Count;
  unresolvedClaims: number;
  /** Where the claims left for you were, and which check raised them. */
  unresolvedBy: Array<{ label: string; claims: number }>;
  keywords: { cvs: number; matched: Count; required: Count } | null;
  onePage: Count;
  trimmedToFit: Count;
  pdfText: Count | null;
  /** Versions with at least one bullet breaking a writing rule. */
  styleFlagged: Count | null;
  letterReuseFlagged: Count | null;
}

export interface SubmitterMetrics {
  attempts: number;
  jobs: number;
  byMode: Array<{ mode: string; attempts: number; submitted: number; prepared: number; needsYou: number; failed: number }>;
  byAts: Array<{ ats: string; attempts: number; submitted: number }>;
  /** Why an attempt ended without the application being sent. */
  stopped: Array<{ reason: string; attempts: number }>;
  /** From each job's latest attempt: who answered each form field. */
  fields: { total: number; bySource: Array<{ source: string; fields: number }>; modelShare: Count; rejectedByPage: Count } | null;
}

export interface ReplyMetrics {
  replies: number;
  byKind: Array<{ kind: string; replies: number }>;
  /** Read by fixed rules (standard confirmations) instead of the model. */
  byRules: Count;
  /** Emails the local model couldn't read after several tries, filed for you to open. */
  unread: number;
  matched: Count;
  /** Applications whose stage you set by hand. */
  setByHand: Count;
  medianDaysToFirstReply: number | null;
  medianDaysToRejection: number | null;
}

export interface CostMetrics {
  since: string | null;
  total: number;
  byPurpose: Array<{ label: string; calls: number; cost: number; inputTokens: number; outputTokens: number }>;
  byModel: Array<{ model: string; calls: number; cost: number }>;
  byWeek: Array<{ week: string; cost: number }>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Prompt tokens served from the cache, out of all prompt tokens. */
  cacheShare: Count;
  /** What the same calls would have cost with no caching and no batch discount. */
  listPriceUncached: number;
  savedByCaching: number;
  savedByBatch: number;
  perJobScored: number | null;
  perTailoredVersion: number | null;
  perFormFilled: number | null;
  perApplication: number | null;
  perCallback: number | null;
  /** Calls a local model handled: nothing spent, nothing sent out. */
  local: { calls: number; inputTokens: number; outputTokens: number; minutes: number };
}

export interface ReliabilityMetrics {
  /** Failed calls, of all calls. */
  calls: Count;
  claude: Count;
  local: Count;
  /** Why calls failed, grouped. */
  failures: Array<{ reason: string; calls: number }>;
  byPurpose: Array<{ label: string; calls: number; failed: number; p50Ms: number | null; p95Ms: number | null }>;
  runs: Array<{ agent: string; runs: number; unfinished: number; medianMinutes: number | null }>;
  sourceFetches: Count | null;
  scoreErrors: number;
}

export interface CaseStudy {
  generatedAt: string;
  /** The first job Scout recorded, and the first model call whose cost was recorded. */
  period: { jobsFrom: string | null; costsFrom: string | null; days: number };
  funnel: {
    found: number;
    addedByYou: number;
    filteredOut: number;
    duplicates: number;
    scored: number;
    shortlisted: number;
    picked: number;
    tailored: number;
    approved: number;
    sentByTool: number;
    applications: number;
    callbacks: number;
    offers: number;
  };
  sources: SourceRow[];
  filters: Array<{ reason: string; jobs: number }>;
  scoring: ScoringMetrics;
  tailor: TailorMetrics;
  submitter: SubmitterMetrics;
  replies: ReplyMetrics;
  outcomes: OutcomeReport;
  cost: CostMetrics;
  reliability: ReliabilityMetrics;
}

// ---------------------------------------------------------------- small maths

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The value below which `p` of the samples fall (nearest rank). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

/** The chance a positive outscores a negative, ties counting half (the area under the ROC curve). */
export function auc(positives: number[], negatives: number[]): number | null {
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

const FILTER_REASONS: Array<[RegExp, string]> = [
  [/^excluded company/, 'A company you excluded'],
  [/^title contains/, 'A word you excluded from titles'],
  [/^seniority/, 'Seniority'],
  [/^title matches none/, "Title has none of your keywords"],
  [/^employment type/, 'Employment type'],
  [/^posted /, 'Posted too long ago'],
  [/remote roles disabled|remote, but restricted|on-site role|no location given|location not allowed/, 'Location'],
  [/^posting language/, 'Posting language'],
  [/^requires /, "A language you don't have"],
];
export const filterReason = (reason: string | null) => FILTER_REASONS.find(([re]) => re.test(reason ?? ''))?.[1] ?? 'Other';

const ATS_HOSTS: Array<[RegExp, string]> = [
  [/greenhouse\.io$/, 'Greenhouse'],
  [/lever\.co$/, 'Lever'],
  [/ashbyhq\.com$/, 'Ashby'],
  [/workable\.com$/, 'Workable'],
  [/comeet\.(com|co)$/, 'Comeet'],
  [/myworkdayjobs\.com$/, 'Workday'],
  [/smartrecruiters\.com$/, 'SmartRecruiters'],
  [/linkedin\.com$/, 'LinkedIn'],
];
/** Which application system a form is on. A company's own site is "Other sites": its name stays out of the report. */
export function atsOf(url: string | null): string {
  try {
    const host = new URL(url ?? '').hostname;
    return ATS_HOSTS.find(([re]) => re.test(host))?.[1] ?? 'Other sites';
  } catch {
    return 'Other sites';
  }
}

const FAILURE_REASONS: Array<[RegExp, string]> = [
  [/took longer than|timed? ?out|ETIMEDOUT|aborted/i, 'Timed out'],
  [/isn't reachable|ECONNREFUSED|ECONNRESET|fetch failed|network|socket/i, "Couldn't reach the model"],
  [/other than JSON/i, 'The answer was not JSON'],
  [/ran out of room|max_tokens|cut off/i, 'The answer was cut off'],
  [/expected shape|^\[$|ZodError/i, "The answer didn't have the expected shape"],
  [/overloaded|rate.?limit|\b429\b|\b529\b/i, 'Overloaded or rate-limited'],
  [/HTTP 5\d\d|\b5\d\d\b|internal server/i, 'Server error'],
  [/declined|refus/i, 'The model declined'],
];
/** A failed call's reason as a group: the stored message can carry a request ID or a path, the group can't. */
export const failureReason = (error: string | null) => FAILURE_REASONS.find(([re]) => re.test(error ?? ''))?.[1] ?? 'Other';

const STOP_REASONS: Array<[RegExp, string]> = [
  [/asks you to sign in/, 'The site wanted a sign-in or an account'],
  [/no application form found/, 'No application form at the address'],
  [/doesn't mention/, "The page didn't mention the job"],
  [/already applied to/, 'Your per-company limit was reached'],
  [/no tailored documents|no CV PDF/, 'Documents were missing'],
  [/CAPTCHA appeared after/, 'A CAPTCHA appeared after Submit'],
  [/no confirmation seen/, 'No confirmation seen (window closed or timed out)'],
  [/error after clicking Submit/, 'An error after clicking Submit'],
  [/no submit button/, 'No submit button found'],
  [/Finish with: run --mode assist/, 'Auto mode stopped for you (a question, a CAPTCHA, a model-written answer)'],
  [/^[^:]{2,40}: .*Apply at /, "A site it doesn't automate (LinkedIn, Indeed...)"],
];
/** Why a Submitter attempt stopped, as a group: the stored reason names the job's address. */
export const stopReason = (reason: string | null) => STOP_REASONS.find(([re]) => re.test(reason ?? ''))?.[1] ?? 'Other';

const tally = <T>(items: T[], key: (x: T) => string): Array<[string, number]> => {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const CUTOFFS = [45, 50, 55, 60, 65, 70, 75];
const SCORE_BANDS = ['Strong (85+)', 'Good (70–84)', 'Stretch (50–69)', 'Poor (under 50)'];

// ---------------------------------------------------------------- the report

export function caseStudy(store: JobStore, now = new Date()): CaseStudy {
  const jobs = store.jobSummaries();
  const history = store.allHistory();
  const reached = (status: string, actor?: string) => new Set(history.filter((h) => h.to === status && (!actor || h.actor === actor)).map((h) => h.jobId));
  const everFiltered = reached('filtered_out');
  const everDuplicate = reached('duplicate');
  const everShortlisted = reached('shortlisted');
  const everPicked = reached('selected');
  const everDismissed = reached('dismissed');
  const everSubmitted = reached('submitted');
  const everTailored = reached('tailored');

  // What Scout found: not the records made from your own application emails, nor jobs you pasted in.
  const isFound = (j: JobSummary) => origin(j) !== 'applied' && j.source !== 'manual';
  // A job that was scored got past the rules then, even if a later change of rules filtered it out.
  const passed = (j: JobSummary) => j.score !== null || (!everFiltered.has(j.id) && !everDuplicate.has(j.id));
  const found = jobs.filter(isFound);
  const outcomes = outcomeReport(store, now);
  const spending = spendingReport(store, now);

  const sources: SourceRow[] = tally(found, (j) => sourceLabel([j])).map(([label]) => {
    const mine = found.filter((j) => sourceLabel([j]) === label);
    const scores = mine.filter((j) => j.score !== null).map((j) => j.score!);
    return {
      label,
      found: mine.length,
      passedFilters: mine.filter(passed).length,
      scored: scores.length,
      shortlisted: mine.filter((j) => everShortlisted.has(j.id)).length,
      picked: mine.filter((j) => everPicked.has(j.id)).length,
      applied: mine.filter((j) => everSubmitted.has(j.id)).length,
      medianScore: median(scores),
    };
  });

  // The reason a job was filtered out the last time it was.
  const lastFilter = new Map<number, string | null>();
  for (const h of history) if (h.to === 'filtered_out') lastFilter.set(h.jobId, h.reason);
  const filters = tally([...lastFilter.values()], filterReason).map(([reason, n]) => ({ reason, jobs: n }));

  const usage = store.usageRows();
  const firstSeen = jobs.length ? jobs.reduce((min, j) => (j.firstSeenAt < min ? j.firstSeenAt : min), jobs[0]!.firstSeenAt) : null;

  return {
    generatedAt: now.toISOString(),
    period: {
      jobsFrom: firstSeen,
      costsFrom: spending.since,
      days: firstSeen ? Math.max(1, Math.round((now.getTime() - Date.parse(firstSeen)) / 86_400_000)) : 0,
    },
    funnel: {
      found: found.length,
      addedByYou: jobs.filter((j) => j.source === 'manual').length,
      filteredOut: found.filter((j) => !passed(j) && everFiltered.has(j.id)).length,
      duplicates: found.filter((j) => !passed(j) && !everFiltered.has(j.id)).length,
      scored: jobs.filter((j) => j.score !== null).length,
      shortlisted: everShortlisted.size,
      picked: everPicked.size,
      tailored: everTailored.size,
      approved: reached('approved').size,
      sentByTool: reached('submitted', 'submitter').size,
      applications: outcomes.total.applied,
      callbacks: outcomes.total.callbacks,
      offers: outcomes.total.offers,
    },
    sources,
    filters,
    scoring: scoringMetrics(jobs, { everShortlisted, everPicked, everDismissed, everSubmitted }, usage),
    tailor: tailorMetrics(store),
    submitter: submitterMetrics(store),
    replies: replyMetrics(store, now),
    outcomes,
    cost: costMetrics(store, usage, spending),
    reliability: reliabilityMetrics(store, usage),
  };
}

function scoringMetrics(
  jobs: JobSummary[],
  sets: { everShortlisted: Set<number>; everPicked: Set<number>; everDismissed: Set<number>; everSubmitted: Set<number> },
  usage: UsageEntry[],
): ScoringMetrics {
  const scored = jobs.filter((j) => j.score !== null);
  // "Yes" is a job you picked or applied to; "no" is one you dismissed and never picked.
  const yes = scored.filter((j) => sets.everPicked.has(j.id) || sets.everSubmitted.has(j.id));
  const no = scored.filter((j) => sets.everDismissed.has(j.id) && !sets.everPicked.has(j.id) && !sets.everSubmitted.has(j.id));
  const decided = new Set([...yes, ...no].map((j) => j.id));
  const listedYes = yes.filter((j) => sets.everShortlisted.has(j.id));
  const listedNo = no.filter((j) => sets.everShortlisted.has(j.id));
  const shortlistedYes = listedYes.length;
  const shortlistedNo = listedNo.length;
  const scores = (rows: JobSummary[]) => rows.map((j) => j.score!);

  // An advisor is named in the scorer's name: "claude-haiku-5-5+advisor:claude-opus-5-5".
  const advisors = new Set(scored.map((j) => /\+advisor:(.+)$/.exec(j.scoredBy ?? '')?.[1]).filter((m): m is string => Boolean(m)));
  const scoreCalls = usage.filter((u) => u.purpose === 'score' && u.error === null && u.jobId !== null);
  const couldAsk = new Set(scoreCalls.filter((u) => !isLocalModel(u.model)).map((u) => u.jobId));
  const asked = new Set(scoreCalls.filter((u) => advisors.has(u.model)).map((u) => u.jobId));

  return {
    scored: scored.length,
    byBand: SCORE_BANDS.map((label) => ({ label, jobs: scored.filter((j) => scoreBand(j.score) === label).length })),
    byScorer: tally(scored, (j) => j.scoredBy ?? 'unknown').map(([model, n]) => ({ model, jobs: n })),
    advisor: advisors.size && couldAsk.size ? count(asked.size, couldAsk.size) : null,
    decisions: {
      picked: yes.length,
      dismissed: no.length,
      medianPicked: median(yes.map((j) => j.score!)),
      medianDismissed: median(no.map((j) => j.score!)),
      auc: auc(scores(yes), scores(no)),
      aucShortlisted: auc(scores(listedYes), scores(listedNo)),
      shortlisted: { picked: shortlistedYes, dismissed: shortlistedNo },
      cutoffs: yes.length + no.length ? CUTOFFS.map((cutoff) => ({ cutoff, picked: count(yes.filter((j) => j.score! >= cutoff).length, yes.length), dismissed: count(no.filter((j) => j.score! >= cutoff).length, no.length) })) : [],
      shortlistPrecision: count(shortlistedYes, shortlistedYes + shortlistedNo),
      pickedBelowCutoff: count(yes.length - shortlistedYes, yes.length),
      undecided: scored.filter((j) => sets.everShortlisted.has(j.id) && !decided.has(j.id)).length,
    },
  };
}

function tailorMetrics(store: JobStore): TailorMetrics {
  const all = store.allApplications();
  const byJob = new Map<number, typeof all>();
  for (const a of all) byJob.set(a.jobId, [...(byJob.get(a.jobId) ?? []), a]);
  const reportOf = (a: (typeof all)[number]) => a.verification as VerificationReport;
  const written = all.filter((a) => reportOf(a).llmChecked);

  const bullets = { total: 0, verbatim: 0, reworded: 0, revertedByRules: 0, revertedByFactCheck: 0 };
  let otherRuleFixes = 0;
  let unresolvedClaims = 0;
  const unresolved: string[] = [];
  const kw = { cvs: 0, matched: 0, total: 0, required: 0, requiredTotal: 0 };
  for (const a of written) {
    const r = reportOf(a);
    const content = a.content as TailoredContent;
    const printed = [...(content.experience ?? []), ...(content.projects ?? [])].reduce((n, e) => n + e.bullets.length, 0);
    const kept = r.bulletChanges?.length ?? 0;
    bullets.total += printed;
    bullets.reworded += kept;
    bullets.verbatim += printed - kept;
    for (const i of r.issues) {
      if (i.severity === 'unresolved') {
        unresolvedClaims++;
        const place = i.where.startsWith('letter') ? 'Cover letter' : i.where.startsWith('bullet') ? 'CV bullet' : 'Summary or headline';
        unresolved.push(`${place}, raised by the ${i.message.startsWith('fact-check') ? 'fact-checker' : 'rule checks (a name or number in neither your CV nor the posting)'}`);
      }
      if (i.severity !== 'fixed') continue;
      const reverted = /reverted to your wording/.test(i.message);
      if (reverted && i.message.startsWith('fact-check:')) bullets.revertedByFactCheck++;
      else if (reverted) bullets.revertedByRules++;
      else otherRuleFixes++;
    }
    if (r.keywords?.total) {
      kw.cvs++;
      kw.matched += r.keywords.matched;
      kw.total += r.keywords.total;
      kw.required += r.keywords.requiredMatched;
      kw.requiredTotal += r.keywords.requiredTotal;
    }
  }

  // Layout and wording are counted on the version of each job that would be sent: its latest.
  const latest = [...byJob.values()].map((versions) => versions[versions.length - 1]!);
  const rendered = latest.filter((a) => reportOf(a).cvPages);
  const withText = latest.filter((a) => reportOf(a).pdfText);
  // Versions made before a check existed don't carry its field: they aren't counted for it.
  const withStyle = latest.filter((a) => reportOf(a).style !== undefined);
  const compared = latest.filter((a) => (reportOf(a).letterSimilarity?.compared ?? 0) > 0);

  return {
    jobs: byJob.size,
    versions: all.length,
    redone: count([...byJob.values()].filter((v) => v.length > 1).length, byJob.size),
    withNote: all.filter((a) => a.feedback).length,
    handEdited: all.length - written.length,
    bullets,
    otherRuleFixes,
    lettersRevised: count(written.filter((a) => reportOf(a).revised).length, written.length),
    needingReview: count(written.filter((a) => !reportOf(a).ok).length, written.length),
    unresolvedClaims,
    unresolvedBy: tally(unresolved, (x) => x).map(([label, claims]) => ({ label, claims })),
    keywords: kw.cvs ? { cvs: kw.cvs, matched: count(kw.matched, kw.total), required: count(kw.required, kw.requiredTotal) } : null,
    onePage: count(rendered.filter((a) => reportOf(a).cvPages === 1).length, rendered.length),
    trimmedToFit: count(rendered.filter((a) => reportOf(a).issues.some((i) => i.where === 'layout' && i.message.startsWith('trimmed'))).length, rendered.length),
    pdfText: withText.length ? count(withText.filter((a) => pdfTextOk(reportOf(a).pdfText!)).length, withText.length) : null,
    styleFlagged: withStyle.length ? count(withStyle.filter((a) => reportOf(a).style!.length > 0).length, withStyle.length) : null,
    letterReuseFlagged: compared.length ? count(compared.filter((a) => reportOf(a).letterSimilarity!.flagged).length, compared.length) : null,
  };
}

function submitterMetrics(store: JobStore): SubmitterMetrics {
  // "manual" records an application you sent yourself, not an attempt by the Submitter.
  const attempts = store.allSubmissions().filter((s) => s.mode !== 'manual');
  const outcomes = (rows: typeof attempts) => ({
    attempts: rows.length,
    submitted: rows.filter((s) => s.outcome === 'submitted').length,
    prepared: rows.filter((s) => s.outcome === 'prepared').length,
    needsYou: rows.filter((s) => s.outcome === 'needs_manual').length,
    failed: rows.filter((s) => s.outcome === 'failed').length,
  });
  const lastByJob = new Map<number, (typeof attempts)[number]>();
  for (const s of attempts) lastByJob.set(s.jobId, s);
  const fields = [...lastByJob.values()].flatMap((s) => (Array.isArray(s.fields) ? (s.fields as PlannedAnswer[]) : [])).filter((f) => f && typeof f.source === 'string');
  const answered = fields.filter((f) => f.source !== 'none');
  const tried = answered.filter((f) => f.filled !== undefined);

  return {
    attempts: attempts.length,
    jobs: lastByJob.size,
    byMode: tally(attempts, (s) => s.mode).map(([mode]) => ({ mode, ...outcomes(attempts.filter((s) => s.mode === mode)) })),
    byAts: tally(attempts, (s) => atsOf(s.applyUrl)).map(([ats]) => {
      const rows = attempts.filter((s) => atsOf(s.applyUrl) === ats);
      return { ats, attempts: rows.length, submitted: rows.filter((s) => s.outcome === 'submitted').length };
    }),
    stopped: tally(attempts.filter((s) => s.outcome === 'needs_manual' || s.outcome === 'failed'), (s) => (s.outcome === 'failed' ? 'It failed with an error' : stopReason(s.reason))).map(([reason, n]) => ({ reason, attempts: n })),
    fields: fields.length
      ? {
          total: fields.length,
          bySource: tally(fields, (f) => f.source).map(([source, n]) => ({ source, fields: n })),
          modelShare: count(answered.filter((f) => f.source.startsWith('model_')).length, answered.length),
          rejectedByPage: count(tried.filter((f) => f.filled === false).length, tried.length),
        }
      : null,
  };
}

function replyMetrics(store: JobStore, now: Date): ReplyMetrics {
  const replies = store.responses();
  const apps = applicationOutcomes(store, now);
  const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
  // A confirmation or a "viewed" notice is the system talking, not the employer answering.
  const real = (kind: string) => kind !== 'confirmation' && kind !== 'viewed';
  const firstReply: number[] = [];
  const rejection: number[] = [];
  for (const a of apps) {
    const answers = a.row.replies.filter((r) => real(r.kind) && r.receivedAt >= a.row.appliedAt).sort((x, y) => x.receivedAt.localeCompare(y.receivedAt));
    if (answers[0]) firstReply.push(days(a.row.appliedAt, answers[0].receivedAt));
    const no = answers.find((r) => r.kind === 'rejection');
    if (no) rejection.push(days(a.row.appliedAt, no.receivedAt));
  }
  return {
    replies: replies.length,
    byKind: tally(replies, (r) => r.kind).map(([kind, n]) => ({ kind, replies: n })),
    byRules: count(replies.filter((r) => r.model === 'rules').length, replies.length),
    unread: replies.filter((r) => r.model === 'unread').length,
    matched: count(replies.filter((r) => r.jobId !== null).length, replies.length),
    setByHand: count(apps.filter((a) => a.row.manual).length, apps.length),
    medianDaysToFirstReply: median(firstReply),
    medianDaysToRejection: median(rejection),
  };
}

function costMetrics(store: JobStore, usage: UsageEntry[], spending: ReturnType<typeof spendingReport>): CostMetrics {
  const paid = usage.filter((u) => u.error === null && !isLocalModel(u.model));
  const local = usage.filter((u) => u.error === null && isLocalModel(u.model));
  const sum = (rows: UsageEntry[], f: (u: UsageEntry) => number) => rows.reduce((n, u) => n + f(u), 0);
  const total = sum(paid, (u) => u.cost);

  // The same tokens with nothing cached; and at list price, to see what batching took off.
  const uncached = (u: UsageEntry) => tokenCost(u.model, { ...u, inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const list = (u: UsageEntry) => tokenCost(u.model, u);
  // A batch call is stored at half its list price.
  const batchSaving = (u: UsageEntry) => (list(u) > 0 && u.cost < list(u) * 0.75 ? list(u) - u.cost : 0);
  const savedByBatch = sum(paid, batchSaving);
  // Caching is compared at the price actually paid per token, so a batch call's saving isn't counted twice.
  const savedByCaching = sum(paid, (u) => (list(u) > 0 ? (uncached(u) - list(u)) * (u.cost / list(u)) : 0));

  const of = (purposes: UsagePurpose[]) => paid.filter((u) => purposes.includes(u.purpose));
  const perUnit = (rows: UsageEntry[], units: number) => (units > 0 && rows.length ? sum(rows, (u) => u.cost) / units : null);
  const since = spending.since;
  const scoredSince = new Set(of(['score']).map((u) => u.jobId).filter((id) => id !== null)).size;
  const versionsSince = since ? store.allApplications().filter((a) => a.createdAt >= since && (a.verification as VerificationReport).llmChecked).length : 0;
  const formsSince = since ? store.allSubmissions().filter((s) => s.mode !== 'manual' && s.createdAt >= since).length : 0;

  const weekOf = (iso: string) => {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const promptTokens = sum(paid, (u) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens);

  return {
    since,
    total,
    byPurpose: tally(paid, (u) => u.purpose)
      .map(([purpose]) => {
        const rows = paid.filter((u) => u.purpose === purpose);
        return {
          label: PURPOSE_LABELS[purpose as UsagePurpose] ?? purpose,
          calls: rows.length,
          cost: sum(rows, (u) => u.cost),
          inputTokens: sum(rows, (u) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens),
          outputTokens: sum(rows, (u) => u.outputTokens),
        };
      })
      .sort((a, b) => b.cost - a.cost),
    byModel: tally(paid, (u) => u.model)
      .map(([model]) => ({ model, calls: paid.filter((u) => u.model === model).length, cost: sum(paid.filter((u) => u.model === model), (u) => u.cost) }))
      .sort((a, b) => b.cost - a.cost),
    byWeek: tally(paid, (u) => weekOf(u.at))
      .map(([week]) => ({ week, cost: sum(paid.filter((u) => weekOf(u.at) === week), (u) => u.cost) }))
      .sort((a, b) => a.week.localeCompare(b.week)),
    tokens: {
      input: sum(paid, (u) => u.inputTokens),
      output: sum(paid, (u) => u.outputTokens),
      cacheRead: sum(paid, (u) => u.cacheReadTokens),
      cacheWrite: sum(paid, (u) => u.cacheWriteTokens),
    },
    cacheShare: count(sum(paid, (u) => u.cacheReadTokens), promptTokens),
    listPriceUncached: total + savedByCaching + savedByBatch,
    savedByCaching,
    savedByBatch,
    perJobScored: perUnit(of(['score']), scoredSince),
    perTailoredVersion: perUnit(of(['draft', 'fact-check', 'revise']), versionsSince),
    perFormFilled: perUnit(of(['form']), formsSince),
    perApplication: spending.perApplication,
    perCallback: spending.perCallback,
    local: {
      calls: local.length,
      inputTokens: sum(local, (u) => u.inputTokens),
      outputTokens: sum(local, (u) => u.outputTokens),
      minutes: sum(local, (u) => u.durationMs ?? 0) / 60_000,
    },
  };
}

function reliabilityMetrics(store: JobStore, usage: UsageEntry[]): ReliabilityMetrics {
  const runs = store.runs();
  const scout = runs.filter((r) => r.agent === 'scout' && r.stats);
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const ok = scout.reduce((n, r) => n + num((r.stats!.sources as { ok?: number } | undefined)?.ok), 0);
  const failed = scout.reduce((n, r) => n + num((r.stats!.sources as { failed?: number } | undefined)?.failed), 0);
  return {
    calls: count(usage.filter((u) => u.error !== null).length, usage.length),
    claude: count(usage.filter((u) => u.error !== null && !isLocalModel(u.model)).length, usage.filter((u) => !isLocalModel(u.model)).length),
    local: count(usage.filter((u) => u.error !== null && isLocalModel(u.model)).length, usage.filter((u) => isLocalModel(u.model)).length),
    failures: tally(usage.filter((u) => u.error !== null), (u) => `${isLocalModel(u.model) ? 'Local model' : 'Claude'}: ${failureReason(u.error)}`).map(([reason, calls]) => ({ reason, calls })),
    byPurpose: tally(usage, (u) => u.purpose).map(([purpose]) => {
      const rows = usage.filter((u) => u.purpose === purpose);
      const times = rows.filter((u) => u.error === null && u.durationMs !== null).map((u) => u.durationMs!);
      return {
        label: PURPOSE_LABELS[purpose as UsagePurpose] ?? purpose,
        calls: rows.length,
        failed: rows.filter((u) => u.error !== null).length,
        p50Ms: percentile(times, 0.5),
        p95Ms: percentile(times, 0.95),
      };
    }),
    runs: tally(runs, (r) => r.agent).map(([agent]) => {
      const mine = runs.filter((r) => r.agent === agent);
      const minutes = mine.filter((r) => r.finishedAt).map((r) => (Date.parse(r.finishedAt!) - Date.parse(r.startedAt)) / 60_000);
      return { agent, runs: mine.length, unfinished: mine.filter((r) => !r.finishedAt).length, medianMinutes: median(minutes) };
    }),
    sourceFetches: ok + failed ? count(failed, ok + failed) : null,
    scoreErrors: scout.reduce((n, r) => n + num(r.stats!.scoreErrors), 0),
  };
}
