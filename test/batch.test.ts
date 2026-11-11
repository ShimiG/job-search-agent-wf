import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MasterCvSchema } from '../src/config.ts';
import { JobStore } from '../src/db/store.ts';
import { CostMeter } from '../src/llm/cost.ts';
import { AnthropicScorer, type BatchScore, type BatchScoring, type Scorer } from '../src/llm/scorer.ts';
import { formatRunStats } from '../src/output/report.ts';
import { jobsInBatches, pendingBatches } from '../src/pipeline/batch.ts';
import { runScout, type RunDeps } from '../src/pipeline/run.ts';
import type { SourceAdapter } from '../src/sources/common.ts';
import type { NormalizedJob, ScoreResult } from '../src/types.ts';
import { silentLogger } from '../src/util/logger.ts';
import { fakeHttp, jsonFixture, makeJob, makePrefs, NOW } from './helpers.ts';

const cv = MasterCvSchema.parse(jsonFixture('master-cv.json'));
const result = (score: number): ScoreResult => ({ score, verdict: score >= 85 ? 'strong' : 'poor', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' });

describe('batch scoring: the Claude scorer', () => {
  const raw = { score: 88, seniorityFit: 'fit', matchReasons: ['a'], gaps: [], dealbreakers: [], summary: 'ok' };
  const usage = { input_tokens: 100_000, output_tokens: 0 };
  const succeeded = (id: number, text: string, stop_reason = 'end_turn') => ({
    custom_id: `job-${id}`,
    result: { type: 'succeeded', message: { stop_reason, usage, content: [{ type: 'text', text: 'Asking the advisor.' }, { type: 'text', text }] } },
  });
  async function* stream(items: unknown[]) {
    yield* items;
  }

  function client(status: string, results: unknown[] = []) {
    const calls: Array<{ via: string; body: { betas?: string[]; requests: Array<{ custom_id: string; params: Record<string, unknown> }> } }> = [];
    const batches = (via: string) => ({
      create: async (body: never) => {
        calls.push({ via, body });
        return { id: 'batch_1' };
      },
      retrieve: async () => ({ processing_status: status }),
      results: async () => stream(results),
    });
    return { calls, messages: { batches: batches('messages') }, beta: { messages: { batches: batches('beta') } } };
  }

  it('sends one request per job, with the schema alone and the cached profile', async () => {
    const c = client('in_progress');
    const scorer = new AnthropicScorer({ cv, prefs: makePrefs(), model: 'claude-haiku-5-5', client: c as never });
    const id = await scorer.batch.submit([{ ...makeJob(), id: 7 }, { ...makeJob({ title: 'Integration Engineer' }), id: 9 }]);
    assert.equal(id, 'batch_1');
    const [call] = c.calls;
    assert.equal(call!.via, 'messages');
    assert.deepEqual(call!.body.requests.map((r) => r.custom_id), ['job-7', 'job-9']);
    const params = call!.body.requests[0]!.params as { model: string; system: Array<{ cache_control?: unknown }>; output_config: { format: Record<string, unknown> }; tools?: unknown };
    assert.equal(params.model, 'claude-haiku-5-5');
    assert.deepEqual(Object.keys(params.output_config.format), ['type', 'schema']);
    assert.ok(params.system[1]!.cache_control, 'the profile is still cached');
    assert.equal(params.tools, undefined);
    assert.equal(await scorer.batch.collect('batch_1'), null, 'still being processed');
  });

  it('keeps the advisor in batch requests, through the beta endpoint', async () => {
    const c = client('in_progress');
    const scorer = new AnthropicScorer({ cv, prefs: makePrefs(), model: 'claude-haiku-5-5', advisor: 'claude-opus-5-5', client: c as never });
    await scorer.batch.submit([{ ...makeJob(), id: 7 }]);
    const [call] = c.calls;
    assert.equal(call!.via, 'beta');
    assert.deepEqual(call!.body.betas, ['advisor-tool-2026-03-01']);
    const params = call!.body.requests[0]!.params as { tools: Array<{ type: string; model: string }>; max_tokens: number };
    assert.deepEqual([params.tools[0]!.type, params.tools[0]!.model, params.max_tokens], ['advisor_20260301', 'claude-opus-5-5', 2048]);
  });

  it('reads scores from an ended batch at half price, and says which requests never ran', async () => {
    const store = new JobStore(':memory:');
    const ids = [1, 2, 3, 4].map((n) => store.upsert(makeJob({ externalId: `acme:${n}` }), NOW.toISOString()).id);
    const meter = new CostMeter('scout');
    meter.attach(store);
    const c = client('ended', [
      succeeded(ids[0]!, JSON.stringify(raw)),
      succeeded(ids[1]!, '', 'refusal'),
      { custom_id: `job-${ids[2]}`, result: { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'Overloaded' } } } },
      { custom_id: `job-${ids[3]}`, result: { type: 'expired' } },
    ]);
    const scorer = new AnthropicScorer({ cv, prefs: makePrefs(), model: 'claude-sonnet-5-5', meter, client: c as never });
    const scores = (await scorer.batch.collect('batch_1'))!;
    assert.deepEqual(scores.get(ids[0]!), { ok: true, result: { ...result(88), verdict: 'strong', matchReasons: ['a'], summary: 'ok' } });
    assert.deepEqual(scores.get(ids[1]!), { ok: false, error: 'Model declined to score this posting', retry: false });
    assert.deepEqual(scores.get(ids[2]!), { ok: false, error: 'batch scoring: the request failed (Overloaded)', retry: true });
    assert.deepEqual(scores.get(ids[3]!), { ok: false, error: 'batch scoring: the request expired', retry: true });
    // 100K input tokens on Sonnet 5.5 is 20 cents live, 10 in a batch. Requests that never ran cost nothing.
    assert.deepEqual(store.db.prepare('SELECT job_id, cost FROM usage ORDER BY id').all(), [{ job_id: ids[0], cost: 0.1 }, { job_id: ids[1], cost: 0.1 }]);
  });
});

/** A scorer whose batches the test controls: scores by title like the live one, "boom" never runs. */
class FakeBatchScorer implements Scorer {
  readonly model = 'fake-claude';
  live: string[] = [];
  submitted: number[][] = [];
  ended = false;
  failSubmit = false;
  private jobs = new Map<string, Array<NormalizedJob & { id: number }>>();
  private byTitle = (title: string) => (/great/i.test(title) ? 90 : 40);

  async score(job: NormalizedJob): Promise<ScoreResult> {
    this.live.push(job.title);
    return result(this.byTitle(job.title));
  }
  readonly batch: BatchScoring = {
    submit: async (jobs) => {
      if (this.failSubmit) throw new Error('rate limited');
      const id = `batch_${this.submitted.length + 1}`;
      this.submitted.push(jobs.map((j) => j.id));
      this.jobs.set(id, jobs);
      return id;
    },
    collect: async (id) => {
      if (!this.ended) return null;
      return new Map(
        (this.jobs.get(id) ?? []).map((j): [number, BatchScore] => [
          j.id,
          /boom/i.test(j.title) ? { ok: false, error: 'batch scoring: the request expired', retry: true } : { ok: true, result: result(this.byTitle(j.title)) },
        ]),
      );
    },
  };
}

describe('batch scoring: Scout runs', () => {
  let store: JobStore;
  let scorer: FakeBatchScorer;
  let waits: number;
  const board = (titles: string[]): SourceAdapter => ({
    key: 'greenhouse:acme',
    kind: 'greenhouse',
    fetchJobs: async () => titles.map((title, i) => makeJob({ externalId: `acme:${i}`, title, url: `https://example.com/${i}` })),
  });
  const deps = (adapters: SourceAdapter[], over: Partial<RunDeps> = {}): RunDeps => ({
    store, adapters, http: fakeHttp({}), prefs: makePrefs(), logger: silentLogger, scorer, clock: () => NOW, checkPage: async () => 'unknown', checkLinkedIn: null,
    wait: async () => {
      waits++;
    },
    ...over,
  });

  beforeEach(() => {
    store = new JobStore(':memory:');
    scorer = new FakeBatchScorer();
    waits = 0;
  });

  it('sends the queue as one batch, waits for the scores, and carries on as usual', async () => {
    const jobs = board(['Great Automation Engineer', 'Backend Developer']);
    // The batch ends after the third check.
    const wait = async () => {
      if (++waits === 3) scorer.ended = true;
    };
    const stats = await runScout(deps([jobs], { batch: true, wait }));
    assert.equal(scorer.submitted.length, 1);
    assert.equal(scorer.submitted[0]!.length, 2);
    assert.deepEqual(scorer.live, [], 'nothing was scored at full price');
    assert.equal(waits, 3);
    assert.deepEqual(stats.batch, { submitted: 2, collected: 2, pending: 0 });
    assert.deepEqual([stats.scored, stats.shortlisted, stats.lowScore], [2, 1, 1]);
    assert.equal(store.listByStatus(['shortlisted'])[0]!.title, 'Great Automation Engineer');
    assert.deepEqual(pendingBatches(store), []);
    assert.match(formatRunStats(stats), /Batch: 2 posting\(s\) sent for scoring at half price, 2 score\(s\) arrived/);
  });

  it('leaves a slow batch for the next run, which never scores those jobs twice', async () => {
    const jobs = board(['Great Automation Engineer', 'Backend Developer']);
    const prefs = makePrefs({ scoring: { threshold: 65, maxJobsPerRun: 40, concurrency: 1, maxAttempts: 3, batchWaitMinutes: 2 } });
    const first = await runScout(deps([jobs], { batch: true, prefs }));
    assert.equal(waits, 4, 'two minutes of checks, 30 seconds apart');
    assert.deepEqual(first.batch, { submitted: 2, collected: 0, pending: 2 });
    assert.equal(first.scoringBacklog, 0, 'jobs in a batch are not backlog');
    assert.equal(jobsInBatches(store).size, 2);
    assert.match(formatRunStats(first), /2 still being scored \(the next run collects them\)/);

    // A live run while the batch is still out: nothing to score, nothing sent again.
    const second = await runScout(deps([jobs]));
    assert.deepEqual([scorer.live, scorer.submitted.length, second.scored], [[], 1, 0]);

    // The scores have arrived by the next run, batch or not.
    scorer.ended = true;
    const third = await runScout(deps([jobs]));
    assert.deepEqual(third.batch, { submitted: 0, collected: 2, pending: 0 });
    assert.equal(store.listByStatus(['shortlisted']).length, 1);
    assert.equal(store.listByStatus(['shortlisted'])[0]!.scoreDetails!.score, 90);
    assert.equal((store.db.prepare('SELECT scored_by FROM jobs WHERE score = 90').get() as { scored_by: string }).scored_by, 'fake-claude');
    assert.deepEqual(scorer.live, []);
  });

  it('scores now whatever a batch could not: requests that never ran, or a batch that could not be sent', async () => {
    scorer.ended = true;
    const stats = await runScout(deps([board(['Great Automation Engineer', 'Boom Developer'])], { batch: true }));
    assert.deepEqual(scorer.live, ['Boom Developer']);
    assert.deepEqual([stats.scored, stats.batch.collected], [2, 1]);

    store = new JobStore(':memory:');
    scorer = new FakeBatchScorer();
    scorer.failSubmit = true;
    const fallback = await runScout(deps([board(['Great Automation Engineer'])], { batch: true }));
    assert.deepEqual(scorer.live, ['Great Automation Engineer']);
    assert.deepEqual(fallback.batch, { submitted: 0, collected: 0, pending: 0 });
  });

  it('skips a batch score for a job that left the queue meanwhile', async () => {
    const prefs = makePrefs({ scoring: { threshold: 65, maxJobsPerRun: 40, concurrency: 1, maxAttempts: 3, batchWaitMinutes: 0 } });
    await runScout(deps([board(['Great Automation Engineer'])], { batch: true, prefs }));
    const [job] = store.listByStatus(['queued']);
    store.setStatus(job!.id, 'dismissed', null, 'user', NOW.toISOString());
    scorer.ended = true;
    const stats = await runScout(deps([]));
    assert.equal(stats.scored, 0);
    assert.equal(store.get(job!.id)!.status, 'dismissed');
    assert.deepEqual(pendingBatches(store), []);
  });

  it('scores now with a scorer that has no batches (a local model)', async () => {
    const local: Scorer = { model: 'ollama:gemma3:12b', score: async () => result(90) };
    const stats = await runScout(deps([board(['Great Automation Engineer'])], { batch: true, scorer: local }));
    assert.deepEqual([stats.scored, stats.batch.submitted], [1, 0]);
  });
});
