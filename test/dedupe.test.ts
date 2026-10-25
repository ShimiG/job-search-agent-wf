import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideDuplicate, isSameJob } from '../src/pipeline/dedupe.ts';
import type { JobRow } from '../src/types.ts';

type Fields = Parameters<typeof decideDuplicate>[0];
const row = (o: Partial<JobRow>): Fields => ({
  id: 1,
  source: 'greenhouse',
  normTitle: 'ai automation engineer',
  location: 'Tel Aviv',
  descriptionIsPartial: false,
  firstSeenAt: '2026-10-10T00:00:00Z',
  status: 'queued',
  ...o,
});

describe('isSameJob', () => {
  it('matches the same title across sources regardless of location text', () => {
    assert.ok(isSameJob(row({ source: 'greenhouse' }), row({ id: 2, source: 'email', location: 'Tel Aviv-Yafo, Israel' })));
  });

  it('treats same board + same title + different location as separate openings', () => {
    assert.equal(isSameJob(row({}), row({ id: 2, location: 'Haifa' })), false);
    assert.ok(isSameJob(row({}), row({ id: 2 })));
  });

  it('keeps numbered levels apart even when the strings are nearly identical', () => {
    assert.equal(isSameJob(row({ normTitle: 'software engineer ii' }), row({ id: 2, normTitle: 'software engineer iii' })), false);
    assert.equal(isSameJob(row({ normTitle: 'backend developer' }), row({ id: 2, source: 'email', normTitle: 'sr backend developer' })), false);
  });

  it('keeps different seniority levels apart', () => {
    assert.equal(isSameJob(row({}), row({ id: 2, source: 'email', normTitle: 'senior ai automation engineer team lead' })), false);
  });
});

describe('decideDuplicate', () => {
  it('marks a thinner alert-email copy as a duplicate of the ATS posting', () => {
    const ats = row({ id: 10 });
    const email = row({ id: 11, source: 'email', descriptionIsPartial: true });
    assert.deepEqual(decideDuplicate(email, [ats]), { kind: 'duplicate', canonicalId: 10 });
  });

  it('lets a richer ATS posting replace an earlier alert-email copy', () => {
    const email = row({ id: 10, source: 'email', descriptionIsPartial: true, status: 'shortlisted' });
    const ats = row({ id: 11, firstSeenAt: '2026-10-12T00:00:00Z' });
    assert.deepEqual(decideDuplicate(ats, [email]), { kind: 'replace', demoteId: 10 });
  });

  it('never replaces a job you already picked', () => {
    const email = row({ id: 10, source: 'email', descriptionIsPartial: true, status: 'selected' });
    const ats = row({ id: 11 });
    assert.deepEqual(decideDuplicate(ats, [email]), { kind: 'duplicate', canonicalId: 10 });
  });

  it('ignores filtered, duplicate and not-yet-evaluated rows', () => {
    for (const status of ['filtered_out', 'duplicate', 'discovered'] as const) {
      assert.deepEqual(decideDuplicate(row({ id: 2, source: 'email' }), [row({ status })]), { kind: 'unique' });
    }
  });
});
