import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RESPONSE_KINDS } from '../src/archiver/classify.ts';
import { formatComparison, formatComparisons, loadComparisons } from '../src/evals/compare.ts';
import { PreferencesSchema } from '../src/config.ts';
import { JobStore } from '../src/db/store.ts';
import { formatEvalResult, loadDecisionCases, loadEvalProfile, loadFactCheckCases, loadReplyCases, loadScoringCases, toResult } from '../src/evals/run.ts';
import { runDecisionsEval, runFactCheckEval, runRepliesEval, runScoringEval } from '../src/evals/suites.ts';
import { markSubmitted } from '../src/submit/run.ts';
import { makeJob } from './helpers.ts';
import { loadEvalSummaries, saveEvalResult } from '../src/evals/types.ts';
import { auditCv } from '../src/cv/audit.ts';
import type { Scorer } from '../src/llm/scorer.ts';
import { auc } from '../src/report/metrics.ts';
import type { ClaimVerifier } from '../src/tailor/llm.ts';
import { highlightIndex, unknownTerms } from '../src/tailor/verify.ts';

const metric = (metrics: Array<{ label: string; count?: { n: number; of: number }; value?: string }>, label: string) => {
  const m = metrics.find((x) => x.label.startsWith(label));
  assert.ok(m, `no metric "${label}"`);
  return m.count ? [m.count.n, m.count.of] : m.value;
};
const tally = (items: Array<{ kind: string }>) => Object.fromEntries([...new Set(items.map((c) => c.kind))].map((k) => [k, items.filter((c) => c.kind === k).length]));

describe('the eval datasets', () => {
  const { cv, prefs } = loadEvalProfile();

  it('the fictional CV is complete, and clean by the CV check it would be held to', () => {
    assert.equal(cv.name, 'Dana Levi');
    assert.ok(!JSON.stringify(cv).includes('TODO'));
    assert.deepEqual(auditCv(cv).wording, []);
    assert.deepEqual([prefs.scoring.threshold, prefs.scoring.partialThreshold], [65, 55]);
  });

  it('scoring: every kind has its cases, and each kind expects what it says', () => {
    const cases = loadScoringCases();
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    assert.deepEqual(tally(cases), { fit: 10, 'no-fit': 10, injection: 10, trap: 6, disguised: 6, dealbreaker: 6, 'soft-gap': 4, partial: 6 });
    const expects = (kind: string) => [...new Set(cases.filter((c) => c.kind === kind).map((c) => c.expect))];
    for (const kind of ['fit', 'disguised', 'soft-gap']) assert.deepEqual(expects(kind), ['shortlist'], kind);
    for (const kind of ['no-fit', 'trap', 'dealbreaker', 'injection']) assert.deepEqual(expects(kind), ['reject'], kind);
    // A title and one line, as an alert gives it: three to shortlist, three to reject, and only these are partial.
    assert.deepEqual(expects('partial').sort(), ['reject', 'shortlist']);
    assert.ok(cases.every((c) => Boolean(c.partial) === (c.kind === 'partial')));
  });

  it('scoring: every injection is a posting to reject with text added', () => {
    const cases = loadScoringCases();
    for (const c of cases.filter((x) => x.kind === 'injection')) {
      const base = cases.find((x) => x.id === c.base);
      assert.ok(base && base.expect === 'reject' && base.kind !== 'injection', `${c.id} is made from a posting to reject`);
      assert.ok(c.job.description.startsWith(base.job.description) && c.job.description.length > base.job.description.length + 60, `${c.id} is its base plus planted text`);
    }
  });

  it('fact-check: every bullet cites a real highlight, differs from it, and the four kinds are balanced', () => {
    const cases = loadFactCheckCases();
    const highlights = highlightIndex(cv);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    assert.deepEqual(tally(cases), { honest: 12, fabricated: 12, reworded: 12, subtle: 12 });
    for (const c of cases) {
      assert.ok(highlights.has(c.source), `${c.id}: no highlight ${c.source}`);
      assert.notEqual(c.text, highlights.get(c.source)!.text, `${c.id} is a rewording`);
      assert.equal(c.expect, c.kind === 'honest' || c.kind === 'reworded' ? 'supported' : 'unsupported');
    }
  });

  it('replies: three plain emails of every kind the Archiver knows, and the harder ones marked', () => {
    const cases = loadReplyCases();
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    for (const kind of RESPONSE_KINDS) assert.equal(cases.filter((c) => !c.hard && c.expect === kind).length, 3, kind);
    assert.equal(cases.filter((c) => c.hard).length, 14);
    const planted = cases.filter((c) => c.planted);
    assert.equal(planted.length, 2);
    assert.ok(planted.every((c) => c.hard && c.expect === 'not_related'));
  });

  it('--limit keeps that many of each kind, and an injection only with the posting it was made from', () => {
    const cases = loadScoringCases(2);
    assert.deepEqual(tally(cases), { fit: 2, 'no-fit': 2, injection: 2, trap: 2, disguised: 2, dealbreaker: 2, 'soft-gap': 2, partial: 2 });
    const ids = new Set(cases.map((c) => c.id));
    assert.ok(cases.filter((c) => c.base).every((c) => ids.has(c.base!)));
    assert.equal(loadFactCheckCases(3).length, 12);
  });
});

describe('the scoring suite', () => {
  const result = (score: number) => ({ score, verdict: 'good' as const, seniorityFit: 'fit' as const, matchReasons: [], gaps: [], dealbreakers: [], summary: '' });
  // A scorer that matches words: right on the easy kinds, fooled by most traps, blind to most disguised fits.
  const byWords: Record<string, number> = { fit: 82, 'no-fit': 30, trap: 70, disguised: 50, dealbreaker: 30, 'soft-gap': 80 };
  const special: Record<string, number> = { 'trap-sap-integration': 40, 'disguised-junior-backend-node': 75, 'disguised-solutions-developer-low-code': 75, 'inject-account-executive': 95 };
  const cases = loadScoringCases();
  const scoreOf = (id: string): number => {
    if (id in special) return special[id]!;
    const c = cases.find((x) => x.id === id)!;
    if (c.kind === 'injection') return scoreOf(c.base!) + 4;
    if (c.kind === 'partial') return c.expect === 'shortlist' ? 60 : 20;
    return byWords[c.kind]!;
  };
  const scorer: Scorer = {
    model: 'fake',
    async score(job) {
      const id = job.externalId.replace('eval:', '');
      if (id === 'nofit-data-analyst-marketing') throw new Error('529 overloaded');
      return result(scoreOf(id));
    },
  };

  it('reports each kind on its own line, so a scorer that only matches words shows where it fails', async () => {
    const partialSeen: boolean[] = [];
    const out = await runScoringEval({ cases, scorer: { ...scorer, score: async (job) => (partialSeen.push(job.descriptionIsPartial), scorer.score(job)) }, threshold: 65, partialThreshold: 55 });
    assert.deepEqual(metric(out.metrics, 'Good fits shortlisted'), [10, 10]);
    // The posting whose scoring failed is left out, not counted as wrong.
    assert.deepEqual(metric(out.metrics, 'Poor fits rejected'), [9, 9]);
    assert.deepEqual(metric(out.metrics, 'Keyword traps rejected'), [1, 6]);
    assert.deepEqual(metric(out.metrics, 'Disguised fits shortlisted'), [2, 6]);
    assert.deepEqual(metric(out.metrics, 'Right work with one firm disqualifier'), [6, 6]);
    assert.deepEqual(metric(out.metrics, 'Right work missing only nice-to-haves'), [4, 4]);
    assert.deepEqual(metric(out.metrics, 'The harder postings'), [13, 22]);
    assert.deepEqual(metric(out.metrics, 'Right side of the cutoff'), [38, 47]);
    // A title and one line is judged against the lower cutoff: 60 is a shortlist there, and it is scored as partial.
    assert.deepEqual(metric(out.metrics, 'Title-and-one-line postings'), [6, 6]);
    assert.equal(partialSeen.filter(Boolean).length, 6);
    assert.equal(metric(out.metrics, 'Cutoff'), '65 (55 for a title and one line)');
    assert.equal(out.results.find((r) => r.id === 'partial-fit-ai-agent-developer')!.got, 'shortlist (60)');

    // Planted text: +4 on nine, +65 on one. Three of the traps it was added to were already over the cutoff.
    assert.deepEqual(metric(out.metrics, 'Postings with planted instructions, still rejected'), [6, 10]);
    assert.equal(metric(out.metrics, 'Points the planted instructions added'), '+10.1');
    assert.equal(metric(out.metrics, 'Largest change'), '+65.0');

    // Ranking, over full postings: how often one to shortlist outscores one to reject.
    const shortlist = [...Array(10).fill(82), ...Array(4).fill(50), 75, 75, ...Array(4).fill(80)];
    const reject = [...Array(9).fill(30), ...Array(5).fill(70), 40, ...Array(6).fill(30)];
    assert.equal(metric(out.metrics, 'Chance a posting to shortlist outscores one to reject'), `${Math.round(auc(shortlist, reject)! * 100)}%`);
    assert.deepEqual([metric(out.metrics, 'Median score of a posting to shortlist'), metric(out.metrics, 'Median score of a posting to reject')], ['81', '30']);
    const failed = out.results.find((r) => r.id === 'nofit-data-analyst-marketing')!;
    assert.deepEqual([failed.pass, failed.error], [false, '529 overloaded']);
  });

  it('without a partial cutoff, a title and one line is held to the same cutoff as the rest', async () => {
    const out = await runScoringEval({ cases: cases.filter((c) => c.kind === 'partial'), scorer, threshold: 65 });
    assert.deepEqual(metric(out.metrics, 'Title-and-one-line postings'), [3, 6]);
    assert.equal(metric(out.metrics, 'Cutoff'), '65');
  });
});

describe('the fact-check suite', () => {
  const { cv, cfg } = loadEvalProfile();

  it('rule checks alone: catch the invented numbers and names, none of the subtle ones, and take back no honest rewording', async () => {
    // No model involved: this is what the Tailor's rules really do with these 48 bullets.
    const out = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier: null });
    assert.deepEqual(metric(out.metrics, 'Invented claims caught'), [5, 24]);
    assert.deepEqual(metric(out.metrics, 'Plain inventions caught'), [5, 12]);
    // By design: a subtle invention has no number or name for a rule to see. Only the fact-checker can catch it.
    assert.deepEqual(metric(out.metrics, 'Subtle inventions caught'), [0, 12]);
    assert.deepEqual(metric(out.metrics, 'Honest rewordings wrongly taken back'), [0, 24]);
    assert.deepEqual(metric(out.metrics, 'Of the freely reworded ones'), [0, 12]);
    const caught = out.results.filter((r) => r.got === 'unsupported (rule checks)').map((r) => r.id).sort();
    assert.deepEqual(caught, ['fab-added-number', 'fab-added-tool', 'fab-longer-duration', 'fab-more-languages', 'fab-new-customer']);
  });

  it('the plural of an acronym the CV uses is not a new term', () => {
    assert.deepEqual(unknownTerms('Developed support agents powered by LLMs and REST APIs', 'LLM-powered agents over a REST API'), []);
    assert.deepEqual(unknownTerms('Ran it on GPUs', 'LLM-powered agents'), ['GPUs']);
    // And the other way round: the CV has the plural, the letter the singular.
    assert.deepEqual(unknownTerms('I track one KPI per LLM feature', 'Reported KPIs for features built on LLMs'), []);
    assert.deepEqual(unknownTerms('I read many CVs', 'nothing about that word here'), []);
  });

  it('a hyphenated word is as new as the names in it', () => {
    const text = 'Built agents with the Claude API and RAG pipelines on AWS. Developed AI tools for Windows desktops in 2023.';
    // What a real set of cover letters was flagged for: none of it claims anything this CV doesn't say.
    const letter = 'I build Claude-based agents and RAG-style retrieval, AWS-native where it helps, with a Windows-focused past. Since mid-2023 my CV has been AI-reworded for each job.';
    assert.deepEqual(unknownTerms(letter, text), []);
    // The name inside the compound still has to be yours.
    assert.deepEqual(unknownTerms('I build Kubernetes-based platforms and Azure-native services', text), ['Kubernetes-based', 'Azure-native']);
    assert.deepEqual(unknownTerms('I deployed it with Node-RED on GPT-4.1', 'Built flows in Node.js on GPT-4'), ['Node-RED']);
    // A term found in the posting counts as known for a letter, as before.
    assert.deepEqual(unknownTerms('Your Terraform-heavy stack', text, 'We use Terraform'), []);
  });

  it('with a fact-checker: what the rules let through is judged by it, and plain and subtle are counted apart', async () => {
    const asked: string[] = [];
    // Catches bigger roles and a few subtle ones, misses invented outcomes, and wrongly objects to one honest bullet.
    const verifier: ClaimVerifier = {
      async verify(_cv, _posting, claims) {
        asked.push(...claims.map((c) => c.text));
        const no = /Led a team|Managed|Designed the architecture|enterprise customers|Owned WhatsApp|Spearheaded|fine-tuned|hundreds of people|on call/;
        return { claims: claims.map((c) => ({ id: c.id, supported: !no.test(c.text), problem: 'not in the CV' })) };
      },
    };
    const out = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier });
    assert.deepEqual(metric(out.metrics, 'Invented claims caught'), [13, 24]);
    assert.deepEqual(metric(out.metrics, 'Plain inventions caught'), [9, 12]);
    assert.deepEqual(metric(out.metrics, 'Subtle inventions caught'), [4, 12]);
    assert.deepEqual(metric(out.metrics, 'Caught by the rule checks'), [5, 24]);
    assert.deepEqual(metric(out.metrics, 'Caught by the fact-checker, of those the rules let through'), [8, 19]);
    assert.deepEqual(metric(out.metrics, 'Honest rewordings wrongly taken back'), [1, 24]);
    assert.deepEqual(metric(out.metrics, 'Of the freely reworded ones'), [0, 12]);
    // What the rules already took back never reaches the model.
    assert.equal(asked.length, 48 - 5);
    assert.ok(!asked.some((t) => t.includes('Kubernetes')));
  });

  it('a fact-checker that fails, or skips a claim, is an error and not a verdict', async () => {
    const verifier: ClaimVerifier = {
      async verify(_cv, _posting, claims) {
        if (claims[0]!.text.includes('ES5')) throw new Error('timeout');
        return { claims: [] };
      },
    };
    const out = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier });
    assert.equal(out.results.find((r) => r.id === 'honest-es5')!.error, 'timeout');
    assert.match(out.results.find((r) => r.id === 'honest-booking')!.error!, /no verdict/);
    // Only the five the rules settled could be counted.
    assert.deepEqual(metric(out.metrics, 'Invented claims caught'), [5, 5]);
  });
});

describe('the replies suite', () => {
  it('counts right kinds, callbacks recognised, the harder emails and planted instructions', async () => {
    const cases = loadReplyCases();
    // Right, except: an assessment read as an interview, an offer missed, a recruiter pitch read as an interview,
    // a request inside a receipt filed as a receipt, and a planted instruction obeyed.
    const wrong: Record<string, string> = {
      'assess-questionnaire': 'interview',
      'offer-hebrew': 'update',
      'unrelated-recruiter-pitch': 'interview',
      'hard-assessment-inside-receipt': 'confirmation',
      'hard-planted-offer-in-digest': 'offer',
    };
    const out = await runRepliesEval({
      cases,
      classify: async (_mail, body) => {
        const c = cases.find((x) => x.body === body)!;
        return { kind: wrong[c.id] ?? c.expect, model: c.expect === 'confirmation' ? 'rules' : 'ollama:fake' };
      },
    });
    assert.deepEqual(metric(out.metrics, 'Sorted into the right kind'), [33, 38]);
    assert.deepEqual(metric(out.metrics, 'The harder emails sorted right'), [12, 14]);
    assert.deepEqual(metric(out.metrics, 'Unrelated mail with planted instructions'), [1, 2]);
    assert.deepEqual(metric(out.metrics, 'Callbacks recognised as a callback'), [12, 14]);
    assert.deepEqual(metric(out.metrics, 'Callbacks given exactly the right kind'), [11, 14]);
    assert.deepEqual(metric(out.metrics, 'Rejections recognised'), [6, 6]);
    assert.deepEqual(metric(out.metrics, 'Other mail mistaken for a callback'), [2, 24]);
    assert.deepEqual(metric(out.metrics, 'Emails sorted by fixed rules'), [4, 38]);
  });
});

describe('eval results', () => {
  it('are saved as the latest of their suite with a dated copy, and read back without the per-case detail', async () => {
    const { cv, cfg } = loadEvalProfile();
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'evals-')), 'evals');
    assert.deepEqual(loadEvalSummaries(dir), []);
    const output = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier: null });
    const result = toResult('factcheck', 'rule checks only', output, 0, new Date('2026-11-15T10:00:00Z'));
    assert.equal(saveEvalResult(dir, result), path.join(dir, 'factcheck.json'));
    saveEvalResult(dir, { ...result, ranAt: '2026-11-16T10:00:00.000Z', model: 'claude-sonnet-5-5', cost: 0.2 });
    const [summary, ...rest] = loadEvalSummaries(dir);
    assert.equal(rest.length, 0, 'one entry per suite: the latest');
    assert.deepEqual([summary!.suite, summary!.model, summary!.cases, summary!.cost], ['factcheck', 'claude-sonnet-5-5', 48, 0.2]);
    assert.ok(!('results' in summary!));
    // The cases that came out wrong are kept by name: they are fictional.
    assert.equal(summary!.misses!.length, 19);
    assert.deepEqual(summary!.misses![0], { id: 'fab-led-team', expected: 'unsupported', got: 'supported (rule checks only)' });

    const text = formatEvalResult(result);
    assert.match(text, /^Fact-check: invented claims in a reworded CV\n48 cases with rule checks only\n/);
    assert.match(text, /Invented claims caught\s+5 of 24 \(21%\)\n/);
    assert.match(text, /Subtle inventions caught[^\n]+0 of 12 \(0%\)\*/);
    assert.match(text, /- fab-led-team: expected unsupported, got supported \(rule checks only\) \(sole developer became a team lead/);
    assert.match(text, /fewer than 20 cases/);
  });

  it('compare: each model\'s latest run of a suite side by side, leaving out runs over an older case set', async () => {
    const { cv, cfg } = loadEvalProfile();
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'evals-')), 'evals');
    assert.deepEqual(loadComparisons(dir), []);
    assert.match(formatComparisons([]), /^Nothing to compare yet/);

    const output = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier: null });
    const run = (model: string, ranAt: string, over: object = {}) => saveEvalResult(dir, { ...toResult('factcheck', model, output, 0.05, new Date(ranAt)), ...over });
    run('claude-haiku-5-5', '2026-11-10T10:00:00Z', { cases: 24 }); // before the cases were added
    run('claude-haiku-5-5', '2026-11-16T10:00:00Z');
    run('claude-sonnet-5-5', '2026-11-15T10:00:00Z');
    run('claude-sonnet-5-5', '2026-11-17T10:00:00Z', { cost: 0.31 });
    run('claude-opus-5-5', '2026-11-12T10:00:00Z', { cases: 24 });

    const [c, ...others] = loadComparisons(dir);
    assert.equal(others.length, 0);
    // Newest first; one per model; the 24-case runs are not comparable with the 48-case ones.
    assert.deepEqual(c!.runs.map((r) => [r.model, r.ranAt.slice(0, 10), r.cases]), [['claude-sonnet-5-5', '2026-11-17', 48], ['claude-haiku-5-5', '2026-11-16', 48]]);
    const table = formatComparison(c!).join('\n');
    assert.match(table, /^\| Measure \| claude-sonnet-5-5 \| claude-haiku-5-5 \|\n\|---\|---:\|---:\|/);
    assert.match(table, /\| Invented claims caught \| 5 of 24 \(21%\) \| 5 of 24 \(21%\) \|/);
    assert.match(table, /\| Cost of the run \| \$0\.310 \| \$0\.050 \|/);
    assert.match(formatComparisons([c!]), /^Fact-check: invented claims in a reworded CV\n\n\| Measure/);
    assert.match(table, /\| Cases \| 48 \| 48 \|/);
    // One model alone is nothing to compare.
    assert.deepEqual(formatComparison({ ...c!, runs: c!.runs.slice(0, 1) }), []);
  });
});

describe('the decisions suite: your own picks and dismissals, re-scored', () => {
  const now = '2026-11-01T09:00:00.000Z';
  const prefs = PreferencesSchema.parse({ ...loadEvalProfile().prefs, scoring: { ...loadEvalProfile().prefs.scoring, threshold: 65, partialThreshold: 55 } });
  const result = (score: number) => ({ score, verdict: 'good' as const, seniorityFit: 'fit' as const, matchReasons: [], gaps: [], dealbreakers: [], summary: '' });

  /** Six scored jobs: what the score was, whether it was shortlisted, and what you did with it. */
  function seed() {
    const store = new JobStore(':memory:');
    const add = (name: string, score: number, did: 'pick' | 'dismiss' | 'apply' | 'nothing', partial = false) => {
      const id = store.upsert(makeJob({ externalId: `x:${name}`, company: name, descriptionIsPartial: partial }), now).id;
      const listed = score >= (partial ? 55 : 65);
      store.saveScore(id, result(score), listed ? 'shortlisted' : 'low_score', now, 'claude-haiku-5-5');
      store.setStatus(id, listed ? 'shortlisted' : 'low_score', null, 'scout', now);
      if (did === 'pick') store.setStatus(id, 'selected', null, 'user', now);
      if (did === 'dismiss') store.setStatus(id, 'dismissed', null, 'user', now);
      if (did === 'apply') markSubmitted(store, id, null, new Date(now));
      return id;
    };
    return { store, ids: { a: add('A', 80, 'pick'), b: add('B', 70, 'dismiss'), c: add('C', 58, 'apply', true), d: add('D', 66, 'dismiss'), e: add('E', 40, 'dismiss'), f: add('F', 90, 'nothing') } };
  }

  it('takes the jobs you decided on from your shortlist, each with its own cutoff; --all adds the rest', () => {
    const { store, ids } = seed();
    const cases = loadDecisionCases(store, prefs);
    // Newest first. E was never shortlisted; F was never decided on.
    assert.deepEqual(cases.map((c) => [c.id, c.decision, c.cutoff, c.storedScore]), [[ids.d, 'no', 65, 66], [ids.c, 'yes', 55, 58], [ids.b, 'no', 65, 70], [ids.a, 'yes', 65, 80]]);
    assert.deepEqual(loadDecisionCases(store, prefs, { all: true }).map((c) => c.id), [ids.e, ids.d, ids.c, ids.b, ids.a]);
    assert.deepEqual(loadDecisionCases(store, prefs, { limit: 1 }).map((c) => c.id), [ids.d, ids.c]);
  });

  it('measures new scores against your decisions, beside the scores given at the time', async () => {
    const { store, ids } = seed();
    const cases = loadDecisionCases(store, prefs);
    // A better scorer than the one that scored them: your picks up, your dismissals down. One job fails to score.
    const fresh: Record<number, number> = { [ids.a]: 85, [ids.b]: 60, [ids.c]: 62 };
    const out = await runDecisionsEval({
      cases,
      scorer: { model: 'fake', async score(job) {
        const c = cases.find((x) => x.job.externalId === job.externalId)!;
        if (c.id === ids.d) throw new Error('529 overloaded');
        return result(fresh[c.id]!);
      } },
    });
    assert.equal(metric(out.metrics, 'Jobs re-scored'), '2 you picked, 1 you dismissed');
    // New scores: picks 85 and 62 against a dismissal at 60. At the time: 80 and 58 against 70.
    assert.equal(metric(out.metrics, 'Chance a job you picked outscores one you dismissed'), '100%');
    assert.equal(metric(out.metrics, 'The same, with the scores these jobs were given at the time'), '50%');
    assert.deepEqual(metric(out.metrics, 'Jobs you picked, scored at or above the cutoff'), [2, 2]);
    assert.deepEqual(metric(out.metrics, 'Jobs you dismissed, scored at or above the cutoff'), [0, 1]);
    assert.deepEqual(metric(out.metrics, 'Share of that shortlist you would pick'), [2, 2]);
    assert.equal(metric(out.metrics, 'Average change from the score given at the time'), '6.3 points');
    const failed = out.results.find((r) => r.id === `#${ids.d}`)!;
    assert.deepEqual([failed.error, failed.pass], ['529 overloaded', false]);
    // Nothing was written back: the jobs keep the scores they had.
    assert.deepEqual([store.get(ids.a)!.score, store.get(ids.b)!.score], [80, 70]);
  });

  it('its results name no job in a report, and compare across runs with a job or two more', async () => {
    const { store } = seed();
    const cases = loadDecisionCases(store, prefs);
    const scorer = { model: 'fake', score: async () => result(70) };
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'evals-')), 'evals');
    const first = toResult('decisions', 'claude-haiku-5-5', await runDecisionsEval({ cases, scorer }), 0.02, new Date('2026-11-16T10:00:00Z'));
    saveEvalResult(dir, first);
    saveEvalResult(dir, { ...toResult('decisions', 'claude-haiku-5-5+advisor:claude-opus-5-5', await runDecisionsEval({ cases: cases.slice(0, 3), scorer }), 0.4, new Date('2026-11-16T11:00:00Z')) });
    const [summary] = loadEvalSummaries(dir);
    assert.deepEqual(summary!.misses, []);
    assert.match(summary!.about!, /^Not a fixed test set: these are jobs you picked or dismissed/);
    const text = formatEvalResult(first);
    assert.match(text, /Your own decisions, re-scored\n4 cases with claude-haiku-5-5, \$0\.020\nNot a fixed test set/);
    assert.ok(!text.includes('Wrong:'));
    // 3 cases against 4: still compared, with the count shown.
    const [c] = loadComparisons(dir);
    assert.deepEqual(c!.runs.map((r) => r.cases), [3, 4]);
    assert.match(formatComparison(c!).join('\n'), /\| Cases \| 3 \| 4 \|/);
  });
});
