import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MasterCvSchema } from '../src/config.ts';
import { JobStore } from '../src/db/store.ts';
import { CostMeter, formatDollars, usageCost, withJob } from '../src/llm/cost.ts';
import { enrichCost } from '../src/llm/enrich.ts';
import { AnthropicScorer, createScorer } from '../src/llm/scorer.ts';
import { formatRunStats } from '../src/output/report.ts';
import { runScout } from '../src/pipeline/run.ts';
import { formatSpendingReport, spendingReport } from '../src/pipeline/spending.ts';
import { markSubmitted } from '../src/submit/run.ts';
import { AnthropicTailor } from '../src/tailor/llm.ts';
import type { JobRow, NormalizedJob } from '../src/types.ts';
import { silentLogger } from '../src/util/logger.ts';
import { fakeHttp, jsonFixture, makeJob, makePrefs, NOW } from './helpers.ts';
import { exampleTailorConfig, sampleDraft } from './tailor-helpers.ts';

const cv = MasterCvSchema.parse(jsonFixture('master-cv.json'));
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe('pricing', () => {
  it('prices each kind of token at its model rate', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 400_000 };
    close(usageCost('claude-sonnet-5-5', usage), 2 + 1 + 0.2 + 1); // $2 in, $10 out, $0.10 read, $2.50 write per million
    close(usageCost('claude-opus-5-5', usage), 4 + 2 + 0.4 + 2);
    close(usageCost('claude-fable-5-2', usage), 8 + 4 + 0.4 + 4);
  });

  it('charges Haiku 5.5 more for prompts over 100K tokens, and web searches on top', () => {
    close(usageCost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1_000 }), 0.005 + 0.0005);
    close(usageCost('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 1_000 }), 0.1 + 0.0025);
    close(usageCost('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3, web_fetch_requests: 5 } }), 0.03);
  });

  it('prices an unknown model as Sonnet 5.5, and lookups by the model that ran them', () => {
    close(usageCost('some-future-model', { input_tokens: 1_000_000, output_tokens: 0 }), 2);
    const lookup = { inputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000, searches: 2, fetches: 3 };
    close(enrichCost(lookup), 0.2 + 0.1 + 0.02);
    close(enrichCost({ ...lookup, model: 'claude-haiku-5-5' }), 0.01 + 0.005 + 0.02);
  });

  it('formats small amounts honestly', () => {
    assert.deepEqual([0, 0.004, 0.126, 12].map(formatDollars), ['$0', '<$0.01', '$0.13', '$12.00']);
  });
});

describe('cost meter', () => {
  const usage = { input_tokens: 10_000, output_tokens: 1_000 }; // 3 cents on Sonnet 5.5

  it('holds calls until a run attaches it, then stores each with its run and job', async () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsert(makeJob(), NOW.toISOString());
    const meter = new CostMeter('tailor', () => NOW);
    await withJob(id, async () => {
      meter.record('draft', 'claude-sonnet-5-5', usage);
    });
    const runId = store.startRun('tailor', NOW.toISOString());
    meter.attach(store, runId);
    meter.record('fact-check', 'claude-sonnet-5-5', usage, id);
    meter.record('cv', 'claude-sonnet-5-5', usage);
    const rows = store.db.prepare('SELECT purpose, job_id, run_id, agent, cost FROM usage ORDER BY id').all();
    assert.deepEqual(rows, [
      { purpose: 'draft', job_id: id, run_id: runId, agent: 'tailor', cost: 0.03 },
      { purpose: 'fact-check', job_id: id, run_id: runId, agent: 'tailor', cost: 0.03 },
      { purpose: 'cv', job_id: null, run_id: runId, agent: 'tailor', cost: 0.03 },
    ]);
    close(store.usageForJob(id), 0.06);
    close(meter.totals().total, 0.09);
    assert.deepEqual(Object.keys(meter.totals().byPurpose), ['draft', 'fact-check', 'cv']);
  });

  it('records what the scorer and the Tailor spend, per job', async () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsert(makeJob(), NOW.toISOString());
    const meter = new CostMeter('scout');
    meter.attach(store);
    const score = { score: 80, seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: 'ok' };
    const scorer = new AnthropicScorer({
      cv,
      prefs: makePrefs(),
      meter,
      client: { messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: score, usage }) } } as never,
    });
    await scorer.score(store.get(id)!);

    const tailor = new AnthropicTailor({ meter, client: { messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: sampleDraft(), usage }) } } as never });
    await withJob(id, () => tailor.draft({ job: store.get(id)!, cv, cfg: exampleTailorConfig(), cvLanguage: 'en', letterLanguage: 'en', feedback: null }));
    assert.deepEqual(
      store.db.prepare('SELECT purpose, job_id, model FROM usage ORDER BY id').all(),
      [
        { purpose: 'score', job_id: id, model: 'claude-sonnet-5-5' },
        { purpose: 'draft', job_id: id, model: 'claude-sonnet-5-5' },
      ],
    );
  });

  it("prices the advisor's part of a score at the advisor's rate, and a local model at nothing", async () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsert(makeJob(), NOW.toISOString());
    const meter = new CostMeter('scout');
    meter.attach(store);
    const reply = {
      stop_reason: 'end_turn',
      parsed_output: { score: 70, seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: 'ok' },
      usage: { input_tokens: 100_000, output_tokens: 0, iterations: [{ type: 'message', input_tokens: 100_000, output_tokens: 0 }, { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 100_000, output_tokens: 0 }] },
    };
    const client = { messages: { parse: async () => reply }, beta: { messages: { parse: async () => reply } } };
    const scorer = new AnthropicScorer({ cv, prefs: makePrefs(), model: 'claude-haiku-5-5', advisor: 'claude-opus-5-5', meter, client: client as never });
    await scorer.score(store.get(id)!);
    assert.deepEqual(store.db.prepare('SELECT model, cost FROM usage ORDER BY id').all(), [
      { model: 'claude-haiku-5-5', cost: 0.01 },
      { model: 'claude-opus-5-5', cost: 0.4 },
    ]);

    const local = createScorer({ cv, prefs: makePrefs(), model: 'ollama:gemma3:12b', meter });
    assert.equal(local.model, 'ollama:gemma3:12b', 'a local scorer never touches the meter');
  });

    it("puts a Scout run's cost in its stats and summary", async () => {
    const store = new JobStore(':memory:');
    const meter = new CostMeter('scout');
    const scorer = {
      async score(job: NormalizedJob) {
        meter.record('score', 'claude-sonnet-5-5', usage, (job as JobRow).id);
        return { score: 90, verdict: 'strong' as const, seniorityFit: 'fit' as const, matchReasons: [], gaps: [], dealbreakers: [], summary: '' };
      },
    };
    const board = { key: 'greenhouse:acme', kind: 'greenhouse' as const, fetchJobs: async () => [makeJob(), makeJob({ externalId: 'acme:2', title: 'Integration Engineer' })] };
    const stats = await runScout({ store, adapters: [board], http: fakeHttp({}), prefs: makePrefs(), logger: silentLogger, scorer, meter, clock: () => NOW, checkPage: async () => 'unknown' });
    close(stats.cost.total, 0.06);
    assert.match(formatRunStats(stats), /Cost: about \$0\.06 this run/);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE run_id IS NOT NULL').get() as { n: number }).n, 2);
  });
});

describe('spending report', () => {
  it('shows totals, the last 30 days by purpose, and the all-in cost per application and callback', () => {
    const store = new JobStore(':memory:');
    const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);
    assert.match(formatSpendingReport(spendingReport(store, NOW)), /nothing recorded yet/);

    const apply = (externalId: string, company: string, daysAgo: number) => {
      const { id } = store.upsert(makeJob({ externalId, company }), NOW.toISOString());
      markSubmitted(store, id, null, at(daysAgo));
      return id;
    };
    apply('old:1', 'Before Tracking', 80);
    const a = apply('a:1', 'Grain', 30);
    apply('b:1', 'Beta', 20);
    // A reply the Archiver filed under the Grain application.
    store.saveResponse(
      { messageId: '<k@grain>', jobId: a, receivedAt: at(10).toISOString(), fromName: 'Grain', fromAddress: 'x@grain.co', subject: 'Interview', kind: 'interview', company: 'Grain', title: '', summary: 'Invited to interview', action: '', model: 'test' },
      NOW.toISOString(),
    );

    for (const [purpose, dollars, daysAgo, jobId] of [['score', 1, 60, null], ['score', 0.5, 10, null], ['draft', 0.5, 5, a]] as const) {
      const meter = new CostMeter('scout', () => at(daysAgo));
      meter.attach(store);
      meter.record(purpose, 'claude-sonnet-5-5', { input_tokens: dollars * 500_000, output_tokens: 0 }, jobId);
    }

    const r = spendingReport(store, NOW);
    close(r.total, 2);
    close(r.last30Days, 1);
    assert.deepEqual(r.byPurpose.map((p) => [p.label, p.calls]), [['scoring jobs', 1], ['writing CVs and letters', 1]]);
    assert.deepEqual([r.applications, r.callbacks], [2, 1], 'the application sent before tracking began is left out');
    close(r.perApplication!, 1);
    close(r.perCallback!, 2);
    const text = formatSpendingReport(r);
    assert.match(text, /about \$2\.00 \(\$1\.00 in the last 30 days\)/);
    assert.match(text, /About \$1\.00 per application sent \(2\), \$2\.00 per callback \(1\)/);
  });
});
