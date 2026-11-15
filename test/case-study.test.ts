import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { CostMeter, BATCH_DISCOUNT } from '../src/llm/cost.ts';
import { formatCaseStudy, rate, usd } from '../src/report/format.ts';
import { atsOf, auc, caseStudy, filterReason, median, percentile } from '../src/report/metrics.ts';
import { markSubmitted } from '../src/submit/run.ts';
import type { TailoredContent, VerificationReport } from '../src/tailor/schema.ts';
import { makeJob } from './helpers.ts';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const score = (n: number) => ({ score: n, verdict: 'good' as const, seniorityFit: 'fit' as const, matchReasons: [], gaps: [], dealbreakers: [], summary: '' });

describe('the maths', () => {
  it('median, percentile and AUC', () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95), 100);
    assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
    assert.equal(auc([90, 80], [70, 60]), 1);
    assert.equal(auc([60], [70]), 0);
    assert.equal(auc([70, 70], [70]), 0.5);
    assert.equal(auc([], [70]), null);
  });

  it('groups filter reasons and application systems without keeping any name', () => {
    assert.equal(filterReason('excluded company: Initech'), 'A company you excluded');
    assert.equal(filterReason('posted 45 days ago (max 30)'), 'Posted too long ago');
    assert.equal(filterReason('posted about 80 days ago (estimated from its LinkedIn job ID)'), 'Posted too long ago');
    assert.equal(filterReason('location not allowed: Berlin'), 'Location');
    assert.equal(filterReason('something new'), 'Other');
    assert.equal(atsOf('https://boards.greenhouse.io/initech/jobs/1'), 'Greenhouse');
    assert.equal(atsOf('https://careers.initech.com/apply/1'), 'Other sites');
    assert.equal(atsOf(null), 'Other sites');
  });

  it('formats rates with their counts, and marks small samples', () => {
    assert.equal(rate({ n: 3, of: 12, rate: 0.25 }), '3 of 12 (25%)*');
    assert.equal(rate({ n: 30, of: 120, rate: 0.25 }), '30 of 120 (25%)');
    assert.equal(rate({ n: 0, of: 0, rate: null }), 'n/a');
    assert.deepEqual([usd(0), usd(0.0042), usd(12.5), usd(null)], ['$0', '$0.004', '$12.50', 'n/a']);
  });
});

/** A small search: 8 jobs found, 5 scored, 3 picked, 2 sent by the Submitter and 1 by hand, with replies and costs. */
function seed() {
  const store = new JobStore(':memory:');
  const at = ago(40).toISOString();
  const add = (source: 'greenhouse' | 'email' | 'manual', externalId: string, company: string) =>
    store.upsert(makeJob({ source, externalId, company, title: `Secret Role at ${company}`, url: `https://${company.toLowerCase()}.example.com/jobs/1` }), at).id;
  const filtered = add('greenhouse', 'initech:1', 'Initech');
  store.setStatus(filtered, 'filtered_out', 'location not allowed: Berlin', 'scout', at);
  const old = add('email', 'linkedin:9', 'Hooli');
  store.setStatus(old, 'filtered_out', 'posted 45 days ago (max 30)', 'scout', at);
  const dupe = add('email', 'linkedin:10', 'Globex');
  store.setStatus(dupe, 'duplicate', 'same job as #4', 'scout', at);

  const scored = (source: 'greenhouse' | 'email' | 'manual', externalId: string, company: string, n: number, by = 'claude-haiku-5-5+advisor:claude-opus-5-5') => {
    const id = add(source, externalId, company);
    store.saveScore(id, score(n), n >= 65 ? 'shortlisted' : 'low_score', at, by);
    store.setStatus(id, n >= 65 ? 'shortlisted' : 'low_score', null, 'scout', at);
    return id;
  };
  const globex = scored('greenhouse', 'globex:1', 'Globex', 90);
  const umbrella = scored('greenhouse', 'umbrella:1', 'Umbrella', 78);
  const soylent = scored('email', 'linkedin:11', 'Soylent', 70);
  const vandelay = scored('email', 'drushim:5', 'Vandelay', 55, 'ollama:gemma3:12b');
  const wonka = scored('manual', 'manual:1', 'Wonka', 82);

  for (const id of [globex, umbrella, vandelay]) store.setStatus(id, 'selected', null, 'user', at);
  store.setStatus(soylent, 'dismissed', null, 'user', at);

  // Tailoring: Globex twice (a redo after a note), Umbrella once with an unresolved claim.
  const content = (bullets: number) => ({ experience: [{ id: 'acme', bullets: Array.from({ length: bullets }, (_, i) => ({ source: `h${i}`, text: `b${i}` })) }], projects: [] }) as unknown as TailoredContent;
  const report = (over: Partial<VerificationReport>): VerificationReport => ({ ok: true, issues: [], bulletChanges: [], llmChecked: true, revised: false, cvPages: 1, ...over });
  const save = (jobId: number, verification: VerificationReport, feedback: string | null, bullets = 6) =>
    store.saveApplication({ jobId, dir: `/tmp/none/${jobId}`, cvLanguage: 'en', letterLanguage: 'en', content: content(bullets), verification, feedback, model: 'claude-sonnet-5-5', createdAt: ago(30).toISOString() });
  save(globex, report({
    bulletChanges: [{ source: 'h0', original: 'a', final: 'b' }, { source: 'h1', original: 'a', final: 'b' }],
    issues: [
      { severity: 'fixed', where: 'bullet:h2', message: 'added number 40 not in your CV; reverted to your wording' },
      { severity: 'fixed', where: 'bullet:h3', message: 'fact-check: claims Kubernetes; reverted to your wording' },
      { severity: 'fixed', where: 'skills', message: 'dropped "Rust" (not in your CV skills)' },
    ],
    revised: true,
    keywords: { items: [], matched: 6, supported: 8, total: 10, requiredMatched: 3, requiredTotal: 4 },
  }), null);
  save(globex, report({ bulletChanges: [{ source: 'h0', original: 'a', final: 'b' }], pdfText: { checked: 20, missing: [], outOfOrder: [] }, style: [] }), 'lead with the integrations work');
  save(umbrella, report({
    ok: false,
    cvPages: 2,
    issues: [{ severity: 'unresolved', where: 'letter:1', message: 'mentions Kubernetes, found in neither your CV nor the posting' }, { severity: 'warning', where: 'layout', message: 'trimmed to fit 1 page(s): fewer skills' }],
    pdfText: { checked: 20, missing: ['+972'], outOfOrder: [] },
    style: [{ where: 'bullet:h0', text: 'Responsible for x', problems: ['opens with "Responsible for"'], fromCv: true }],
  }), null, 4);
  for (const id of [globex, umbrella]) {
    store.setStatus(id, 'tailored', 'v1 ready', 'tailor', at);
    store.setStatus(id, 'approved', null, 'user', at);
  }

  // Sending: Globex failed once, then went through; Umbrella went through; Wonka was sent by hand.
  const attempt = (jobId: number, outcome: 'submitted' | 'failed', applyUrl: string, fields: unknown, days: number) =>
    store.saveSubmission({ jobId, applicationId: null, mode: 'auto', outcome, applyUrl, reason: null, fields, screenshots: [], confirmation: null, createdAt: ago(days).toISOString() });
  attempt(globex, 'failed', 'https://boards.greenhouse.io/globex/jobs/1', null, 29);
  attempt(globex, 'submitted', 'https://boards.greenhouse.io/globex/jobs/1', [
    { key: 'a', label: 'First name', kind: 'text', required: true, value: 'Dana', source: 'profile', filled: true },
    { key: 'b', label: 'Why us?', kind: 'textarea', required: false, value: 'Because', source: 'model_draft', filled: true },
    { key: 'c', label: 'Visa?', kind: 'select', required: true, value: 'No', source: 'answer_bank', filled: false },
    { key: 'd', label: 'Gender', kind: 'select', required: false, value: '', source: 'none' },
  ], 28);
  attempt(umbrella, 'submitted', 'https://careers.umbrella.example.com/apply', [], 27);
  for (const [id, days] of [[globex, 28], [umbrella, 27]] as const) store.setStatus(id, 'submitted', null, 'submitter', ago(days).toISOString());
  markSubmitted(store, wonka, 'you applied on the company site', ago(20));

  // Replies: Globex confirmed, then invited to interview after 6 days; Umbrella rejected after 10.
  let n = 0;
  const reply = (jobId: number | null, kind: string, days: number, model = 'ollama:gemma3:12b') =>
    store.saveResponse({ messageId: `<m${n++}>`, jobId, receivedAt: ago(days).toISOString(), fromName: 'HR', fromAddress: 'hr@example.com', subject: kind, kind, company: '', title: '', summary: '', action: '', model }, NOW.toISOString());
  reply(globex, 'confirmation', 28, 'rules');
  reply(globex, 'interview', 22);
  reply(umbrella, 'rejection', 17);
  reply(null, 'not_related', 5);

  // Costs: cached scoring, one batch call, the advisor on Globex, tailoring, a failure, and the local model.
  const meter = new CostMeter('scout', () => ago(35));
  const runId = store.startRun('scout', ago(35).toISOString());
  meter.attach(store, runId);
  meter.record('score', 'claude-haiku-5-5', { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 8_000 }, globex);
  meter.record('score', 'claude-opus-5-5', { input_tokens: 9_000, output_tokens: 500 }, globex);
  meter.record('score', 'claude-haiku-5-5', { input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 8_000 }, umbrella);
  meter.record('score', 'claude-haiku-5-5', { input_tokens: 10_000, output_tokens: 300 }, soylent, BATCH_DISCOUNT);
  meter.record('draft', 'claude-sonnet-5-5', { input_tokens: 20_000, output_tokens: 4_000 }, globex);
  meter.record('fact-check', 'claude-sonnet-5-5', { input_tokens: 20_000, output_tokens: 1_000 }, globex);
  meter.fail('draft', 'claude-sonnet-5-5', new Error('529 overloaded'), 61_000, umbrella);
  meter.recordLocal('score', 'ollama:gemma3:12b', { inputTokens: 6_000, outputTokens: 200, durationMs: 9_000 }, vandelay);
  meter.recordLocal('reply', 'ollama:gemma3:12b', { inputTokens: 1_500, outputTokens: 80, durationMs: 3_000 });
  store.finishRun(runId, { sources: { ok: 9, failed: 1, errors: [] }, scoreErrors: 2 }, ago(35 - 0.01).toISOString());
  store.startRun('tailor', ago(30).toISOString());
  return { store };
}

describe('the case study', () => {
  it('counts the funnel, by source, and why jobs were filtered out', () => {
    const c = caseStudy(seed().store, NOW);
    assert.deepEqual(c.funnel, {
      found: 7, addedByYou: 1, filteredOut: 2, duplicates: 1, scored: 5, shortlisted: 4, picked: 3, tailored: 2, approved: 2, sentByTool: 2, applications: 3, callbacks: 1, offers: 0,
    });
    assert.equal(c.period.days, 40);
    const greenhouse = c.sources.find((s) => s.label === 'Greenhouse boards')!;
    assert.deepEqual(greenhouse, { label: 'Greenhouse boards', found: 3, passedFilters: 2, scored: 2, shortlisted: 2, picked: 2, applied: 2, medianScore: 84 });
    assert.deepEqual(c.sources.map((s) => s.label).sort(), ['Drushim alerts', 'Greenhouse boards', 'LinkedIn alerts']);
    assert.deepEqual(c.filters, [{ reason: 'Location', jobs: 1 }, { reason: 'Posted too long ago', jobs: 1 }]);
  });

  it('measures scores against the decisions you made', () => {
    const { scoring } = caseStudy(seed().store, NOW);
    const d = scoring.decisions;
    // Yes: Globex 90, Umbrella 78, Vandelay 55 (picked from below the cutoff), Wonka 82 (applied). No: Soylent 70.
    assert.deepEqual([d.picked, d.dismissed, d.medianPicked, d.medianDismissed], [4, 1, 80, 70]);
    assert.equal(d.auc, 0.75);
    assert.deepEqual(d.shortlistPrecision, { n: 3, of: 4, rate: 0.75 });
    assert.deepEqual(d.pickedBelowCutoff, { n: 1, of: 4, rate: 0.25 });
    assert.equal(d.undecided, 0);
    // The advisor was asked on 1 of the 3 jobs Claude scored for money.
    assert.deepEqual(scoring.advisor, { n: 1, of: 3, rate: 1 / 3 });
    assert.deepEqual(scoring.byScorer[0], { model: 'claude-haiku-5-5+advisor:claude-opus-5-5', jobs: 4 });
  });

  it('counts what the Tailor wrote and what its checks took back', () => {
    const { tailor: t } = caseStudy(seed().store, NOW);
    assert.deepEqual([t.jobs, t.versions, t.withNote, t.handEdited], [2, 3, 1, 0]);
    assert.deepEqual(t.redone, { n: 1, of: 2, rate: 0.5 });
    assert.deepEqual(t.bullets, { total: 16, verbatim: 13, reworded: 3, revertedByRules: 1, revertedByFactCheck: 1 });
    assert.equal(t.otherRuleFixes, 1);
    assert.deepEqual([t.lettersRevised.n, t.needingReview.n, t.unresolvedClaims], [1, 1, 1]);
    assert.deepEqual(t.keywords, { cvs: 1, matched: { n: 6, of: 10, rate: 0.6 }, required: { n: 3, of: 4, rate: 0.75 } });
    // Layout and wording: the latest version of each job.
    assert.deepEqual([t.onePage.n, t.onePage.of, t.trimmedToFit.n], [1, 2, 1]);
    assert.deepEqual(t.pdfText, { n: 1, of: 2, rate: 0.5 });
    assert.deepEqual(t.styleFlagged, { n: 1, of: 2, rate: 0.5 });
    assert.equal(t.letterReuseFlagged, null);
  });

  it('counts sending, replies and how long answers took', () => {
    const c = caseStudy(seed().store, NOW);
    assert.deepEqual(c.submitter.byMode, [{ mode: 'auto', attempts: 3, submitted: 2, prepared: 0, needsYou: 0, failed: 1 }]);
    assert.deepEqual(c.submitter.byAts, [{ ats: 'Greenhouse', attempts: 2, submitted: 1 }, { ats: 'Other sites', attempts: 1, submitted: 1 }]);
    assert.equal(c.submitter.fields!.total, 4);
    assert.deepEqual(c.submitter.fields!.modelShare, { n: 1, of: 3, rate: 1 / 3 });
    assert.deepEqual(c.submitter.fields!.rejectedByPage, { n: 1, of: 3, rate: 1 / 3 });
    // The email that wasn't about an application is not a reply.
    assert.equal(c.replies.replies, 3);
    assert.deepEqual(c.replies.byRules, { n: 1, of: 3, rate: 1 / 3 });
    assert.deepEqual(c.replies.matched, { n: 3, of: 3, rate: 1 });
    assert.equal(c.replies.medianDaysToFirstReply, 8);
    assert.equal(c.replies.medianDaysToRejection, 10);
  });

  it('adds up cost, what caching and batching saved, and what each step costs', () => {
    const { cost: k } = caseStudy(seed().store, NOW);
    const haiku = (input: number, output: number, cached = 0) => (input * 0.1 + output * 0.5 + cached * 0.01) / 1e6;
    const opus = (9_000 * 4 + 500 * 20) / 1e6;
    const sonnet = (20_000 * 2 + 4_000 * 10 + 20_000 * 2 + 1_000 * 10) / 1e6;
    const scoring = 2 * haiku(2_000, 300, 8_000) + opus + haiku(10_000, 300) * 0.5;
    assert.ok(Math.abs(k.total - (scoring + sonnet)) < 1e-9);
    assert.ok(Math.abs(k.savedByBatch - haiku(10_000, 300) * 0.5) < 1e-9);
    // 16,000 cached tokens read at 0.01 instead of 0.1 per million.
    assert.ok(Math.abs(k.savedByCaching - (16_000 * 0.09) / 1e6) < 1e-9);
    assert.ok(Math.abs(k.listPriceUncached - (k.total + k.savedByBatch + k.savedByCaching)) < 1e-12);
    assert.deepEqual(k.cacheShare, { n: 16_000, of: 2_000 + 8_000 + 9_000 + 2_000 + 8_000 + 10_000 + 40_000, rate: 16_000 / 79_000 });
    assert.ok(Math.abs(k.perJobScored! - scoring / 3) < 1e-9, 'three jobs were scored for money');
    assert.ok(Math.abs(k.perTailoredVersion! - sonnet / 3) < 1e-9);
    assert.equal(k.perFormFilled, null, 'no form call was recorded');
    assert.deepEqual(k.byModel.map((m) => m.model), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']);
    assert.deepEqual(k.local, { calls: 2, inputTokens: 7_500, outputTokens: 280, hours: 12_000 / 3_600_000 });
    assert.equal(k.byPurpose[0]!.label, 'writing CVs and letters');
  });

  it('reports failed calls, call times and runs', () => {
    const { reliability: r } = caseStudy(seed().store, NOW);
    assert.deepEqual(r.calls, { n: 1, of: 9, rate: 1 / 9 });
    const draft = r.byPurpose.find((p) => p.label === 'writing CVs and letters')!;
    assert.deepEqual([draft.calls, draft.failed], [2, 1]);
    const replies = r.byPurpose.find((p) => p.label === 'reading replies to your applications')!;
    assert.deepEqual([replies.calls, replies.p50Ms, replies.p95Ms], [1, 3_000, 3_000]);
    assert.deepEqual(r.sourceFetches, { n: 1, of: 10, rate: 0.1 });
    assert.equal(r.scoreErrors, 2);
    assert.deepEqual(r.runs.find((x) => x.agent === 'tailor'), { agent: 'tailor', runs: 1, unfinished: 1, medianMinutes: null });
  });

  it('writes it up without naming a company, a job or a person', () => {
    const { store } = seed();
    const md = formatCaseStudy(caseStudy(store, NOW), [
      { suite: 'factcheck', title: 'Fact-check', ranAt: NOW.toISOString(), model: 'claude-sonnet-5-5', cases: 24, errors: 0, cost: 0.31, metrics: [{ label: 'Invented claims caught', count: { n: 11, of: 12, rate: 11 / 12 } }, { label: 'Median score', value: '71' }] },
    ]);
    for (const secret of ['Globex', 'Umbrella', 'Initech', 'Hooli', 'Soylent', 'Vandelay', 'Wonka', 'Secret Role', 'Berlin', 'hr@example.com', 'Dana', 'integrations work']) {
      assert.ok(!md.includes(secret), `the write-up mentions "${secret}"`);
    }
    assert.match(md, /^# Job Agents: the numbers/);
    assert.match(md, /\| Found by Scout, or added by you \| 8 \|/);
    assert.match(md, /\| Scored \| 5 \(100%\) \|/);
    assert.match(md, /\| Shortlisted \| 4 \(80%\) \|/);
    assert.match(md, /3 applications were sent/);
    assert.match(md, /; 1 callback: 1 of 3/);
    assert.match(md, /\| Chance a yes outscores a no \(AUC; 50% is a coin flip\) \| 75% \|/);
    assert.match(md, /\| Rewordings taken back by the fact-check \| 1 \|/);
    assert.match(md, /\| Greenhouse \| 2 \| 1 \|/);
    assert.match(md, /Source fetches that failed: 1 of 10 \(10%\)\*/);
    assert.match(md, /### Fact-check\n\n24 cases, run 2026-11-15 with claude-sonnet-5-5 for \$0\.310\./);
    assert.match(md, /\| Invented claims caught \| 11 of 12 \(92%\)\* \|/);
    // The JSON beside it carries the same counts and no more.
    assert.ok(!JSON.stringify(caseStudy(store, NOW)).match(/Globex|Secret Role|hr@example/));
  });

  it('says so when nothing has been recorded', () => {
    const md = formatCaseStudy(caseStudy(new JobStore(':memory:'), NOW));
    assert.match(md, /Nothing has been recorded yet/);
  });
});
