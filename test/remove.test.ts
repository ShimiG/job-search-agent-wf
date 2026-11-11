import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { removeJob } from '../src/decisions.ts';
import type { JobStatus } from '../src/types.ts';
import { makeJob, NOW } from './helpers.ts';

describe('removing a job at any stage', () => {
  let store: JobStore;
  const seed = (status: JobStatus, n: number) => {
    const { id } = store.upsert(makeJob({ externalId: `acme:${n}` }), NOW.toISOString());
    store.setStatus(id, status, null, 'user', NOW.toISOString());
    return id;
  };

  beforeEach(() => {
    store = new JobStore(':memory:');
  });

  it('takes a job off every list from any stage before sending, and says where it was', () => {
    const stages: JobStatus[] = ['queued', 'low_score', 'shortlisted', 'selected', 'tailor_error', 'tailored', 'approved', 'needs_manual', 'failed', 'archived'];
    stages.forEach((status, n) => {
      const id = seed(status, n);
      assert.deepEqual(removeJob(store, id, NOW.toISOString()), { id, from: status });
      const job = store.get(id)!;
      assert.equal(job.status, 'dismissed');
      assert.equal(job.statusReason, 'removed by you');
    });
    for (const list of [['shortlisted'], ['selected', 'tailor_error'], ['tailored'], ['approved', 'needs_manual', 'failed']] as JobStatus[][]) {
      assert.equal(store.listByStatus(list).length, 0);
    }
  });

  it('leaves a sent application alone, and removing twice changes nothing', () => {
    const sent = seed('submitted', 1);
    assert.throws(() => removeJob(store, sent), /was sent/);
    assert.equal(store.get(sent)!.status, 'submitted');

    const gone = seed('dismissed', 2);
    const before = store.history(gone).length;
    assert.deepEqual(removeJob(store, gone), { id: gone, from: 'dismissed' });
    assert.equal(store.history(gone).length, before, 'no second history entry');

    assert.throws(() => removeJob(store, 9999), /not found/);
  });
});
