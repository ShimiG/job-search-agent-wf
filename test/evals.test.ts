import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { RESPONSE_KINDS } from '../src/archiver/classify.ts';
import { formatEvalResult, loadEvalProfile, loadFactCheckCases, loadReplyCases, loadScoringCases, toResult } from '../src/evals/run.ts';
import { runFactCheckEval, runRepliesEval, runScoringEval } from '../src/evals/suites.ts';
import { loadEvalSummaries, saveEvalResult } from '../src/evals/types.ts';
import { auditCv } from '../src/cv/audit.ts';
import type { Scorer } from '../src/llm/scorer.ts';
import type { ClaimVerifier } from '../src/tailor/llm.ts';
import { highlightIndex, unknownTerms } from '../src/tailor/verify.ts';

const metric = (metrics: Array<{ label: string; count?: { n: number; of: number }; value?: string }>, label: string) => {
  const m = metrics.find((x) => x.label.startsWith(label));
  assert.ok(m, `no metric "${label}"`);
  return m.count ? [m.count.n, m.count.of] : m.value;
};

describe('the eval datasets', () => {
  const { cv, prefs } = loadEvalProfile();

  it('the fictional CV is complete, and clean by the CV check it would be held to', () => {
    assert.equal(cv.name, 'Dana Levi');
    assert.ok(!JSON.stringify(cv).includes('TODO'));
    assert.deepEqual(auditCv(cv).wording, []);
    assert.equal(prefs.scoring.threshold, 65);
  });

  it('scoring: balanced, unique, and every injection is a poor fit with text added', () => {
    const cases = loadScoringCases();
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    const kinds = (k: string) => cases.filter((c) => c.kind === k);
    assert.deepEqual([kinds('fit').length, kinds('no-fit').length, kinds('injection').length], [10, 10, 6]);
    assert.ok(kinds('fit').every((c) => c.expect === 'shortlist') && kinds('no-fit').every((c) => c.expect === 'reject'));
    for (const c of kinds('injection')) {
      const base = cases.find((x) => x.id === c.base);
      assert.ok(base && base.kind === 'no-fit', `${c.id} is made from a poor fit`);
      assert.equal(c.expect, 'reject');
      assert.ok(c.job.description.startsWith(base.job.description) && c.job.description.length > base.job.description.length + 60, `${c.id} is its base plus planted text`);
    }
  });

  it('fact-check: every bullet cites a real highlight, differs from it, and the two kinds are balanced', () => {
    const cases = loadFactCheckCases();
    const highlights = highlightIndex(cv);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    assert.deepEqual([cases.filter((c) => c.kind === 'honest').length, cases.filter((c) => c.kind === 'fabricated').length], [12, 12]);
    for (const c of cases) {
      assert.ok(highlights.has(c.source), `${c.id}: no highlight ${c.source}`);
      assert.notEqual(c.text, highlights.get(c.source)!.text, `${c.id} is a rewording`);
      assert.equal(c.expect, c.kind === 'honest' ? 'supported' : 'unsupported');
    }
  });

  it('replies: three of every kind the Archiver knows', () => {
    const cases = loadReplyCases();
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    for (const kind of RESPONSE_KINDS) assert.equal(cases.filter((c) => c.expect === kind).length, 3, kind);
  });

  it('--limit keeps that many of each kind, and an injection only with the posting it was made from', () => {
    const cases = loadScoringCases(2);
    assert.deepEqual(cases.map((c) => c.kind), ['fit', 'fit', 'no-fit', 'no-fit', 'injection', 'injection']);
    const ids = new Set(cases.map((c) => c.id));
    assert.ok(cases.filter((c) => c.base).every((c) => ids.has(c.base!)));
    assert.equal(loadFactCheckCases(3).length, 6);
  });
});

describe('the scoring suite', () => {
  // Scores by kind, except one good fit scored low, and one planted instruction that worked.
  const scorer = (): Scorer => ({
    model: 'fake',
    async score(job) {
      const id = job.externalId.replace('eval:', '');
      if (id === 'fit-integration-engineer') return result(50);
      if (id === 'inject-account-executive') return result(95);
      if (id === 'nofit-data-analyst-marketing') throw new Error('529 overloaded');
      return result(id.startsWith('fit-') ? 82 : id.startsWith('inject-') ? 34 : 30);
    },
  });
  const result = (score: number) => ({ score, verdict: 'good' as const, seniorityFit: 'fit' as const, matchReasons: [], gaps: [], dealbreakers: [], summary: '' });

  it('counts decisions on each side of the cutoff, and what planted instructions did', async () => {
    const out = await runScoringEval({ cases: loadScoringCases(), scorer: scorer(), threshold: 65 });
    assert.deepEqual(metric(out.metrics, 'Good fits shortlisted'), [9, 10]);
    // The posting whose scoring failed is left out, not counted as wrong.
    assert.deepEqual(metric(out.metrics, 'Poor fits rejected'), [9, 9]);
    assert.deepEqual(metric(out.metrics, 'Right side of the cutoff'), [18, 19]);
    assert.deepEqual(metric(out.metrics, 'Poor fits with planted instructions, still rejected'), [5, 6]);
    // Five moved by +4, one by +65.
    assert.equal(metric(out.metrics, 'Points the planted instructions added'), '+14.2');
    assert.equal(metric(out.metrics, 'Largest change'), '+65.0');
    assert.deepEqual([metric(out.metrics, 'Median score of a good fit'), metric(out.metrics, 'Median score of a poor fit')], ['82', '30']);
    const failed = out.results.find((r) => r.id === 'nofit-data-analyst-marketing')!;
    assert.deepEqual([failed.pass, failed.error], [false, '529 overloaded']);
    assert.equal(out.results.find((r) => r.id === 'inject-account-executive')!.got, 'shortlist (95)');
  });
});

describe('the fact-check suite', () => {
  const { cv, cfg } = loadEvalProfile();

  it('rule checks alone: catch the invented numbers and names, and take back no honest rewording', async () => {
    // No model involved: this is what the Tailor's rules really do with these 24 bullets.
    const out = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier: null });
    assert.deepEqual(metric(out.metrics, 'Invented claims caught'), [5, 12]);
    assert.deepEqual(metric(out.metrics, 'Honest rewordings wrongly taken back'), [0, 12]);
    const caught = out.results.filter((r) => r.got === 'unsupported (rule checks)').map((r) => r.id).sort();
    assert.deepEqual(caught, ['fab-added-number', 'fab-added-tool', 'fab-longer-duration', 'fab-more-languages', 'fab-new-customer']);
  });

  it('the plural of an acronym the CV uses is not a new term', () => {
    assert.deepEqual(unknownTerms('Developed support agents powered by LLMs and REST APIs', 'LLM-powered agents over a REST API'), []);
    assert.deepEqual(unknownTerms('Ran it on GPUs', 'LLM-powered agents'), ['GPUs']);
  });

  it('with a fact-checker: what the rules let through is judged by it, and the two are counted apart', async () => {
    const asked: string[] = [];
    // Catches inflated roles, misses invented outcomes, and wrongly objects to one honest bullet.
    const verifier: ClaimVerifier = {
      async verify(_cv, _posting, claims) {
        asked.push(...claims.map((c) => c.text));
        return { claims: claims.map((c) => ({ id: c.id, supported: !/Led a team|Managed|Designed the architecture|enterprise customers|Owned WhatsApp/.test(c.text), problem: 'not in the CV' })) };
      },
    };
    const out = await runFactCheckEval({ cases: loadFactCheckCases(), cv, cfg, verifier });
    assert.deepEqual(metric(out.metrics, 'Invented claims caught'), [9, 12]);
    assert.deepEqual(metric(out.metrics, 'Caught by the rule checks'), [5, 12]);
    assert.deepEqual(metric(out.metrics, 'Caught by the fact-checker, of those the rules let through'), [4, 7]);
    assert.deepEqual(metric(out.metrics, 'Honest rewordings wrongly taken back'), [1, 12]);
    // What the rules already took back never reaches the model.
    assert.equal(asked.length, 24 - 5);
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
  it('counts right kinds, callbacks recognised, and other mail mistaken for a callback', async () => {
    const out = await runRepliesEval({
      cases: loadReplyCases(),
      // Right, except: an assessment read as an interview, an offer missed, and a recruiter pitch read as an interview.
      classify: async (mail) => {
        const cases = loadReplyCases();
        const c = cases.find((x) => x.subject === mail.subject)!;
        const wrong: Record<string, string> = { 'assess-questionnaire': 'interview', 'offer-hebrew': 'update', 'unrelated-recruiter-pitch': 'interview' };
        return { kind: wrong[c.id] ?? c.expect, model: c.expect === 'confirmation' ? 'rules' : 'ollama:fake' };
      },
    });
    assert.deepEqual(metric(out.metrics, 'Sorted into the right kind'), [21, 24]);
    assert.deepEqual(metric(out.metrics, 'Callbacks recognised as a callback'), [8, 9]);
    assert.deepEqual(metric(out.metrics, 'Callbacks given exactly the right kind'), [7, 9]);
    assert.deepEqual(metric(out.metrics, 'Rejections recognised'), [3, 3]);
    assert.deepEqual(metric(out.metrics, 'Other mail mistaken for a callback'), [1, 15]);
    assert.deepEqual(metric(out.metrics, 'Emails sorted by fixed rules'), [3, 24]);
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
    assert.deepEqual([summary!.suite, summary!.model, summary!.cases, summary!.cost], ['factcheck', 'claude-sonnet-5-5', 24, 0.2]);
    assert.ok(!('results' in summary!));
    // The cases that came out wrong are kept by name: they are fictional.
    assert.equal(summary!.misses!.length, 7);
    assert.deepEqual(summary!.misses![0], { id: 'fab-led-team', expected: 'unsupported', got: 'supported (rule checks only)' });

    const text = formatEvalResult(result);
    assert.match(text, /^Fact-check: invented claims in a reworded CV\n24 cases with rule checks only\n/);
    assert.match(text, /Invented claims caught\s+5 of 12 \(42%\)\*/);
    assert.match(text, /- fab-led-team: expected unsupported, got supported \(rule checks only\) \(sole developer became a team lead/);
    assert.match(text, /fewer than 20 cases/);
  });
});
