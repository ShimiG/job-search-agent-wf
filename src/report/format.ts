import type { OutcomeGroup } from '../pipeline/outcomes.ts';
import { WAITING_DAYS } from '../pipeline/outcomes.ts';
import type { EvalSummary } from '../evals/types.ts';
import type { CaseStudy, Count } from './metrics.ts';

/*
 * The case-study numbers as a Markdown document: tables to paste into a write-up, each rate with the
 * counts behind it. Small samples are marked, because most of a job search's samples are small.
 */

/** A rate from fewer cases than this is marked with an asterisk. */
export const SMALL_SAMPLE = 20;

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (r: number | null) => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
/** "12 of 40 (30%)", with * when the sample is small. */
export const rate = (c: Count | null) => (!c || c.of === 0 ? 'n/a' : `${int(c.n)} of ${int(c.of)} (${pct(c.rate)})${c.of < SMALL_SAMPLE ? '*' : ''}`);
/** Dollars: cents for sums, a tenth of a cent for the cost of one small call. */
export const usd = (d: number | null) => (d === null ? 'n/a' : d === 0 ? '$0' : d < 0.0005 ? '<$0.001' : d < 1 ? `$${d.toFixed(3)}` : `$${d.toFixed(2)}`);
const secs = (ms: number | null) => (ms === null ? 'n/a' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const num = (n: number | null, digits = 0) => (n === null ? 'n/a' : n.toFixed(digits));
/** "1 callback", "3 callbacks". */
const things = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

function table(head: string[], rows: Array<Array<string | number>>): string[] {
  if (!rows.length) return ['_Nothing recorded yet._', ''];
  // Numbers read best right-aligned; the first column is the label.
  return [`| ${head.join(' | ')} |`, `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
}

const step = (n: number, before: number) => (before > 0 ? `${int(n)} (${pct(n / before)})` : int(n));

function outcomeTable(first: string, groups: OutcomeGroup[]): string[] {
  return table(
    [first, 'Applied', 'Callbacks', 'Callback rate', 'Rejected', 'No reply', 'Waiting'],
    groups.map((g) => [g.label, g.applied, g.callbacks, rate({ n: g.callbacks, of: g.applied - g.waiting, rate: g.rate }), g.rejected, g.noReply, g.waiting]),
  );
}

export function formatCaseStudy(c: CaseStudy, evals: EvalSummary[] = []): string {
  const f = c.funnel;
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'n/a');
  const out: string[] = [
    '# Job Agents: the numbers',
    '',
    `Generated ${day(c.generatedAt)}. Jobs recorded since ${day(c.period.jobsFrom)} (${c.period.days} days); model costs recorded since ${day(c.period.costsFrom)}.`,
    '',
    'Counts, rates, dollars and times only: no company, job or person is named. A rate marked * comes from',
    `fewer than ${SMALL_SAMPLE} cases, too few to conclude much from.`,
    '',
  ];
  if (f.found + f.addedByYou + f.applications === 0 && c.cost.total === 0 && !evals.length) {
    out.push('Nothing has been recorded yet. Run Scout, apply to some jobs, and generate this again.', '');
    return out.join('\n');
  }

  const d = c.scoring.decisions;
  const t = c.tailor;
  const judged = c.outcomes.total.applied - c.outcomes.total.waiting;
  out.push('## At a glance', '');
  out.push(`- **Found** ${things(f.found, 'job')} from ${things(c.sources.length, 'source')}; ${int(f.filteredOut + f.duplicates)} dropped by rules before any model saw them, ${int(f.scored)} scored, ${int(f.shortlisted)} shortlisted.`);
  out.push(`- **Applied** to ${things(f.applications, 'job')} (${int(f.sentByTool)} sent by the Submitter); ${things(f.callbacks, 'callback')}${f.offers ? `, ${things(f.offers, 'offer')}` : ''}: ${rate({ n: f.callbacks, of: judged, rate: c.outcomes.total.rate })} of those older than ${WAITING_DAYS} days.`);
  if (d.picked + d.dismissed) out.push(`- **Scoring**: a job you picked outscored a job you dismissed ${pct(d.auc)} of the time (${d.picked} picked, ${d.dismissed} dismissed)${d.aucShortlisted !== null ? `, and ${pct(d.aucShortlisted)} of the time among shortlisted jobs only` : ''}; you picked ${rate(d.shortlistPrecision)} of the shortlisted jobs you decided on.`);
  if (t.versions) out.push(`- **Tailoring**: ${int(t.bullets.total)} bullets written, ${pct(t.bullets.total ? t.bullets.verbatim / t.bullets.total : null)} in your CV's exact words; the checks took back ${int(t.bullets.revertedByRules + t.bullets.revertedByFactCheck)} rewordings that added something your CV doesn't say, and left ${things(t.unresolvedClaims, 'claim')} for you to judge.`);
  if (c.cost.since) out.push(`- **Cost**: ${usd(c.cost.total)} on Claude: ${usd(c.cost.perApplication)} per application, ${usd(c.cost.perCallback)} per callback. Caching and batching took ${usd(c.cost.savedByCaching + c.cost.savedByBatch)} off the list price.`);
  if (c.reliability.calls.of) out.push(`- **Reliability**: ${rate(c.reliability.claude)} calls to Claude failed, and ${rate(c.reliability.local)} calls to the local model.`);
  out.push('');

  out.push('## Funnel', '', 'Each stage, and its share of the stage before it.', '');
  const seen = f.found + f.addedByYou;
  const passed = seen - f.filteredOut - f.duplicates;
  out.push(
    ...table(
      ['Stage', 'Jobs'],
      [
        ['Found by Scout, or added by you', int(seen)],
        ['Passed the rules (not filtered out, not a duplicate)', step(passed, seen)],
        ['Scored', step(f.scored, passed)],
        ['Shortlisted', step(f.shortlisted, f.scored)],
        ['Picked by you', step(f.picked, f.shortlisted)],
        ['Tailored', step(f.tailored, f.picked)],
        ['Approved by you', step(f.approved, f.tailored)],
        ['Sent by the Submitter', step(f.sentByTool, f.approved)],
      ],
    ),
  );
  out.push(`Scout found ${int(f.found)} of these and you added ${int(f.addedByYou)}. Your rules filtered out ${int(f.filteredOut)}, and ${int(f.duplicates)} turned out to be a job already seen. In all, ${things(f.applications, 'application was', 'applications were')} sent, by the Submitter or by you.`, '');

  out.push('## Where jobs came from', '');
  out.push(...table(['Source', 'Found', 'Passed rules', 'Scored', 'Median score', 'Shortlisted', 'Picked', 'Applied'], c.sources.map((s) => [s.label, s.found, s.passedFilters, s.scored, num(s.medianScore), s.shortlisted, s.picked, s.applied])));

  out.push('## Why jobs were filtered out', '', 'Decided by rules, before any model call.', '');
  out.push(...table(['Reason', 'Jobs'], c.filters.map((x) => [x.reason, x.jobs])));

  out.push('## Scoring', '');
  out.push(...table(['Score', 'Jobs'], c.scoring.byBand.map((b) => [b.label, b.jobs])));
  out.push(...table(['Scored by', 'Jobs'], c.scoring.byScorer.map((s) => [s.model, s.jobs])));
  if (c.scoring.advisor) out.push(`The stronger advisor model was consulted on ${rate(c.scoring.advisor)} jobs.`, '');
  out.push('### Scores against your own decisions', '');
  out.push('A job you picked or applied to is a yes; one you dismissed and never picked is a no. No model was asked: these are your decisions.', '');
  out.push(
    ...table(
      ['Measure', 'Value'],
      [
        ['Jobs you said yes to', d.picked],
        ['Jobs you said no to', d.dismissed],
        ['Median score of a yes', num(d.medianPicked)],
        ['Median score of a no', num(d.medianDismissed)],
        ['Chance a yes outscores a no (AUC; 50% is a coin flip)', pct(d.auc)],
        [`The same among shortlisted jobs only (${d.shortlisted.picked} yes, ${d.shortlisted.dismissed} no)`, pct(d.aucShortlisted)],
        ['Shortlisted jobs you picked, of those you decided on', rate(d.shortlistPrecision)],
        ['Jobs you picked from below the cutoff, of all you picked', rate(d.pickedBelowCutoff)],
        ['Shortlisted jobs not decided on yet', d.undecided],
      ],
    ),
  );

  out.push(
    'The second AUC is the stricter one. A job below the cutoff was shown to you as a poor fit, so dismissing it mostly repeats the score; among shortlisted jobs you were choosing between jobs the scorer liked.',
    '',
  );
  if (d.cutoffs.length) {
    out.push('What each cutoff would have put on the shortlist, of the jobs you decided on:', '');
    out.push(
      ...table(
        ['Cutoff', 'Jobs you said yes to, kept', 'Jobs you said no to, kept', 'Share of that shortlist you would pick'],
        d.cutoffs.map((x) => [x.cutoff, rate(x.picked), rate(x.dismissed), rate({ n: x.picked.n, of: x.picked.n + x.dismissed.n, rate: x.picked.n + x.dismissed.n ? x.picked.n / (x.picked.n + x.dismissed.n) : null })]),
      ),
    );
  }

  out.push('## Tailoring', '');
  out.push(
    ...table(
      ['Measure', 'Value'],
      [
        ['Jobs tailored', t.jobs],
        ['Versions written', t.versions],
        ['Jobs tailored more than once', rate(t.redone)],
        ['Versions written after a note from you', t.withNote],
        ['Versions edited by hand', t.handEdited],
        ['Bullets written', int(t.bullets.total)],
        ["Bullets in your CV's exact words", rate({ n: t.bullets.verbatim, of: t.bullets.total, rate: t.bullets.total ? t.bullets.verbatim / t.bullets.total : null })],
        ['Bullets reworded and kept', int(t.bullets.reworded)],
        ['Rewordings taken back by the rule checks', int(t.bullets.revertedByRules)],
        ['Rewordings taken back by the fact-check', int(t.bullets.revertedByFactCheck)],
        ['Other fixes by the rule checks (unknown highlights, skills not yours...)', int(t.otherRuleFixes)],
        ['Cover letters rewritten after the fact-check', rate(t.lettersRevised)],
        ['Versions left with a claim for you to judge', rate(t.needingReview)],
        ...(t.keywords ? [["Posting's key terms in the CV word for word", rate(t.keywords.matched)], ['Of the must-have terms', rate(t.keywords.required)]] : []),
        ['CVs on one page', rate(t.onePage)],
        ['CVs trimmed to fit', rate(t.trimmedToFit)],
        ...(t.pdfText ? [['CVs whose text reads back out of the PDF whole', rate(t.pdfText)]] : []),
        ...(t.styleFlagged ? [['CVs with a bullet breaking a writing rule', rate(t.styleFlagged)]] : []),
        ...(t.letterReuseFlagged ? [['Cover letters repeating an earlier one', rate(t.letterReuseFlagged)]] : []),
      ],
    ),
  );

  if (t.unresolvedBy.length) {
    out.push(`The ${things(t.unresolvedClaims, 'claim')} left for you:`, '');
    out.push(...table(['Where, and which check raised it', 'Claims'], t.unresolvedBy.map((x) => [x.label, x.claims])));
  }

  const s = c.submitter;
  out.push('## Sending', '');
  out.push(...table(['Mode', 'Attempts', 'Submitted', 'Prepared for you', 'Needed you', 'Failed'], s.byMode.map((m) => [m.mode, m.attempts, m.submitted, m.prepared, m.needsYou, m.failed])));
  out.push(...table(['Application system', 'Attempts', 'Submitted'], s.byAts.map((a) => [a.ats, a.attempts, a.submitted])));
  if (s.stopped.length) {
    out.push('Why an attempt ended without sending:', '');
    out.push(...table(['Reason', 'Attempts'], s.stopped.map((x) => [x.reason, x.attempts])));
  }
  if (s.fields) {
    out.push(`Form fields, from each job's latest attempt (${int(s.fields.total)} fields):`, '');
    out.push(...table(['Answered from', 'Fields'], s.fields.bySource.map((x) => [x.source.replace(/_/g, ' '), x.fields])));
    out.push(`The model wrote ${rate(s.fields.modelShare)} of the answers; the page refused ${rate(s.fields.rejectedByPage)} of the answers typed.`, '');
  }

  const r = c.replies;
  out.push('## Replies', '');
  out.push(...table(['Kind', 'Emails'], r.byKind.map((k) => [k.kind, k.replies])));
  out.push(
    ...table(
      ['Measure', 'Value'],
      [
        ['Emails about your applications', r.replies],
        ['Read by fixed rules, without a model', rate(r.byRules)],
        ['Matched to an application', rate(r.matched)],
        ['Applications whose stage you set by hand', rate(r.setByHand)],
        ["Median days to an employer's first answer", num(r.medianDaysToFirstReply, 1)],
        ['Median days to a rejection', num(r.medianDaysToRejection, 1)],
      ],
    ),
  );

  out.push('## Callbacks', '', `A callback is an assessment, an interview or an offer. The rate leaves out applications sent in the last ${WAITING_DAYS} days.`, '');
  out.push(...outcomeTable('Source', c.outcomes.bySource));
  out.push(...outcomeTable('Score', c.outcomes.byScore));
  out.push(...outcomeTable('How it was sent', c.outcomes.byMethod));

  const k = c.cost;
  out.push('## Cost', '');
  out.push(...table(['What the calls were for', 'Calls', 'Prompt tokens', 'Output tokens', 'Cost'], k.byPurpose.map((p) => [p.label, int(p.calls), tokens(p.inputTokens), tokens(p.outputTokens), usd(p.cost)])));
  out.push(...table(['Model', 'Calls', 'Cost'], k.byModel.map((m) => [m.model, int(m.calls), usd(m.cost)])));
  out.push(
    ...table(
      ['Measure', 'Value'],
      [
        ['Total spent on Claude', usd(k.total)],
        ['Same calls at list price, nothing cached or batched', usd(k.listPriceUncached)],
        ['Saved by prompt caching', usd(k.savedByCaching)],
        ['Saved by batch scoring', usd(k.savedByBatch)],
        ['Prompt tokens served from the cache', k.cacheShare.of ? `${pct(k.cacheShare.rate)} of ${tokens(k.cacheShare.of)}` : 'n/a'],
        ['Per job scored', usd(k.perJobScored)],
        ['Per tailored CV and letter', usd(k.perTailoredVersion)],
        ['Per form filled', usd(k.perFormFilled)],
        ['Per application sent (everything included)', usd(k.perApplication)],
        ['Per callback (everything included)', usd(k.perCallback)],
        ['Calls handled by a local model, at no cost', `${int(k.local.calls)} (${tokens(k.local.inputTokens + k.local.outputTokens)} tokens, ${k.local.minutes < 90 ? `${k.local.minutes.toFixed(1)} minutes` : `${(k.local.minutes / 60).toFixed(1)} hours`})`],
      ],
    ),
  );
  if (k.byWeek.length > 1) out.push(...table(['Week starting', 'Cost'], k.byWeek.map((w) => [w.week, usd(w.cost)])));

  const rel = c.reliability;
  out.push('## Reliability', '');
  out.push(...table(['What the calls were for', 'Calls', 'Failed', 'Median time', '95th percentile'], rel.byPurpose.map((p) => [p.label, int(p.calls), p.failed, secs(p.p50Ms), secs(p.p95Ms)])));
  if (rel.failures.length) out.push(...table(['Why calls failed', 'Calls'], rel.failures.map((x) => [x.reason, x.calls])));
  out.push(...table(['Agent', 'Runs', 'Did not finish', 'Median minutes'], rel.runs.map((x) => [x.agent, x.runs, x.unfinished, num(x.medianMinutes, 1)])));
  out.push(`Source fetches that failed: ${rate(rel.sourceFetches)}. Jobs whose scoring failed: ${int(rel.scoreErrors)}.`, '');

  if (evals.length) {
    out.push('## Evals', '', 'Fixed test sets, run on demand against the same code the agents use (`npm run eval`). Unlike the numbers above, anyone can rerun these.', '');
    for (const e of evals) {
      out.push(`### ${e.title}`, '', `${e.cases} cases, run ${day(e.ranAt)} with ${e.model}${e.cost ? ` for ${usd(e.cost)}` : ''}${e.errors ? `; ${e.errors} case(s) could not be run` : ''}.`, '');
      out.push(...table(['Measure', 'Value'], e.metrics.map((m) => [m.label, m.count ? rate(m.count) : (m.value ?? 'n/a')])));
      if (e.misses?.length) out.push(`Wrong: ${e.misses.map((m) => `\`${m.id}\` (expected ${m.expected}, got ${m.got})`).join('; ')}.`, '');
    }
  }

  out.push(
    '## How these are counted',
    '',
    '- Everything is counted from the local database. Nothing is estimated except dollars, which come from token counts at list prices; the Anthropic console has the exact bill.',
    '- A job counts for a stage if it ever reached it, so a job later archived still counts as shortlisted.',
    c.period.costsFrom
      ? `- Costs are only known from ${day(c.period.costsFrom)}; per-application and per-callback costs count applications sent since then, and include the scoring of jobs never applied to.`
      : '- No model cost has been recorded yet, so the cost figures are empty.',
    '- Call times include retries. Batch results and advisor steps carry no time of their own, and calls made before timing was added have none.',
    '- A source\'s "passed rules" counts a job that was scored even if a later change of rules filtered it out.',
    '- Tailoring counts cover every version the model wrote; layout and wording counts cover the latest version of each job. A version made before a check existed is not counted for that check.',
    '',
  );
  return out.join('\n');
}
