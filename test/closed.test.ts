import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkLinkedInJob, checkPostingPage, isLinkedInJob, looksClosed } from '../src/pipeline/closed.ts';

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

  it('knows a LinkedIn job page from the rest of LinkedIn', () => {
    assert.ok(isLinkedInJob('https://www.linkedin.com/jobs/view/4480879930/'));
    assert.ok(isLinkedInJob('https://il.linkedin.com/jobs/view/ai-engineer-at-acme-4480879930'));
    assert.ok(!isLinkedInJob('https://www.linkedin.com/jobs/search/?keywords=ai'));
    assert.ok(!isLinkedInJob('https://jobs.lever.co/acme/1'));
  });

  it("reads a LinkedIn job's public page: closed by its banner, open only when the job's title shows, otherwise unknown", async () => {
    const li = 'https://www.linkedin.com/jobs/view/1/';
    const title = '<h1 class="top-card-layout__title topcard__title">Automation Engineer</h1>';
    assert.equal(await checkLinkedInJob(li, page(200, `${title}<figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>`, li)), 'closed');
    assert.equal(await checkLinkedInJob(li, page(200, `${title}<p>Be among the first 25 applicants</p>`, li)), 'open');
    assert.equal(await checkLinkedInJob(li, page(404, '', li)), 'closed');
    assert.equal(await checkLinkedInJob(li, page(200, '<form>Sign in</form>', 'https://www.linkedin.com/authwall?trk=x')), 'unknown', 'a sign-in wall says nothing about the job');
    assert.equal(await checkLinkedInJob(li, page(429, '', li)), 'unknown');
    assert.equal(await checkLinkedInJob(li, page(200, '<html><body>Something else entirely</body></html>', li)), 'unknown', 'no title, no banner: a layout we do not know');
    assert.equal(await checkLinkedInJob(li, (async () => { throw new Error('offline'); }) as unknown as typeof fetch), 'unknown');
  });
});
