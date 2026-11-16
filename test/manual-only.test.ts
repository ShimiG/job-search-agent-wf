import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { applyReview } from '../src/decisions.ts';
import { caseStudy } from '../src/report/metrics.ts';
import { manualOnly } from '../src/submit/manual.ts';
import { makeJob, NOW } from './helpers.ts';

const now = NOW.toISOString();

/** A tailored job, ready for your approval. */
function tailored(store: JobStore, over: Parameters<typeof makeJob>[0]): number {
  const id = store.upsert(makeJob(over), now).id;
  store.saveApplication({ jobId: id, dir: '/tmp/none', cvLanguage: 'en', letterLanguage: 'en', feedback: null, model: null, createdAt: now, content: {}, verification: { ok: true, issues: [] } });
  store.setStatus(id, 'tailored', 'v1 ready', 'tailor', now);
  return id;
}

describe('jobs on sites the Submitter never acts on', () => {
  it('are recognised by where the application is, not where the job was found', () => {
    const alert = makeJob({ source: 'email', externalId: 'linkedin:123', url: 'https://www.linkedin.com/jobs/view/123' });
    assert.deepEqual(manualOnly(alert), { site: 'LinkedIn', why: 'LinkedIn forbids automated applications; apply on the site', applyUrl: 'https://www.linkedin.com/jobs/view/123' });
    // The company's own application page was found for it: now the Submitter can try.
    assert.equal(manualOnly({ ...alert, applyUrl: 'https://boards.greenhouse.io/acme/jobs/1' }), null);
    assert.equal(manualOnly(makeJob({ url: 'https://boards.greenhouse.io/acme/jobs/1' })), null);
    assert.equal(manualOnly(makeJob({ source: 'workday', externalId: 'acme/Careers:JR1', url: 'https://acme.wd5.myworkdayjobs.com/Careers/job/JR1' }))?.site, 'Workday');
  });

  it('go straight to you when approved: no attempt, and the Submitter is only started for the rest', () => {
    const store = new JobStore(':memory:');
    const linkedin = tailored(store, { source: 'email', externalId: 'linkedin:123', company: 'Globex', url: 'https://www.linkedin.com/jobs/view/123' });
    const board = tailored(store, { externalId: 'acme:9', url: 'https://boards.greenhouse.io/acme/jobs/9' });

    const result = applyReview(store, { approve: [linkedin, board] });
    assert.deepEqual([result.approved, result.manual, result.skipped], [[board], [linkedin], []]);
    assert.equal(store.get(board)!.status, 'approved');
    const job = store.get(linkedin)!;
    assert.equal(job.status, 'needs_manual');
    assert.match(job.statusReason!, /^LinkedIn: LinkedIn forbids automated applications; apply on the site\. Apply at https:\/\/www\.linkedin\.com\/jobs\/view\/123, then click "I applied myself"/);
    assert.deepEqual(store.submissions(linkedin), []);
    // Your approval is still on record: it was approved, then handed to you.
    assert.deepEqual(store.history(linkedin).slice(-2).map((h) => [h.to_status, h.actor]), [['approved', 'user'], ['needs_manual', 'submitter']]);

    // The case study counts it as approved, and counts no Submitter attempt for it.
    const study = caseStudy(store, NOW);
    assert.equal(study.funnel.approved, 2);
    assert.equal(study.submitter.attempts, 0);
  });

  it('a job with unverified claims is still held for your say-so first', () => {
    const store = new JobStore(':memory:');
    const id = tailored(store, { source: 'email', externalId: 'linkedin:5', url: 'https://www.linkedin.com/jobs/view/5' });
    const app = store.latestApplication(id)!;
    store.updateApplicationContent(app.id, {}, { ok: false, issues: [{ severity: 'unresolved', where: 'letter:0', message: 'mentions Kubernetes' }] });
    const held = applyReview(store, { approve: [id] });
    assert.deepEqual([held.approved, held.manual, held.skipped.length], [[], [], 1]);
    assert.equal(store.get(id)!.status, 'tailored');
    assert.deepEqual(applyReview(store, { approve: [id], force: true }).manual, [id]);
  });
});
