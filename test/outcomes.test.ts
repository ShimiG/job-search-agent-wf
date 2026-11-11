import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore, type ResponseRecord } from '../src/db/store.ts';
import { formatOutcomeReport, outcomeReport } from '../src/pipeline/outcomes.ts';
import { markSubmitted } from '../src/submit/run.ts';
import { makeJob, NOW } from './helpers.ts';

describe('callback rates from the Archiver', () => {
  const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);

  function setup() {
    const store = new JobStore(':memory:');
    let n = 0;
    const apply = (over: Parameters<typeof makeJob>[0], daysAgo: number, score: number | null, note: string | null = null) => {
      const { id } = store.upsert(makeJob(over), NOW.toISOString());
      if (score !== null) store.saveScore(id, { score, verdict: 'good', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' }, 'shortlisted', NOW.toISOString());
      markSubmitted(store, id, note, at(daysAgo));
      return id;
    };
    const reply = (jobId: number, kind: string, daysAgo: number) => {
      const r: Omit<ResponseRecord, 'id'> = {
        messageId: `<m${n++}>`, jobId, receivedAt: at(daysAgo).toISOString(), fromName: '', fromAddress: 'hr@example.com', subject: kind, kind, company: '', title: '', summary: '', action: '', model: 'test',
      };
      store.saveResponse(r, NOW.toISOString());
    };
    return { store, apply, reply };
  }

  it('counts each application once, by where Scout found it and the score it gave', () => {
    const { store, apply, reply } = setup();
    // Grain: found in a LinkedIn alert, applied on LinkedIn; interviewed, then rejected: still a callback.
    const grain = apply({ source: 'email', externalId: 'linkedin:1', company: 'Grain', title: 'AI Builder' }, 40, 90, 'you applied on LinkedIn on 2026-09-05');
    reply(grain, 'confirmation', 40);
    reply(grain, 'interview', 30);
    reply(grain, 'rejection', 20);
    // Acme: a board job, rejected. Beta: a board job, no reply. Gamma: sent 5 days ago, still waiting.
    const acme = apply({ externalId: 'acme:1', company: 'Acme', title: 'Integration Engineer' }, 40, 72);
    reply(acme, 'rejection', 25);
    apply({ externalId: 'beta:1', company: 'Beta', title: 'Data Analyst' }, 40, 60);
    apply({ externalId: 'gamma:1', company: 'Gamma', title: 'Automation Engineer' }, 5, 88);
    // Delta: an assessment counts as a callback; "viewed" alone does not.
    const delta = apply({ source: 'email', externalId: 'drushim:9', company: 'Delta', title: 'Bot Developer' }, 30, null);
    reply(delta, 'viewed', 29);
    reply(delta, 'assessment', 22);

    const r = outcomeReport(store, NOW);
    assert.deepEqual([r.total.applied, r.total.callbacks, r.total.rejected, r.total.noReply, r.total.waiting], [5, 2, 1, 1, 1]);
    assert.equal(r.total.rate, 0.5, '2 callbacks of the 4 old enough to judge');
    assert.deepEqual(
      r.bySource.map((g) => [g.label, g.applied, g.callbacks]),
      [['Greenhouse boards', 3, 0], ['Drushim alerts', 1, 1], ['LinkedIn alerts', 1, 1]],
    );
    assert.deepEqual(r.byScore.map((g) => [g.label, g.applied, g.callbacks]), [['Strong (85+)', 2, 1], ['Good (70–84)', 1, 0], ['Stretch (50–69)', 1, 0], ['Not scored', 1, 1]]);
    assert.equal(r.byScore[0]!.rate, 1, 'Gamma is still waiting, so only Grain counts');
    assert.deepEqual(r.byMethod.map((g) => g.label), ['You, on your own']);
    assert.match(formatOutcomeReport(r), /Callback rate 50%/);
  });

  it('files one application under the alert Scout found, not the record its confirmation made', () => {
    const { store, apply, reply } = setup();
    // The same job twice: the LinkedIn alert, and a record made from the company's confirmation email.
    apply({ source: 'email', externalId: 'linkedin:7', company: 'Mize', title: 'AI Product Specialist' }, 30, 81, 'you applied on LinkedIn on 2026-09-15');
    const fromEmail = apply({ source: 'email', externalId: 'applied:abc', company: 'Mize Ltd', title: 'AI Product Specialist' }, 30, null, 'you applied on the company site on 2026-09-15');
    reply(fromEmail, 'offer', 3);
    const r = outcomeReport(store, NOW);
    assert.equal(r.total.applied, 1);
    assert.deepEqual([r.total.callbacks, r.total.offers], [1, 1]);
    assert.deepEqual(r.bySource.map((g) => g.label), ['LinkedIn alerts']);
    assert.deepEqual(r.byScore.map((g) => g.label), ['Good (70–84)'], 'the score of the record that has one');
  });

  it('says so when nothing has been sent', () => {
    assert.equal(formatOutcomeReport(outcomeReport(new JobStore(':memory:'), NOW)), 'No applications recorded yet.');
  });
});
