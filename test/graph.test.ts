import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Command, MemorySaver } from '@langchain/langgraph';
import { JobStore } from '../src/db/store.ts';
import { applyPicks, applyReview, pipeline, sendWithoutReview } from '../src/graph/graphs.ts';
import { makeJob, NOW } from './helpers.ts';

const examples = new URL('../examples/', import.meta.url);
const saved = { ...process.env };

/** A project folder with the example config, no job boards, and a database at a known path. */
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'graph-'));
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  mkdirSync(configDir);
  mkdirSync(dataDir);
  for (const f of ['preferences.json', 'sources.json']) copyFileSync(new URL(f, examples), path.join(configDir, f));
  Object.assign(process.env, { SCOUT_CONFIG_DIR: configDir, SCOUT_DATA_DIR: dataDir, SCOUT_DB_PATH: path.join(dataDir, 'scout.db'), LOG_LEVEL: 'silent', REVIEW_AUTO_OPEN: 'false' });
  return path.join(dataDir, 'scout.db');
}

function seed(db: string, status: Parameters<JobStore['setStatus']>[1], n = 1): number[] {
  const store = new JobStore(db);
  try {
    return Array.from({ length: n }, (_, i) => {
      const { id } = store.upsert(makeJob({ externalId: `acme:${status}:${i}`, title: `Engineer ${i}` }), NOW.toISOString());
      store.setStatus(id, status, null, 'scout', NOW.toISOString());
      return id;
    });
  } finally {
    store.close();
  }
}

describe('graph decisions', () => {
  let db: string;
  before(() => (db = workspace()));
  after(() => (process.env = saved));

  it('picks and dismisses with the CLI transition rules', () => {
    const [a, b] = seed(db, 'shortlisted', 2);
    const [done] = seed(db, 'submitted');
    const store = new JobStore(db);
    try {
      const { picked, skipped } = applyPicks(store, { pick: [a!, done!, 9999], dismiss: [b!] });
      assert.deepEqual(picked, [a]);
      assert.deepEqual(skipped.map((s) => s.id), [done, 9999]);
      assert.equal(store.get(a!)!.status, 'selected');
      assert.equal(store.get(b!)!.status, 'dismissed');
      // Studio sends the resume value as the text you typed.
      const [c] = seed(db, 'shortlisted');
      assert.deepEqual(applyPicks(store, `{\n  "pick": [${c}]\n}` as never).picked, [c]);
    } finally {
      store.close();
    }
  });

  it('approves only tailored jobs and rejects bad input', () => {
    const [t] = seed(db, 'tailored');
    const [s] = seed(db, 'shortlisted');
    const store = new JobStore(db);
    try {
      const { approved, skipped } = applyReview(store, { approve: [t!, s!] });
      assert.deepEqual(approved, [t]);
      const [t2] = seed(db, 'tailored');
      assert.equal(applyReview(store, { approve: [t2!], mode: 'auto' }).mode, 'auto', 'the mode chosen at approval goes to the Submitter');
      assert.match(skipped[0]!.reason, /only tailored jobs/);
      assert.equal(store.get(t!)!.status, 'approved');
      assert.throws(() => applyReview(store, { approve: ['7' as unknown as number] }));
    } finally {
      store.close();
    }
  });
});

describe('review before sending', () => {
  let db: string;
  before(() => (db = workspace()));
  after(() => (process.env = saved));

  it('off: sends tailored applications on, but holds ones the fact-check flagged', async () => {
    const settings = path.join(process.env.SCOUT_CONFIG_DIR!, 'submit.json');
    copyFileSync(new URL('submit.json', examples), settings);
    assert.equal(await sendWithoutReview([1]), null, 'review on (the default): nothing happens');

    writeFileSync(settings, readFileSync(settings, 'utf8').replace('"requireApproval": true', '"requireApproval": false').replace('"autoSubmit": false,', '"autoSubmit": false,\n  "requireApproval": false,'));
    const [flagged] = seed(db, 'tailored');
    const store = new JobStore(db);
    try {
      store.saveApplication({
        jobId: flagged!, dir: '/tmp', cvLanguage: 'en', letterLanguage: 'en', feedback: null, model: null, createdAt: '2026-10-15T08:00:00.000Z',
        content: {}, verification: { ok: false, issues: [{ severity: 'unresolved', where: 'letter:1', message: 'not in your CV' }], bulletChanges: [], llmChecked: true, revised: false },
      });
    } finally {
      store.close();
    }
    const sent = await sendWithoutReview([flagged!]);
    assert.deepEqual(sent?.approved, []);
    assert.match(sent!.held[0]!.reason, /unverified/);
  });
});

describe('pipeline graph', () => {
  let db: string;
  before(() => (db = workspace()));
  after(() => (process.env = saved));

  it('pauses on the shortlist and stops when nothing is picked', async () => {
    const [id] = seed(db, 'shortlisted');
    const graph = pipeline.withConfig({}) as typeof pipeline;
    graph.checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: 't1' } };

    await graph.invoke({ noScore: true }, config);
    const paused = await graph.getState(config);
    assert.deepEqual(paused.next, ['pick']);
    assert.match((paused.tasks[0]!.interrupts[0]!.value as { reviewPage: string }).reviewPage, /^http:\/\/127\.0\.0\.1:\d+$/);
    const payload = paused.tasks[0]!.interrupts[0]!.value as { shortlist: Array<{ id: number }> };
    assert.deepEqual(payload.shortlist.map((j) => j.id), [id]);

    const done = await graph.invoke(new Command({ resume: JSON.stringify({ dismiss: [id] }, null, 2) }), config);
    assert.deepEqual(done.picked, []);
    assert.deepEqual((await graph.getState(config)).next, []);
    const store = new JobStore(db);
    try {
      assert.equal(store.get(id!)!.status, 'dismissed');
    } finally {
      store.close();
    }
  });
});
