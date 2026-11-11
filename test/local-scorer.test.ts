import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compare, pickSample, type Pair } from '../src/llm/compare.ts';
import { ollamaModel } from '../src/llm/ollama.ts';
import { buildExamples, pickExamples } from '../src/llm/scorer.ts';
import type { JobRow, ScoreResult } from '../src/types.ts';
import { makeJob, makePrefs } from './helpers.ts';

const result = (score: number): ScoreResult => ({ score, verdict: 'good', seniorityFit: 'fit', matchReasons: [], gaps: ['No Go'], dealbreakers: [], summary: `Scored ${score}` });

describe('local scorer', () => {
  it('names local models "ollama:<model>"', () => {
    assert.equal(ollamaModel('ollama:gemma3:12b'), 'gemma3:12b');
    assert.equal(ollamaModel('claude-haiku-5-5'), null);
    assert.equal(ollamaModel(undefined), null);
  });

  it('picks examples across the whole score range and shows them shortened', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i * 5);
    assert.deepEqual(pickExamples(sorted, 5), [0, 25, 50, 70, 95]);
    assert.deepEqual(pickExamples([1, 2], 5), [1, 2]);
    const text = buildExamples([{ job: makeJob({ description: 'x'.repeat(5000) }), result: result(42) }]);
    assert.match(text, /"score":42/);
    assert.ok(text.length < 3000);
    assert.equal(buildExamples([]), '');
  });

  it("compares with Claude's decisions and finds the shift that lines them up", () => {
    const prefs = makePrefs({ scoring: { threshold: 65, maxJobsPerRun: 40, concurrency: 3, maxAttempts: 3 } });
    const pair = (claude: number, local: number): Pair => ({ job: { ...makeJob(), id: claude } as JobRow, claude: result(claude), local: result(local) });
    // The local model scores 10 lower across the board.
    const c = compare([pair(80, 70), pair(70, 60), pair(50, 40), pair(30, 20)], prefs);
    assert.equal(c.bias, -10);
    assert.equal(c.agreementUnshifted, 0.75);
    assert.equal(c.agreement, 1);
    assert.equal(c.shift, 5);
    assert.ok(c.correlation > 0.99);
  });

  it('samples jobs on both sides of the cutoff', () => {
    const prefs = makePrefs({ scoring: { threshold: 65, maxJobsPerRun: 40, concurrency: 3, maxAttempts: 3 } });
    const scored = Array.from({ length: 60 }, (_, i) => ({ job: { ...makeJob(), id: i } as JobRow, result: result(i < 45 ? 70 + (i % 20) : i - 25) }));
    const sample = pickSample(scored, new Set([0]), prefs, 10);
    assert.equal(sample.length, 10);
    assert.equal(sample.filter((s) => s.result.score >= 65).length, 5);
    assert.ok(!sample.some((s) => s.job.id === 0));
  });
});
