import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectBoard } from '../src/sources/parse-url.ts';

describe('detectBoard', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['https://job-boards.greenhouse.io/acme/jobs/123', { ats: 'greenhouse', token: 'acme' }],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', { ats: 'greenhouse', token: 'acme' }],
    ['https://boards-api.greenhouse.io/v1/boards/acme/jobs', { ats: 'greenhouse', token: 'acme' }],
    ['https://jobs.lever.co/beta/abc-123', { ats: 'lever', token: 'beta', region: 'global' }],
    ['https://jobs.eu.lever.co/beta', { ats: 'lever', token: 'beta', region: 'eu' }],
    ['https://jobs.ashbyhq.com/gamma', { ats: 'ashby', token: 'gamma' }],
    ['https://apply.workable.com/delta/', { ats: 'workable', token: 'delta' }],
    ['https://delta.workable.com', { ats: 'workable', token: 'delta' }],
  ];
  for (const [url, expected] of cases) {
    it(url, () => {
      const result = detectBoard(url);
      assert.ok(result.ok, !result.ok ? result.reason : '');
      for (const [k, v] of Object.entries(expected)) assert.equal((result.board as Record<string, unknown>)[k], v);
    });
  }

  it('names the company from the token unless given', () => {
    const a = detectBoard('https://jobs.ashbyhq.com/my-company');
    const b = detectBoard('https://jobs.ashbyhq.com/my-company', { company: 'MyCo' });
    assert.ok(a.ok && b.ok);
    assert.equal(a.board.company, 'My Company');
    assert.equal(b.board.company, 'MyCo');
  });

  it('asks for the Comeet token, then accepts it', () => {
    const url = 'https://www.comeet.com/jobs/epsilon/A1.B2C';
    const without = detectBoard(url);
    assert.equal(without.ok, false);
    assert.match(!without.ok ? without.reason : '', /--token/);
    const withToken = detectBoard(url, { token: 'T0K' });
    assert.ok(withToken.ok);
    assert.deepEqual(withToken.board, { ats: 'comeet', uid: 'A1.B2C', token: 'T0K', company: 'Epsilon', enabled: true });
  });

  it('rejects unknown sites and job links', () => {
    assert.equal(detectBoard('https://www.linkedin.com/jobs/view/123').ok, false);
    assert.equal(detectBoard('https://apply.workable.com/j/ABC123').ok, false);
    assert.equal(detectBoard('not a url').ok, false);
  });
});
