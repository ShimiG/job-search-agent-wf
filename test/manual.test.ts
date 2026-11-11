import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import type { PagePosting } from '../src/llm/posting.ts';
import type { Scorer } from '../src/llm/scorer.ts';
import { addManualJob, type ManualDeps } from '../src/pipeline/manual.ts';
import { resolveApplyUrl } from '../src/submit/answers.ts';
import type { NormalizedJob, ScoreResult } from '../src/types.ts';
import { makeJob, makePrefs, NOW } from './helpers.ts';

const description =
  'You will build agentic workflows for our customers: design the integrations, write the orchestration code in TypeScript, and run them in production. Requirements: three years building integrations, REST APIs, and experience with LLM agents in production.';
const posting: PagePosting = { title: 'AI Integration Engineer', company: 'Acme', location: 'Tel Aviv', workplaceType: 'hybrid', description };

class FakeScorer implements Scorer {
  readonly model = 'fake';
  calls: string[] = [];
  constructor(private readonly value = 40) {}
  async score(job: NormalizedJob): Promise<ScoreResult> {
    this.calls.push(job.description);
    return { score: this.value, verdict: 'poor', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' };
  }
}

describe('adding a job yourself', () => {
  let store: JobStore;
  let pages: string[];
  let pasted: string[];
  let scorer: FakeScorer;

  const deps = (over: Partial<ManualDeps> = {}): ManualDeps => ({
    store,
    prefs: makePrefs(),
    scorer,
    readPage: async (url) => {
      pages.push(url);
      return { ok: true, posting, finalUrl: `${url}?redirected=1`, cost: 0.03 };
    },
    readPasted: async (text) => {
      pasted.push(text);
      return { ok: true, posting: { ...posting, description: text }, cost: 0.01 };
    },
    now: () => NOW,
    ...over,
  });

  beforeEach(() => {
    store = new JobStore(':memory:');
    pages = [];
    pasted = [];
    scorer = new FakeScorer();
  });

  it('reads the posting off the link when there is no description, and keeps it on the shortlist whatever it scores', async () => {
    const r = await addManualJob({ url: 'https://acme.example/jobs/7' }, deps());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(pages, ['https://acme.example/jobs/7']);
    assert.equal(pasted.length, 0);
    const job = store.get(r.id)!;
    assert.equal(job.source, 'manual');
    assert.equal(job.status, 'shortlisted', 'a score of 40 is under the cutoff, but you chose it');
    assert.equal(job.score, 40);
    assert.equal(job.url, 'https://acme.example/jobs/7?redirected=1', 'where the page landed is where to apply');
    assert.equal(job.description, description);
  });

  it('scores from a pasted description without opening the link', async () => {
    const text = `${description} Pasted by hand.`;
    const r = await addManualJob({ url: 'https://acme.example/jobs/8', description: text }, deps());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(pages.length, 0, 'the link is only for the Submitter');
    assert.deepEqual(scorer.calls, [text]);
    const job = store.get(r.id)!;
    assert.equal(job.url, 'https://acme.example/jobs/8');
    assert.equal(job.status, 'shortlisted');
  });

  it('sends a pasted description straight to the Tailor, unscored', async () => {
    const r = await addManualJob({ url: 'https://acme.example/jobs/9', description, next: 'tailor' }, deps());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.next, 'tailor');
    assert.equal(scorer.calls.length, 0);
    assert.equal(store.get(r.id)!.status, 'selected');
  });

  it('sends a link alone straight to the Tailor: the posting is read off the page, not scored', async () => {
    const r = await addManualJob({ url: 'https://acme.example/jobs/10', next: 'tailor' }, deps());
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.next, 'tailor');
    assert.deepEqual(pages, ['https://acme.example/jobs/10']);
    assert.equal(scorer.calls.length, 0);
    const job = store.get(r.id)!;
    assert.equal(job.status, 'selected');
    assert.equal(job.description, description, 'tailored from the posting on the page');
    assert.equal(job.url, 'https://acme.example/jobs/10?redirected=1');
  });

  it('refuses a job already in your hands, by link or by company and title', async () => {
    const first = await addManualJob({ url: 'https://acme.example/jobs/7', description }, deps());
    assert.ok(first.ok);
    const again = await addManualJob({ url: 'https://acme.example/jobs/7', description }, deps());
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.existing?.status, 'shortlisted');

    // Scout found it on the company's board and you've picked it.
    const { id } = store.upsert(makeJob({ company: 'Globex', title: 'AI Integration Engineer', externalId: 'globex:1' }), NOW.toISOString());
    store.setStatus(id, 'selected', null, 'user', NOW.toISOString());
    const other = await addManualJob({ url: 'https://globex.example/careers/1', description }, deps({ readPasted: async (text) => ({ ok: true, posting: { ...posting, company: 'Globex', description: text }, cost: 0 }) }));
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.existing?.id, id);
  });

  it('adds a job Scout left below the cutoff', async () => {
    const { id } = store.upsert(makeJob({ title: 'AI Integration Engineer', url: 'https://acme.example/jobs/11' }), NOW.toISOString());
    store.setStatus(id, 'low_score', null, 'scout', NOW.toISOString());
    const r = await addManualJob({ url: 'https://acme.example/jobs/11', description }, deps());
    assert.ok(r.ok);
  });

  it('passes on why a page could not be read, and leaves a failed score for the next run', async () => {
    const closed = await addManualJob({ url: 'https://acme.example/jobs/12' }, deps({ readPage: async () => ({ ok: false, closed: true, reason: 'the page says this job is no longer accepting applications', cost: 0 }) }));
    assert.deepEqual(closed, { ok: false, reason: 'the page says this job is no longer accepting applications', closed: true, cost: 0 });
    assert.equal(store.findByUrl('https://acme.example/jobs/12'), undefined);

    const broken = await addManualJob({ url: 'https://acme.example/jobs/13', description }, deps({ scorer: { score: async () => { throw new Error('overloaded'); } } }));
    assert.ok(broken.ok && broken.score === null && broken.scoreError === 'overloaded');
    if (broken.ok) assert.equal(store.get(broken.id)!.status, 'score_error');
  });

  it('rejects something that is not a web link', async () => {
    const r = await addManualJob({ url: 'ftp://acme.example/jobs' }, deps());
    assert.equal(r.ok, false);
    assert.equal(pages.length, 0);
  });

  it('applies on Lever and Ashby forms from a pasted job page, and anywhere else on the link itself', () => {
    const manual = (url: string) => resolveApplyUrl({ source: 'manual', url, applyUrl: undefined });
    assert.equal(manual('https://jobs.lever.co/acme/abc-123?lever-source=x'), 'https://jobs.lever.co/acme/abc-123/apply?lever-source=x');
    assert.equal(manual('https://jobs.ashbyhq.com/acme/9f1/'), 'https://jobs.ashbyhq.com/acme/9f1/application');
    assert.equal(manual('https://jobs.lever.co/acme'), 'https://jobs.lever.co/acme', 'a careers list, not a job');
    assert.equal(manual('https://acme.example/careers/7'), 'https://acme.example/careers/7');
  });
});
