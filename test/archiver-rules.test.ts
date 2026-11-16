import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rulesAnswer } from '../src/archiver/classify.ts';
import { afterFailure, MAX_TIMEOUT_TRIES, MAX_TRIES, TimeoutWatch, triesLeft, UNREAD, unreadRecord } from '../src/archiver/run.ts';
import { matchApplication, groupApplications } from '../src/archiver/report.ts';
import { markSubmitted } from '../src/submit/run.ts';
import { makeJob } from './helpers.ts';
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
  it('one slow email does not stop the run; two timeouts in a row do', () => {
    const watch = new TimeoutWatch();
    // A slow email between ones that are read: the run goes on.
    assert.deepEqual(['done', 'timeout', 'done', 'timeout', 'retry'].map((o) => watch.stuck(o as never)), [false, false, false, false, false]);
    // Ollama stuck: the second timeout in a row stops it.
    assert.deepEqual(['timeout', 'timeout'].map((o) => watch.stuck(o as never)), [false, true]);
  });

  it('an email given up on is filed as unread under its application, with a to-do, and creates nothing', () => {
    const store = new JobStore(':memory:');
    const id = store.upsert(makeJob({ company: 'Acme', title: 'Integration Engineer' }), '2026-11-01T09:00:00.000Z').id;
    markSubmitted(store, id, null, new Date('2026-11-01T09:00:00Z'));
    const record = unreadRecord('<slow@x>', mail('An update on your candidacy', 'A very long email the model never finished reading.', { name: 'Acme Careers', address: 'careers@acme.example' }));
    assert.deepEqual([record.kind, record.model, record.company, record.action], ['update', UNREAD, 'Acme', 'Open it in your inbox and read it yourself']);
    const jobId = matchApplication(record, groupApplications(store.sentApplications()));
    assert.equal(jobId, id);
    store.saveResponse({ ...record, jobId }, '2026-11-10T09:00:00.000Z');
    assert.deepEqual(store.responses().map((r) => [r.jobId, r.kind, r.summary]), [[id, 'update', "The local model couldn't read this email."]]);
    // From a sender with no application behind it: kept, unmatched, and no application appears.
    const stray = unreadRecord('<stray@x>', mail('Hello', 'x', { name: 'Initech Talent', address: 'talent@initech.example' }));
    assert.equal(matchApplication(stray, groupApplications(store.sentApplications())), null);
    assert.equal(store.sentApplications().length, 1);
  });

  it('a timeout is tried again more often than an odd answer; Ollama gone stops without a try', () => {
    assert.equal(afterFailure("Ollama isn't reachable at http://127.0.0.1:11434 (fetch failed). Start it with: brew services start ollama"), 'stop');
    assert.equal(afterFailure('Ollama took longer than 120s to answer'), 'timeout');
    assert.equal(afterFailure('Ollama returned something other than JSON'), 'retry');
    assert.deepEqual([MAX_TRIES, MAX_TIMEOUT_TRIES], [3, 5]);
    assert.deepEqual([triesLeft('retry', 1), triesLeft('retry', 2)], [true, false]);
    assert.deepEqual([triesLeft('timeout', 2), triesLeft('timeout', 3), triesLeft('timeout', 4)], [true, true, false]);
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

    // Read again and still a receipt: only who read it changes, so the next recheck passes it by.
    store.saveResponse({ messageId: '<b@x>', jobId: null, receivedAt: now, fromName: 'Acme', fromAddress: 'hr@acme.example', subject: 'Received', kind: 'confirmation', company: 'Acme', title: '', summary: 's', action: '', model: 'rules' }, now);
    store.setResponseModel(store.responseReading('<b@x>')!.id, 'ollama:gemma3:12b');
    assert.deepEqual(store.responseReading('<b@x>'), { id: store.responseReading('<b@x>')!.id, kind: 'confirmation', model: 'ollama:gemma3:12b' });
  });
});
