import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rulesAnswer } from '../src/archiver/classify.ts';
import { afterFailure, MAX_TIMEOUT_TRIES, MAX_TRIES, triesLeft } from '../src/archiver/run.ts';
import { JobStore } from '../src/db/store.ts';
import { loadReplyCases } from '../src/evals/run.ts';
import type { RawEmail } from '../src/sources/applications.ts';

const mail = (subject: string, text: string, from = { name: 'Acme Careers', address: 'no-reply@acme.example' }): RawEmail => ({
  fromName: from.name, fromAddress: from.address, subject, text, html: '', date: new Date('2026-11-10T09:00:00Z'),
});
const byRule = (m: RawEmail) => rulesAnswer(m, m.text);

describe('which emails the rules may file without the model', () => {
  it('a receipt that says nothing more is a confirmation', () => {
    const got = byRule(mail('Thank you for applying to Acme', 'Hi Dana,\n\nThank you for applying to Acme. We have received your application for the Integration Engineer position.\n\nThe Acme team'));
    assert.deepEqual([got?.kind, got?.model, got?.company], ['confirmation', 'rules', 'Acme']);
  });

  it('"thanks for applying" followed by a decision, a request or a next step is read by the model', () => {
    const more = [
      // The two the reply eval caught: both were filed as confirmations.
      'Thanks for applying to LLM Application Engineer. We would like you to complete a short home assignment. Please send it back within 5 days.',
      'Thank you for applying. We wanted to let you know that the Backend Developer position has been filled, so we are closing the applications that were still open.',
      'Thank you for applying to Acme. Unfortunately, we will not be taking your application further.',
      'Thank you for your application to Acme! We would love to set up a 30-minute call. What is your availability this week?',
      'Thanks for applying. We are delighted to offer you the position.',
      'Thank you for applying to Acme. Hiring for this role is on hold until next quarter.',
      'תודה על פנייתך. Thank you for applying to Acme. לצערנו החלטנו שלא להתקדם עם מועמדותך.',
      // A receipt that mentions interviews in passing: the model decides, which costs seconds, not a callback.
      'Thank you for applying to Acme. If your profile is a match, a recruiter will contact you to schedule an interview.',
    ];
    for (const text of more) assert.equal(byRule(mail('Your application to Acme', text)), null, text.slice(0, 60));
  });

  it("LinkedIn's own notices keep their fixed meaning whatever else the email shows", () => {
    const from = { name: 'LinkedIn', address: 'jobs-noreply@linkedin.com' };
    const sent = byRule(mail('Dana, your application was sent to Acme', 'Your application was sent to Acme\nIntegration Engineer\n\nPrepare for your interview with these tips. Similar jobs: Test Engineer', from));
    assert.deepEqual([sent?.kind, sent?.company, sent?.title], ['confirmation', 'Acme', 'Integration Engineer']);
    const viewed = byRule(mail('Your application was viewed by Acme', 'Your application was viewed by Acme', from));
    assert.equal(viewed?.kind, 'viewed');
  });

  it('never gives a wrong kind to any email of the reply eval', () => {
    for (const c of loadReplyCases()) {
      const got = byRule(mail(c.subject, c.body, c.from));
      assert.ok(got === null || got.kind === c.expect, `${c.id}: the rules said ${got?.kind}, it is ${c.expect}`);
    }
  });
});

describe('after an email could not be read', () => {
  it('a timeout stops the run and is tried again more often than an odd answer; Ollama gone stops without a try', () => {
    assert.equal(afterFailure("Ollama isn't reachable at http://127.0.0.1:11434 (fetch failed). Start it with: brew services start ollama"), 'stop');
    assert.equal(afterFailure('Ollama took longer than 120s to answer'), 'timeout');
    assert.equal(afterFailure('Ollama returned something other than JSON'), 'retry');
    assert.deepEqual([MAX_TRIES, MAX_TIMEOUT_TRIES], [3, 8]);
    assert.deepEqual([triesLeft('retry', 1), triesLeft('retry', 2)], [true, false]);
    assert.deepEqual([triesLeft('timeout', 2), triesLeft('timeout', 6), triesLeft('timeout', 7)], [true, true, false]);
  });
});

describe('reading an email again', () => {
  it('replaces what it was read as and keeps the application it belongs to', () => {
    const store = new JobStore(':memory:');
    const now = '2026-11-10T09:00:00.000Z';
    store.saveResponse({ messageId: '<a@x>', jobId: null, receivedAt: now, fromName: 'Acme', fromAddress: 'hr@acme.example', subject: 'Your application', kind: 'confirmation', company: 'Acme', title: '', summary: 'Acme confirmed they received your application.', action: '', model: 'rules' }, now);
    const before = store.responseReading('<a@x>')!;
    assert.deepEqual([before.kind, before.model], ['confirmation', 'rules']);
    assert.equal(store.responseReading('<never@x>'), undefined);
    store.updateResponseReading(before.id, { kind: 'assessment', company: 'Acme', title: 'Integration Engineer', summary: 'A home assignment to complete.', action: 'Send it back within 5 days', model: 'ollama:gemma3:12b' });
    const [after] = store.responses();
    assert.deepEqual([after!.kind, after!.title, after!.action, after!.model, after!.messageId], ['assessment', 'Integration Engineer', 'Send it back within 5 days', 'ollama:gemma3:12b', '<a@x>']);
  });
});
