import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { worthReading } from '../src/archiver/classify.ts';
import { ARCHIVE_AFTER_DAYS, buildReport, formatReport, groupApplications, isArchived, matchApplication } from '../src/archiver/report.ts';
import { JobStore, type ResponseRecord, type SentApplication } from '../src/db/store.ts';
import { markSubmitted } from '../src/submit/run.ts';
import { makeJob, NOW } from './helpers.ts';

let nextId = 1;
const sent = (company: string, title: string, appliedAt: string, via = 'this tool'): SentApplication => {
  const id = nextId++;
  return { job: { ...makeJob({ company, title }), id } as SentApplication['job'], appliedAt, via, outcome: null, archiveChoice: null };
};
const reply = (over: Partial<ResponseRecord>): ResponseRecord => ({
  id: nextId++,
  messageId: `m${nextId}`,
  jobId: null,
  receivedAt: '2026-10-12T09:00:00.000Z',
  fromName: '',
  fromAddress: 'no-reply@us.greenhouse-mail.io',
  subject: '',
  kind: 'rejection',
  company: '',
  title: '',
  summary: '',
  action: '',
  model: 'test',
  ...over,
});

describe('archiver', () => {
  it('reads only emails that may be about an application', () => {
    const companies = ['mize', 'similarweb'];
    const yes = (fromName: string, fromAddress: string, subject: string) => worthReading({ fromName, fromAddress, subject }, companies, 'me@example.com');
    assert.equal(yes('Similarweb Hiring Team', 'no-reply@us.greenhouse-mail.io', 'Thank you'), true);
    assert.equal(yes('Dana Cohen', 'dana@mize.ai', 'Quick chat?'), true);
    assert.equal(yes('Acme', 'jobs@acme.com', 'Your application to Acme'), true);
    assert.equal(yes('Acme', 'jobs@acme.com', 'הזמנה לראיון'), true);
    assert.equal(yes('LinkedIn', 'jobalerts-noreply@linkedin.com', 'New jobs for you: AI Engineer'), false);
    assert.equal(yes('Acme', 'security@acme.com', 'Your verification code'), false);
    assert.equal(yes('Me', 'me@example.com', 'Re: application'), false);
    assert.equal(yes('Shop', 'deals@shop.com', 'Weekend sale'), false);
    assert.equal(yes('LinkedIn', 'notifications-noreply@linkedin.com', 'Your application activity this week'), false);
    assert.equal(yes('Indeed', 'donotreply@match.indeed.com', 'AI Engineer position near you'), false);
    assert.equal(yes('LinkedIn', 'jobs-noreply@linkedin.com', 'Dana, your application was sent to Mize'), true);
  });

  it('counts the same job applied to twice (LinkedIn and the company site) once', () => {
    const rows = groupApplications([
      sent('Mize', 'AI Product Specialist', '2026-10-01T10:00:00.000Z', 'LinkedIn'),
      sent('Mize', 'AI Product Specialist', '2026-10-01T10:01:00.000Z', 'company site'),
      sent('Mize', '(title not in the email)', '2026-10-01T10:02:00.000Z', 'company site'),
      sent('Mize', 'Data Engineer', '2026-10-05T10:00:00.000Z'),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]!.via, ['LinkedIn', 'company site']);
    assert.equal(rows[0]!.jobIds.length, 3);
  });

  it('matches a reply by company, then by the closest title, and only to earlier applications', () => {
    const apps = groupApplications([
      sent('Similarweb', 'Agent Platform Engineer', '2026-10-01T10:00:00.000Z'),
      sent('Similarweb', 'Data Analyst', '2026-10-02T10:00:00.000Z'),
      sent('Kaltura', 'Forward Deployed Engineer', '2026-10-20T10:00:00.000Z'),
    ]);
    const [platform, analyst, kaltura] = apps.map((a) => a.jobIds[0]);
    assert.equal(matchApplication(reply({ company: 'Similarweb', title: 'Agent Platform Engineer' }), apps), platform);
    // Company from the sender's name; no title: the latest application there.
    assert.equal(matchApplication(reply({ fromName: 'Similarweb Hiring Team' }), apps), analyst);
    // Kaltura's application was sent after this email arrived.
    assert.equal(matchApplication(reply({ company: 'Kaltura' }), apps), null);
    assert.equal(matchApplication(reply({ company: 'Kaltura', receivedAt: '2026-10-22T09:00:00.000Z' }), apps), kaltura);
    assert.equal(matchApplication(reply({ company: 'Wix', title: 'Agent Platform Engineer' }), apps), null);
  });

  it("keeps each application's furthest stage, and the totals", () => {
    const apps = [
      sent('A', 'Engineer', '2026-09-01T10:00:00.000Z'),
      sent('B', 'Engineer', '2026-09-20T10:00:00.000Z'),
      sent('C', 'Engineer', '2026-10-10T10:00:00.000Z'),
      sent('D', 'Engineer', '2026-10-11T10:00:00.000Z'),
    ];
    const [a, b, c, d] = apps.map((x) => x.job.id);
    const responses = [
      reply({ jobId: a, kind: 'confirmation', receivedAt: '2026-09-01T10:05:00.000Z' }),
      reply({ jobId: a, kind: 'interview', receivedAt: '2026-09-05T10:00:00.000Z' }),
      reply({ jobId: a, kind: 'rejection', receivedAt: '2026-09-12T10:00:00.000Z' }),
      reply({ jobId: b, kind: 'assessment', receivedAt: '2026-09-22T10:00:00.000Z', action: 'Submit the task by Sunday' }),
      reply({ jobId: c, kind: 'viewed', receivedAt: '2026-10-11T10:00:00.000Z' }),
      reply({ company: 'Unknown Ltd', kind: 'interview', receivedAt: '2026-10-12T10:00:00.000Z' }),
    ];
    const report = buildReport(apps, responses, NOW);
    const stage = (id: number) => report.rows.find((r) => r.jobIds[0] === id)!.stage;
    assert.equal(stage(a!), 'rejected');
    assert.equal(stage(b!), 'assessment');
    assert.equal(stage(c!), 'viewed');
    assert.equal(stage(d!), 'awaiting');
    const s = report.stats;
    assert.deepEqual([s.applied, s.rejected, s.assessment, s.viewed, s.awaiting, s.unmatched], [4, 1, 1, 1, 1, 1]);
    assert.equal(s.responseRate, 0.5);
    assert.equal(s.interviewRate, 0.25);
    // A's interview came 4 days in, B's assessment 2 days in.
    assert.equal(s.avgDaysToReply, 3);
    const text = formatReport(report, NOW);
    assert.match(text, /\| 4 \| 1 \| 1 \| 1 \| 0 \| 0 \| 1 \|/);
    assert.match(text, /To do:\*\* Submit the task by Sunday/);
    assert.match(text, /Replies not matched to an application \(1\)/);
  });

  it('stores replies once and lists applications with how they were sent', () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsert(makeJob({ company: 'Mize', title: 'AI Product Specialist' }), NOW.toISOString());
    markSubmitted(store, id, 'you applied on LinkedIn on 2026-10-14', new Date('2026-10-14T10:00:00.000Z'));
    const [app] = store.sentApplications();
    assert.equal(app!.via, 'LinkedIn');
    assert.equal(app!.appliedAt, '2026-10-14T10:00:00.000Z');
    const r = { messageId: '<x@mize>', jobId: id, receivedAt: NOW.toISOString(), fromName: 'Mize', fromAddress: 'hr@mize.ai', subject: 'Interview', kind: 'interview', company: 'Mize', title: '', summary: 'They want to talk.', action: '', model: 'test' };
    store.saveResponse(r, NOW.toISOString());
    store.saveResponse(r, NOW.toISOString());
    store.saveResponse({ ...r, messageId: '<y@shop>', kind: 'not_related', jobId: null }, NOW.toISOString());
    assert.equal(store.responses().length, 1);
    assert.equal(store.hasResponse('<y@shop>'), true);
    store.close();
  });

  it('lets you set a stage by hand until a newer reply arrives', () => {
    const app = { ...sent('Acme', 'Engineer', '2026-10-01T10:00:00.000Z'), outcome: { stage: 'interview', at: '2026-10-05T10:00:00.000Z' } };
    const id = app.job.id;
    const before = buildReport([app], [reply({ jobId: id, kind: 'viewed', receivedAt: '2026-10-03T10:00:00.000Z' })], NOW);
    assert.equal(before.rows[0]!.stage, 'interview');
    assert.equal(before.rows[0]!.manual, true);
    assert.equal(before.stats.interviewRate, 1);
    const after = buildReport([app], [reply({ jobId: id, kind: 'rejection', receivedAt: '2026-10-08T10:00:00.000Z' })], NOW);
    assert.equal(after.rows[0]!.stage, 'rejected');
    assert.equal(after.rows[0]!.manual, false);
  });

  it('archives applications left unsent for two weeks, and restores them', () => {
    const store = new JobStore(':memory:');
    const old = store.upsert(makeJob({ externalId: 'a:1', title: 'Old' }), '2026-09-01T00:00:00.000Z').id;
    const fresh = store.upsert(makeJob({ externalId: 'a:2', title: 'Fresh' }), '2026-09-01T00:00:00.000Z').id;
    store.setStatus(old, 'tailored', 'test', 'tailor', '2026-09-20T00:00:00.000Z');
    store.setStatus(fresh, 'tailored', 'test', 'tailor', '2026-10-10T00:00:00.000Z');
    const archived = store.archiveStale(14, NOW);
    assert.deepEqual(archived.map((j) => j.id), [old]);
    assert.equal(store.get(old)!.status, 'archived');
    assert.equal(store.get(fresh)!.status, 'tailored');
    assert.equal(store.restoreArchived(old, NOW.toISOString()), 'tailored');
    assert.equal(store.get(old)!.status, 'tailored');
    store.close();
  });

  it('merges the same application under different names, and cleans up titles', () => {
    const rows = groupApplications([
      sent('Noma', 'AI Builder', '2026-10-25T10:00:00.000Z', 'marked by you'),
      sent('taking the next steps in your career at Noma Security', 'AI Builder@ Noma Security 💙', '2026-10-25T10:05:00.000Z', 'company site'),
      sent('Ocean Security', 'AI Engineer- Detection & Agents', '2026-10-19T10:00:00.000Z', 'company site'),
      sent('Ocean', 'AI Engineer- Detection & Agents', '2026-10-19T10:01:00.000Z', 'LinkedIn'),
      sent('Cyera', 'Solution Architect - Cyera Identity', '2026-10-18T10:00:00.000Z', 'company site'),
      sent('Unknown company', 'Solution Architect - Cyera Identity', '2026-10-18T10:01:00.000Z', 'Indeed'),
      sent('InfinityLabs R&D', 'Junior Software Engineer', '2026-10-15T10:00:00.000Z', 'LinkedIn'),
      sent('Infinity Labs R&D', '(title not in the email)', '2026-10-15T10:01:00.000Z', 'company site'),
      sent('Base44', 'Forward Deployed Engineer', '2026-10-25T10:00:00.000Z'),
      sent('Base44', 'AI Marketing Builder', '2026-10-10T10:00:00.000Z'),
    ]);
    const shown = rows.map((r) => `${r.company} | ${r.title} | ${r.via.join('+')}`).sort();
    assert.deepEqual(shown, [
      'Base44 | AI Marketing Builder | this tool',
      'Base44 | Forward Deployed Engineer | this tool',
      'Cyera | Solution Architect - Cyera Identity | company site+Indeed',
      'InfinityLabs R&D | Junior Software Engineer | LinkedIn+company site',
      'Noma | AI Builder | marked by you+company site',
      'Ocean | AI Engineer- Detection & Agents | company site+LinkedIn',
    ]);
  });
});

describe('Applied and the Archive', () => {
  const now = new Date('2026-11-20T09:00:00.000Z');
  const rowFor = (app: SentApplication, replies: ResponseRecord[] = []) => buildReport([app], replies, now).rows[0]!;

  it('archives an application 30 days after you applied, whatever its stage', () => {
    assert.equal(isArchived(rowFor(sent('Acme', 'Engineer', '2026-10-25T10:00:00.000Z')), now), false);
    const old = sent('Globex', 'Engineer', '2026-10-21T08:00:00.000Z');
    assert.equal(isArchived(rowFor(old), now), true, `${ARCHIVE_AFTER_DAYS} days after applying`);
    const interviewing = rowFor(old, [reply({ jobId: old.job.id, kind: 'interview', receivedAt: '2026-11-19T10:00:00.000Z' })]);
    assert.equal(interviewing.stage, 'interview');
    assert.equal(isArchived(interviewing, now), true, 'no matter its stage');
  });

  it('archives a rejection you set yourself at once, but not one read from email', () => {
    const app = sent('Acme', 'Engineer', '2026-11-15T10:00:00.000Z');
    const emailed = rowFor(app, [reply({ jobId: app.job.id, kind: 'rejection', receivedAt: '2026-11-18T10:00:00.000Z' })]);
    assert.equal(emailed.stage, 'rejected');
    assert.equal(isArchived(emailed, now), false, 'stays in Applied until its 30 days are up');
    const byYou = rowFor({ ...sent('Initech', 'Engineer', '2026-11-15T10:00:00.000Z'), outcome: { stage: 'rejected', at: '2026-11-16T10:00:00.000Z' } });
    assert.equal(isArchived(byYou, now), true);
  });

  it('follows your choice from the buttons over the rules', () => {
    const fresh = { ...sent('Acme', 'Engineer', '2026-11-18T10:00:00.000Z'), archiveChoice: 'archived' as const };
    assert.equal(isArchived(rowFor(fresh), now), true, 'Send to archive');
    const old = { ...sent('Globex', 'Engineer', '2026-09-01T10:00:00.000Z'), archiveChoice: 'applied' as const };
    assert.equal(isArchived(rowFor(old), now), false, 'Back to Applied, though older than 30 days');
  });

  it('takes the choice made on any record of the application', () => {
    const a = sent('Acme', 'Engineer', '2026-11-18T10:00:00.000Z', 'LinkedIn');
    const b = { ...sent('Acme', 'Engineer', '2026-11-18T11:00:00.000Z'), archiveChoice: 'archived' as const };
    const rows = buildReport([a, b], [], now).rows;
    assert.equal(rows.length, 1);
    assert.equal(isArchived(rows[0]!, now), true);
  });
});
