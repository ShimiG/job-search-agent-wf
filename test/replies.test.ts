import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { formatOutcomeReport, matchReply, outcomeReport, recordReplies } from '../src/pipeline/outcomes.ts';
import type { RawEmail } from '../src/sources/applications.ts';
import { classifyReply, parseReplyEmail, type ReplyEmail } from '../src/sources/replies.ts';
import { markSubmitted } from '../src/submit/run.ts';
import { makeJob, NOW } from './helpers.ts';

const mail = (over: Partial<RawEmail> & { messageId?: string }): RawEmail & { messageId?: string } => ({
  fromName: '', fromAddress: 'talent@acme.com', subject: '', text: '', html: '', date: NOW, ...over,
});

describe('classifying replies', () => {
  it('reads English outcomes, most decisive first', () => {
    assert.equal(classifyReply('Next steps', "Thanks for your interest! We'd love to schedule a 30 minute call with our hiring manager. Please share your availability."), 'interview');
    assert.equal(classifyReply('Acme - home assignment', 'As the next stage, please complete the take-home assignment linked below within 5 days.'), 'assessment');
    assert.equal(classifyReply('Your application', 'Thank you for interviewing with us. After careful consideration, we have decided to move forward with other candidates.'), 'rejection');
    assert.equal(classifyReply('Offer', 'We are delighted to offer you the position of Integration Engineer. Your offer letter is attached.'), 'offer');
    assert.equal(classifyReply('Update', "Unfortunately, we won't be moving forward with your application at this time."), 'rejection');
  });

  it('reads Hebrew outcomes', () => {
    assert.equal(classifyReply('זימון לראיון', 'שלום, נשמח לתאם ראיון טלפוני בימים הקרובים.'), 'interview');
    assert.equal(classifyReply('עדכון לגבי מועמדותך', 'לצערנו החלטנו להתקדם עם מועמדים אחרים שמתאימים יותר לדרישות המשרה.'), 'rejection');
    assert.equal(classifyReply('המשך תהליך', 'מצורפת מטלת בית, נבקש להגיש עד יום חמישי.'), 'assessment');
  });

  it('ignores confirmations that only say what might happen next', () => {
    assert.equal(classifyReply('Thank you for applying', 'We received your application. If your profile matches, we will reach out to schedule an interview.'), null);
    assert.equal(classifyReply('תודה על פנייתך', 'קיבלנו את קורות החיים. במידה ותימצא התאמה נשמח לתאם ראיון. לצערנו לא נוכל לחזור לכל המועמדים.'), null);
    assert.equal(classifyReply('Thank you', 'Unfortunately, we are unable to respond to every applicant individually.'), null);
  });

  it('takes LinkedIn status updates, and nothing else from job sites', () => {
    const linkedin = parseReplyEmail(
      mail({ fromAddress: 'jobs-noreply@linkedin.com', subject: 'Your application to AI Builder at Grain', text: 'Unfortunately, Grain has decided not to move forward with your application.' }),
    );
    assert.deepEqual([linkedin?.kind, linkedin?.company, linkedin?.title], ['rejection', 'Grain', 'AI Builder']);
    assert.equal(parseReplyEmail(mail({ fromAddress: 'jobalerts-noreply@linkedin.com', subject: 'Acme is hiring', text: 'We would love to schedule a call' })), null);
    assert.equal(parseReplyEmail(mail({ fromAddress: 'alert@indeed.com', subject: 'Interview tips', text: "We'd love to schedule a call" })), null);
  });

  it('gives each email a stable key, so it is recorded once', () => {
    const a = parseReplyEmail(mail({ subject: 'Interview', text: "We'd like to invite you to an interview." }))!;
    const b = parseReplyEmail(mail({ subject: 'Interview', text: "We'd like to invite you to an interview." }))!;
    assert.equal(a.messageKey, b.messageKey);
    assert.equal(parseReplyEmail(mail({ messageId: '<x@acme>', subject: 'Interview', text: "We'd like to invite you to an interview." }))!.messageKey, '<x@acme>');
  });
});

function setup() {
  const store = new JobStore(':memory:');
  const apply = (over: Parameters<typeof makeJob>[0], at = '2026-09-20T09:00:00.000Z', score: number | null = null) => {
    const { id } = store.upsert(makeJob(over), NOW.toISOString());
    if (score !== null) store.saveScore(id, { score, verdict: 'good', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' }, 'shortlisted', NOW.toISOString());
    markSubmitted(store, id, null, new Date(at));
    return id;
  };
  return { store, apply };
}

const reply = (over: Partial<ReplyEmail>): ReplyEmail => ({
  kind: 'interview', fromName: '', fromAddress: 'someone@gmail.com', subject: '', receivedAt: '2026-10-01T09:00:00.000Z', messageKey: Math.random().toString(36), excerpt: '', ...over,
});

describe('matching replies to applications', () => {
  it('uses the sender domain, then name, then subject, then the body of an ATS email', () => {
    const { store, apply } = setup();
    const wsc = apply({ externalId: 'wsc:1', company: 'WSC Sports', title: 'AI Solution Manager' });
    const grain = apply({ externalId: 'grain:1', company: 'Grain', title: 'AI Builder' });
    const mize = apply({ externalId: 'mize:1', company: 'Mize Ltd', title: 'AI Product Specialist' });
    const jobs = store.appliedJobs();
    assert.equal(matchReply(reply({ fromAddress: 'dana@mail.wsc-sports.com' }), jobs)?.id, wsc);
    assert.equal(matchReply(reply({ fromName: 'Grain Hiring Team', fromAddress: 'no-reply@greenhouse.io' }), jobs)?.id, grain);
    assert.equal(matchReply(reply({ subject: 'Mize — next steps' }), jobs)?.id, mize);
    assert.equal(matchReply(reply({ fromAddress: 'no-reply@ashbyhq.com', excerpt: 'Hi, thanks for applying to Grain. We would like to schedule a call.' }), jobs)?.id, grain);
    assert.equal(matchReply(reply({ excerpt: 'Grain and Mize are both great.' }), jobs), undefined, 'two companies: ambiguous');
    assert.equal(matchReply(reply({ subject: 'Grain', receivedAt: '2026-09-01T00:00:00.000Z' }), jobs), undefined, 'before you applied');
  });

  it('picks the job the email names when you applied to several at one company', () => {
    const { store, apply } = setup();
    apply({ externalId: 'acme:1', title: 'Data Analyst' }, '2026-09-10T00:00:00.000Z');
    const eng = apply({ externalId: 'acme:2', title: 'Integration Engineer' }, '2026-09-01T00:00:00.000Z');
    const latest = apply({ externalId: 'acme:3', title: 'Solutions Architect' }, '2026-09-15T00:00:00.000Z');
    const jobs = store.appliedJobs();
    assert.equal(matchReply(reply({ fromAddress: 'hr@acme.com', subject: 'Your Integration Engineer application' }), jobs)?.id, eng);
    assert.equal(matchReply(reply({ fromAddress: 'hr@acme.com', subject: 'Next steps' }), jobs)?.id, latest);
  });

  it('records each reply once and reports callback rates by source, score and method', () => {
    const { store, apply } = setup();
    const a = apply({ source: 'email', externalId: 'linkedin:1', company: 'Grain', title: 'AI Builder' }, '2026-09-01T00:00:00.000Z', 90);
    const b = apply({ externalId: 'acme:1', company: 'Acme', title: 'Integration Engineer' }, '2026-09-01T00:00:00.000Z', 72);
    apply({ externalId: 'beta:1', company: 'Beta', title: 'Data Analyst' }, '2026-09-01T00:00:00.000Z', 60);
    apply({ externalId: 'gamma:1', company: 'Gamma', title: 'Automation Engineer' }, '2026-10-10T00:00:00.000Z', 88);

    const replies = [
      reply({ kind: 'interview', fromName: 'Grain Talent', fromAddress: 'no-reply@lever.co', messageKey: 'k1' }),
      reply({ kind: 'rejection', fromAddress: 'jobs@acme.com', receivedAt: '2026-10-05T00:00:00.000Z', messageKey: 'k2' }),
      reply({ kind: 'rejection', fromAddress: 'jobs@grain.co', receivedAt: '2026-10-06T00:00:00.000Z', messageKey: 'k3' }),
      reply({ kind: 'interview', fromAddress: 'x@unknown.io', subject: 'Hello', messageKey: 'k4' }),
    ];
    assert.deepEqual(recordReplies(store, replies, NOW.toISOString()), { recorded: { interview: 1, rejection: 2 }, unmatched: 1 });
    assert.deepEqual(recordReplies(store, replies, NOW.toISOString()), { recorded: {}, unmatched: 1 }, 'the same emails again change nothing');

    const r = outcomeReport(store, NOW);
    // Grain: interview then rejection = still a callback. Acme rejected. Beta no reply. Gamma sent 5 days ago: waiting.
    assert.deepEqual(
      [r.total.applied, r.total.callbacks, r.total.rejected, r.total.noReply, r.total.waiting],
      [4, 1, 1, 1, 1],
    );
    assert.equal(r.total.rate, 1 / 3);
    assert.deepEqual(r.bySource.map((g) => [g.label, g.applied, g.callbacks]), [['Greenhouse boards', 3, 0], ['LinkedIn alerts', 1, 1]]);
    assert.deepEqual(r.byScore.map((g) => g.label), ['Strong (85+)', 'Good (70–84)', 'Stretch (50–69)']);
    assert.equal(r.byScore[0]!.rate, 1, 'Gamma is still waiting, so only Grain counts');
    assert.deepEqual(r.byMethod.map((g) => g.label), ['You, on your own']);
    assert.deepEqual(r.recent.map((x) => [x.jobId, x.kind]), [[a, 'rejection'], [b, 'rejection'], [a, 'interview']]);
    assert.match(formatOutcomeReport(r), /Callback rate 33%/);
  });
});
