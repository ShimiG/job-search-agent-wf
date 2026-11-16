import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { CostMeter, timed } from '../src/llm/cost.ts';
import { ollamaJson } from '../src/llm/ollama.ts';
import { spendingReport } from '../src/pipeline/spending.ts';
import { createLogger, pruneLogs } from '../src/util/logger.ts';
import { z } from 'zod';

const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });

describe('what is kept about each model call', () => {
  it('stores how long an answered call took, picked up from the response it timed', async () => {
    const store = new JobStore(':memory:');
    const meter = new CostMeter('scout');
    meter.attach(store);
    const message = await timed(meter, 'score', 'claude-haiku-5-5', async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { usage: usage(1000, 100) };
    });
    meter.record('score', 'claude-haiku-5-5', message.usage);
    // A usage block that wasn't timed (a batch result, an advisor step) has no duration.
    meter.record('score', 'claude-haiku-5-5', usage(10, 1));
    const rows = store.usageRows();
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.durationMs! >= 10 && rows[0]!.durationMs! < 2000, `timed: ${rows[0]!.durationMs}ms`);
    assert.equal(rows[0]!.error, null);
    assert.equal(rows[1]!.durationMs, null);
  });

  it('records a call that throws as a failure with no cost, and still throws', async () => {
    const store = new JobStore(':memory:');
    const meter = new CostMeter('tailor');
    meter.attach(store);
    await assert.rejects(
      timed(meter, 'draft', 'claude-sonnet-5-5', async () => {
        throw new Error('529 overloaded\nrequest id: abc');
      }, null),
      /overloaded/,
    );
    const [row] = store.usageRows();
    assert.deepEqual([row!.purpose, row!.error, row!.cost, row!.inputTokens], ['draft', '529 overloaded', 0, 0]);
    assert.equal(typeof row!.durationMs, 'number');
    assert.equal(meter.totals().total, 0);
  });

  it("counts a local model's tokens and time at no cost, and keeps both out of the spending report", () => {
    const store = new JobStore(':memory:');
    const meter = new CostMeter('archiver');
    meter.attach(store);
    meter.recordLocal('reply', 'ollama:gemma3:12b', { inputTokens: 5000, outputTokens: 200, durationMs: 4200 });
    meter.fail('reply', 'ollama:gemma3:12b', new Error('Ollama took longer than 300s to answer'), 300_000);
    const rows = store.usageRows();
    assert.deepEqual(rows.map((r) => [r.agent, r.cost, r.inputTokens, r.durationMs, r.error]), [
      ['archiver', 0, 5000, 4200, null],
      ['archiver', 0, 0, 300_000, 'Ollama took longer than 300s to answer'],
    ]);
    // Nothing was spent, so the spending report has nothing to say yet.
    assert.equal(spendingReport(store).since, null);
    assert.deepEqual(store.usageByPurpose(), []);
  });
});

describe('a local model call through Ollama', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const Schema = z.object({ kind: z.string() });

  it('reports its token counts and time to the meter', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: '{"kind":"rejection"}' }, prompt_eval_count: 812, eval_count: 9 }))) as typeof fetch;
    const store = new JobStore(':memory:');
    const meter = new CostMeter('archiver');
    meter.attach(store);
    assert.deepEqual(await ollamaJson({ model: 'gemma3:12b', system: 's', user: 'u', schema: Schema, meter, purpose: 'reply' }), { kind: 'rejection' });
    const [row] = store.usageRows();
    assert.deepEqual([row!.model, row!.purpose, row!.inputTokens, row!.outputTokens, row!.cost, row!.error], ['ollama:gemma3:12b', 'reply', 812, 9, 0, null]);
  });

  it('records an answer it could not use, and a server that is down, as failures', async () => {
    const store = new JobStore(':memory:');
    const meter = new CostMeter('archiver');
    meter.attach(store);
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: 'not json' }, prompt_eval_count: 800, eval_count: 3 }))) as typeof fetch;
    await assert.rejects(ollamaJson({ model: 'gemma3:12b', system: 's', user: 'u', schema: Schema, meter, purpose: 'reply' }), /something other than JSON/);
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await assert.rejects(ollamaJson({ model: 'gemma3:12b', system: 's', user: 'u', schema: Schema, meter, purpose: 'reply' }), /isn't reachable/);
    // A model that answers with the wrong shape: the reason names the field, not a page of JSON.
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: '{"kind":7}' }, prompt_eval_count: 700, eval_count: 5 }))) as typeof fetch;
    await assert.rejects(ollamaJson({ model: 'gemma3:12b', system: 's', user: 'u', schema: Schema, meter, purpose: 'reply' }));
    const rows = store.usageRows();
    // One row per call. The unusable answers still used the model, so their tokens are kept.
    assert.deepEqual(rows.map((r) => [r.inputTokens, r.error === null]), [[800, false], [0, false], [700, false]]);
    assert.match(rows[0]!.error!, /something other than JSON/);
    assert.match(rows[1]!.error!, /isn't reachable/);
    assert.match(rows[2]!.error!, /^answer didn't match the expected shape: kind: /);
  });
});

describe('the log file', () => {
  const quiet = () => {
    const [log, err] = [console.log, console.error];
    console.log = console.error = () => {};
    return () => {
      console.log = log;
      console.error = err;
    };
  };

  it('keeps every line as JSON in a file per day, debug lines included, with the agent that wrote it', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'logs-')), 'logs');
    let now = new Date('2026-11-15T23:59:30Z');
    const restore = quiet();
    try {
      const logger = createLogger('warn', { dir, agent: 'scout' }, () => now);
      logger.debug('fetched', { source: 'greenhouse:acme', jobs: 12 });
      logger.warn('scoring failed for #7');
      now = new Date('2026-11-16T00:00:05Z');
      logger.info('done');
    } finally {
      restore();
    }
    assert.deepEqual(readdirSync(dir).sort(), ['2026-11-15.jsonl', '2026-11-16.jsonl']);
    const lines = readFileSync(path.join(dir, '2026-11-15.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      { t: '2026-11-15T23:59:30.000Z', level: 'debug', agent: 'scout', msg: 'fetched', meta: { source: 'greenhouse:acme', jobs: 12 } },
      { t: '2026-11-15T23:59:30.000Z', level: 'warn', agent: 'scout', msg: 'scoring failed for #7' },
    ]);
  });

  it('deletes files past the keep period and leaves other files alone', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'logs-'));
    for (const name of ['2026-10-01.jsonl', '2026-10-17.jsonl', '2026-11-15.jsonl', 'notes.txt']) writeFileSync(path.join(dir, name), '');
    assert.equal(pruneLogs(dir, 30, new Date('2026-11-16T12:00:00Z')), 1);
    assert.deepEqual(readdirSync(dir).sort(), ['2026-10-17.jsonl', '2026-11-15.jsonl', 'notes.txt']);
    assert.equal(pruneLogs(path.join(dir, 'missing'), 30), 0);
  });

  it('writes no file when turned off, and never throws when the folder cannot be made', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'logs-'));
    const restore = quiet();
    process.env.LOG_TO_FILE = 'false';
    try {
      createLogger('info', { dir: path.join(base, 'off'), agent: 'scout' }).info('hello');
      assert.deepEqual(readdirSync(base), []);
      delete process.env.LOG_TO_FILE;
      writeFileSync(path.join(base, 'file'), '');
      createLogger('info', { dir: path.join(base, 'file', 'logs'), agent: 'scout' }).info('still fine');
    } finally {
      delete process.env.LOG_TO_FILE;
      restore();
    }
  });
});
