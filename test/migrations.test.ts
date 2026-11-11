import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { JobStore } from '../src/db/store.ts';
import { makeJob, NOW } from './helpers.ts';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'migrate-')), 'scout.db');
const columns = (db: Database.Database, table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
const tables = (db: Database.Database) => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name);

function check(db: Database.Database) {
  assert.equal(db.pragma('user_version', { simple: true }), 10);
  for (const t of ['responses', 'kv', 'usage']) assert.ok(tables(db).includes(t), `${t} table`);
  assert.ok(columns(db, 'responses').includes('message_id'), "the Archiver's responses table");
  for (const c of ['scored_by', 'outcome', 'outcome_at', 'archived_from', 'archive_choice']) assert.ok(columns(db, 'jobs').includes(c), `jobs.${c}`);
}

describe('database versions', () => {
  it('builds a new database with every table', () => {
    const store = new JobStore(':memory:');
    check(store.db);
    store.close();
  });

  it('adds cost tracking to a database already at version 9 (Archiver, local scorer)', () => {
    const f = file();
    const first = new JobStore(f);
    const { id } = first.upsert(makeJob(), NOW.toISOString());
    first.saveResponse({ messageId: '<a>', jobId: id, receivedAt: NOW.toISOString(), fromName: '', fromAddress: 'a@b.c', subject: 's', kind: 'interview', company: '', title: '', summary: '', action: '', model: 'm' }, NOW.toISOString());
    first.db.exec('DROP TABLE usage');
    first.db.pragma('user_version = 9');
    first.close();

    const store = new JobStore(f);
    check(store.db);
    assert.equal(store.responses().length, 1, 'replies the Archiver filed are kept');
    store.close();
  });

  it("repairs a database that ran the earlier build's versions 6 and 7 (a different replies table, and usage)", () => {
    const f = file();
    const first = new JobStore(f);
    const { id } = first.upsert(makeJob(), NOW.toISOString());
    first.saveScore(id, { score: 80, verdict: 'good', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' }, 'shortlisted', NOW.toISOString());
    first.saveUsage({ at: NOW.toISOString(), agent: 'scout', purpose: 'score', model: 'claude-sonnet-5-5', jobId: id, runId: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, cost: 0.5 });
    // What that build had: its own responses table, usage, and none of the Archiver's columns or tables.
    first.db.exec(`
      DROP TABLE responses; DROP TABLE kv;
      CREATE TABLE responses (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, kind TEXT NOT NULL, received_at TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, message_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE INDEX idx_responses_job ON responses(job_id);
      INSERT INTO responses (job_id, kind, received_at, sender, subject, message_key, created_at) VALUES (${id}, 'interview', 'x', 'y', 'z', 'k', 'x');
      ALTER TABLE jobs DROP COLUMN scored_by; ALTER TABLE jobs DROP COLUMN outcome; ALTER TABLE jobs DROP COLUMN outcome_at;
      ALTER TABLE jobs DROP COLUMN archived_from; ALTER TABLE jobs DROP COLUMN archive_choice;
    `);
    first.db.pragma('user_version = 7');
    first.close();

    const store = new JobStore(f);
    check(store.db);
    assert.equal(store.usageForJob(id), 0.5, 'recorded spending is kept');
    assert.deepEqual(store.responses(), [], 'the old replies table is replaced; the Archiver reads them again');
    assert.equal((store.db.prepare('SELECT scored_by FROM jobs WHERE id = ?').get(id) as { scored_by: string }).scored_by, 'claude', 'earlier scores were Claude\'s');
    assert.equal(store.get(id)!.score, 80);
    store.close();
  });
});
