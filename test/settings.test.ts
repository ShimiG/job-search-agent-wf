import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { resortByCutoff } from '../src/pipeline/run.ts';
import { saveShortlistCutoff } from '../src/settings.ts';
import type { ScoreResult } from '../src/types.ts';
import { makeJob, makePrefs, NOW } from './helpers.ts';

const result = (score: number): ScoreResult => ({ score, verdict: 'good', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' });

describe('shortlist minimum score', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(tmpdir(), 'prefs-')), 'preferences.json');
    writeFileSync(file, readFileSync(new URL('../examples/preferences.json', import.meta.url)));
  });

  it('saves the cutoffs into preferences.json, leaving the rest of the file as it was', () => {
    const before = JSON.parse(readFileSync(file, 'utf8'));
    const prefs = saveShortlistCutoff(file, { threshold: 72, partialThreshold: 50 });
    assert.equal(prefs.scoring.threshold, 72);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(after.scoring, { ...before.scoring, threshold: 72, partialThreshold: 50 });
    assert.deepEqual(after.targetRoles, before.targetRoles);

    saveShortlistCutoff(file, { threshold: 72, partialThreshold: null });
    assert.equal('partialThreshold' in JSON.parse(readFileSync(file, 'utf8')).scoring, false, 'empty: same as the minimum');
  });

  it('refuses scores outside 0–100 or not whole, and leaves the file untouched', () => {
    const before = readFileSync(file, 'utf8');
    for (const bad of [{ threshold: 101 }, { threshold: -1 }, { threshold: 65.5 }, { threshold: '65' }, {}, { threshold: 60, partialThreshold: 200 }]) {
      assert.throws(() => saveShortlistCutoff(file, bad), /whole number from 0 to 100/);
    }
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('applies a new minimum to jobs already scored, both ways, and keeps jobs you added', () => {
    const store = new JobStore(':memory:');
    const at = NOW.toISOString();
    const add = (score: number, over = {}) => {
      const { id } = store.upsert(makeJob({ externalId: `acme:${Math.random()}`, title: `Engineer ${score}`, ...over }), at);
      store.saveScore(id, result(score), score >= 65 ? 'shortlisted' : 'low_score', at);
      return id;
    };
    const s80 = add(80);
    const s68 = add(68);
    const s60 = add(60);
    const mine = add(50, { source: 'manual', externalId: 'https://acme.example/1' });
    store.setStatus(mine, 'shortlisted', null, 'user', at);

    const raised = resortByCutoff(store, makePrefs({ scoring: { threshold: 70, maxJobsPerRun: 40, concurrency: 3, maxAttempts: 3 } }), at);
    assert.deepEqual(raised, { up: 0, down: 1 });
    assert.equal(store.get(s80)!.status, 'shortlisted');
    assert.equal(store.get(s68)!.status, 'low_score');
    assert.equal(store.get(mine)!.status, 'shortlisted', 'you chose it');

    const lowered = resortByCutoff(store, makePrefs({ scoring: { threshold: 55, maxJobsPerRun: 40, concurrency: 3, maxAttempts: 3 } }), at);
    assert.deepEqual(lowered, { up: 2, down: 0 });
    assert.equal(store.get(s60)!.status, 'shortlisted');
  });
});
