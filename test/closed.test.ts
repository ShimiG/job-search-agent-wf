import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPostingPage, looksClosed } from '../src/pipeline/closed.ts';

const page = (status: number, body: string, url = 'https://jobs.example/acme/1') =>
  (async () => ({ status, ok: status >= 200 && status < 300, url, text: async () => body })) as unknown as typeof fetch;

describe('closed postings', () => {
  it('recognises the wording, and not look-alikes', () => {
    for (const t of ['No longer accepting applications', 'This position has been filled.', 'Applications are now closed', 'This job has expired', 'המשרה אינה רלוונטית', 'המשרה נסגרה']) {
      assert.ok(looksClosed(t), t);
    }
    for (const t of ['We build closed-loop control systems', 'Join our closed beta', 'Apply now: we review applications weekly']) {
      assert.ok(!looksClosed(t), t);
    }
  });

  it('checks a posting page without the model', async () => {
    assert.equal(await checkPostingPage('https://x', page(404, '')), 'closed');
    assert.equal(await checkPostingPage('https://x', page(200, '<p>Board</p>', 'https://job-boards.greenhouse.io/acme?error=true')), 'closed');
    assert.equal(await checkPostingPage('https://x', page(200, '<div>This job is <b>no longer accepting</b> applications</div>')), 'closed');
    assert.equal(await checkPostingPage('https://x', page(200, '<h1>AI Engineer</h1><p>Apply below</p>')), 'open');
    assert.equal(await checkPostingPage('https://x', page(503, '')), 'unknown');
    assert.equal(await checkPostingPage('https://x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch), 'unknown');
  });
});
