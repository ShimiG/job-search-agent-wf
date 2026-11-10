import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { normalizeJobUrl, recordApplications, sweepAppliedListings } from '../src/pipeline/applied.ts';
import { decideDuplicate } from '../src/pipeline/dedupe.ts';
import { parseAppliedEmail, type AppliedEmail, type RawEmail } from '../src/sources/applications.ts';
import { makeJob, NOW } from './helpers.ts';

const mail = (over: Partial<RawEmail>): RawEmail => ({ fromName: '', fromAddress: 'no-reply@example.com', subject: '', text: '', html: '', date: NOW, ...over });
const parsed = (over: Partial<RawEmail>) => {
  const p = parseAppliedEmail(mail(over));
  return p && { via: p.via, company: p.company, title: p.title, linkedinId: p.linkedinId, rejected: p.rejected };
};

describe('application confirmation emails', () => {
  it('reads LinkedIn, with the job ID', () => {
    assert.deepEqual(
      parsed({
        fromName: 'LinkedIn',
        fromAddress: 'jobs-noreply@linkedin.com',
        subject: 'Dana, your application was sent to Mize',
        text: 'Your application was sent to Mize\nAI Product Specialist\nMize\nTel Aviv-Yafo\nView job: https://www.linkedin.com/comm/jobs/view/4479965510/?trackingId=x',
      }),
      { via: 'linkedin', company: 'Mize', title: 'AI Product Specialist', linkedinId: '4479965510', rejected: false },
    );
  });

  it('reads Indeed, which only names the job', () => {
    assert.deepEqual(
      parsed({ fromName: 'Indeed Apply', fromAddress: 'indeedapply@indeed.com', subject: 'Indeed Application: AI Solution Manager', text: 'Your application has been submitted. Good luck!' }),
      { via: 'indeed', company: '', title: 'AI Solution Manager', linkedinId: undefined, rejected: false },
    );
  });

  it("reads company sites' wordings, taking the company from the sender when the text doesn't say", () => {
    const cases: Array<[Partial<RawEmail>, string, string]> = [
      [{ subject: 'Thank you for applying to Cast AI', text: 'We will review your application for AI Solutions Architect shortly.' }, 'Cast AI', 'AI Solutions Architect'],
      [{ fromName: 'Mize', subject: 'We Got It: Thanks for applying for AI Product Specialist', text: 'Thank you for applying for a position at Mize.' }, 'Mize', 'AI Product Specialist'],
      [{ subject: 'Touchdown! LSports Received Your Application for AI Business Automation Engineer' }, 'LSports', 'AI Business Automation Engineer'],
      [{ fromName: 'Kaltura', subject: 'Your application is in!', text: 'Hi Dana\nWe’ve received your application for the Forward Deployed Engineer position.' }, 'Kaltura', 'Forward Deployed Engineer'],
      [{ fromName: 'EY Talent Acquisition', subject: 'Thank you for applying to EY', text: 'Thank you for your interest in EY and the Junior Technology Consultant role.' }, 'EY', 'Junior Technology Consultant'],
      [{ subject: 'Thanks for applying for AI Innovation Builder at eTeacher Group- Please complete the questionnaire' }, 'eTeacher Group', 'AI Innovation Builder'],
    ];
    for (const [over, company, title] of cases) {
      const p = parsed(over);
      assert.deepEqual([p?.company, p?.title], [company, title], over.subject);
    }
  });

  it('notices rejections, which still mean you applied', () => {
    const p = parsed({
      subject: 'Thank you for applying for the AI Builder position at Grain',
      text: 'After careful consideration, we have decided to proceed with other candidates at this time.',
    });
    assert.deepEqual([p?.company, p?.title, p?.rejected], ['Grain', 'AI Builder', true]);
  });

  it('ignores mail that is not about an application you sent', () => {
    assert.equal(parsed({ fromAddress: 'jobalerts-noreply@linkedin.com', subject: 'AI Engineer at Reindeer', text: 'Apply now. Easy Apply.' }), null);
    assert.equal(parsed({ subject: 'Update regarding InfinityLabs R&D training', text: 'We recently received your CV and tried to contact you.' }), null);
  });
});

describe('recording applications', () => {
  const app = (over: Partial<AppliedEmail>): AppliedEmail => ({
    company: '', title: '', via: 'company', appliedAt: '2026-10-12T09:00:00.000Z', rejected: false, subject: 'Thank you for applying', ...over,
  });
  const add = (store: JobStore, over: Parameters<typeof makeJob>[0], status: Parameters<JobStore['setStatus']>[1], opts = {}) => {
    const { id } = store.upsert(makeJob(over), NOW.toISOString());
    store.setStatus(id, status, null, 'scout', NOW.toISOString(), opts);
    return id;
  };

  it('marks jobs already in the database, by LinkedIn ID or by company and title', () => {
    const store = new JobStore(':memory:');
    const alert = add(store, { source: 'email', externalId: 'linkedin:4479965510', company: 'Mize', title: 'AI Product Specialist' }, 'shortlisted');
    const board = add(store, { source: 'greenhouse', externalId: 'yad2:1', company: 'yad2', title: 'AI Engineer' }, 'queued');
    const stats = recordApplications(
      store,
      [app({ via: 'linkedin', company: 'Mize', title: 'AI Product Specialist', linkedinId: '4479965510' }), app({ company: 'Yad2', title: 'AI Engineer' })],
      NOW.toISOString(),
    );
    assert.deepEqual(stats, { matched: 2, added: 0 });
    for (const id of [alert, board]) {
      assert.equal(store.get(id)!.status, 'submitted');
      assert.equal(store.submissions(id)[0]!.createdAt, '2026-10-12T09:00:00.000Z', 'dated when you applied');
    }
    assert.match(store.get(alert)!.statusReason!, /you applied on LinkedIn on 2026-10-12/);
  });

  it("marks a duplicate's canonical job, the one on your shortlist", () => {
    const store = new JobStore(':memory:');
    const canonical = add(store, { source: 'greenhouse', externalId: 'g:1', company: 'Grain', title: 'AI Builder' }, 'shortlisted');
    add(store, { source: 'email', externalId: 'linkedin:42', company: 'Grain', title: 'AI Builder' }, 'duplicate', { duplicateOf: canonical });
    recordApplications(store, [app({ via: 'linkedin', company: 'Grain', title: 'AI Builder', linkedinId: '42' })], NOW.toISOString());
    assert.equal(store.get(canonical)!.status, 'submitted');
  });

  it('adds unseen applications once, so later postings of them are caught as duplicates', () => {
    const store = new JobStore(':memory:');
    const emails = [
      app({ via: 'linkedin', company: 'Cast AI', title: 'AI Solutions Architect', linkedinId: '777' }),
      app({ company: 'Cast AI', title: 'AI Solutions Architect' }), // the company's own email for the same application
      app({ company: 'Cast AI' }), // "Thank you for applying to Cast AI"
      app({ via: 'indeed', title: 'Technical Onboarding Manager' }),
    ];
    assert.deepEqual(recordApplications(store, emails, NOW.toISOString()), { matched: 0, added: 2 });
    assert.deepEqual(recordApplications(store, emails, NOW.toISOString()), { matched: 0, added: 0 }, 'running again changes nothing');
    assert.equal(store.recentSubmissionsToCompany('cast ai', '2026-10-01T00:00:00.000Z'), 1);

    // A week later Cast AI's board lists the same job: it's a duplicate, not a new shortlist entry.
    const { id } = store.upsert(makeJob({ source: 'greenhouse', externalId: 'cast:9', company: 'Cast AI', title: 'AI Solutions Architect' }), NOW.toISOString());
    const job = store.get(id)!;
    assert.equal(decideDuplicate(job, store.dedupeCandidates(job.normCompany, id)).kind, 'duplicate');
  });

  it('matches Indeed applications by title only when exactly one job has it', () => {
    const store = new JobStore(':memory:');
    const only = add(store, { source: 'email', externalId: 'indeed:a', company: 'Acme', title: 'AI Solution Manager' }, 'queued');
    add(store, { source: 'email', externalId: 'indeed:b', company: 'Beta', title: 'Integration Engineer' }, 'queued');
    add(store, { source: 'email', externalId: 'indeed:c', company: 'Gamma', title: 'Integration Engineer' }, 'queued');
    const stats = recordApplications(store, [app({ via: 'indeed', title: 'AI Solution Manager' }), app({ via: 'indeed', title: 'Integration Engineer' })], NOW.toISOString());
    assert.deepEqual(stats, { matched: 1, added: 1 });
    assert.equal(store.get(only)!.status, 'submitted');
  });
});

describe('removing listings of jobs you applied to', () => {
  const add = (store: JobStore, over: Parameters<typeof makeJob>[0], status: Parameters<JobStore['setStatus']>[1]) => {
    const { id } = store.upsert(makeJob(over), NOW.toISOString());
    if (status !== 'discovered') store.setStatus(id, status, status === 'submitted' ? 'you applied on LinkedIn on 2026-10-12' : null, 'scout', NOW.toISOString());
    return id;
  };

  it('takes other listings of an applied job off the shortlist and out of the queue, across boards and alert feeds', () => {
    const store = new JobStore(':memory:');
    const applied = add(store, { source: 'email', externalId: 'linkedin:1', company: 'Mize Ltd', title: 'AI Product Specialist', location: 'Tel Aviv-Yafo, Israel' }, 'submitted');
    const shortlisted = add(store, { source: 'email', externalId: 'drushim:5', company: 'Mize', title: 'AI Product Specialist', location: 'תל אביב יפו', url: 'https://www.drushim.co.il/job/5/' }, 'shortlisted');
    const repost = add(store, { source: 'greenhouse', externalId: 'mize:9', company: 'Mize', title: 'AI Product Specialist (m/f/d)', url: 'https://example.com/9' }, 'discovered');
    const other = add(store, { source: 'greenhouse', externalId: 'mize:10', company: 'Mize', title: 'Senior AI Product Specialist', url: 'https://example.com/10' }, 'queued');

    assert.deepEqual(sweepAppliedListings(store, NOW.toISOString()), { applied: 2, inProgress: 0 });
    for (const id of [shortlisted, repost]) {
      const job = store.get(id)!;
      assert.equal(job.status, 'duplicate');
      assert.equal(job.duplicateOf, applied);
      assert.match(job.statusReason!, /you already applied to this job \(#\d+: you applied on LinkedIn/);
    }
    assert.equal(store.get(other)!.status, 'queued', 'a different level is a different job');
    assert.deepEqual(sweepAppliedListings(store, NOW.toISOString()), { applied: 0, inProgress: 0 }, 'running again changes nothing');
  });

  it('matches the same job page whatever the company is called, and ignores tracking parameters', () => {
    const store = new JobStore(':memory:');
    add(store, { source: 'email', externalId: 'alljobs:7', company: 'חברה חסויה', title: 'מפתח/ת Full Stack', url: 'https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=7' }, 'submitted');
    const again = add(
      store,
      { source: 'email', externalId: 'alljobs-2:7', company: 'Omega', title: 'Full Stack Developer', url: 'https://alljobs.co.il/Search/UploadSingle.aspx?utm_source=agent&JobID=7' },
      'shortlisted',
    );
    sweepAppliedListings(store, NOW.toISOString());
    assert.equal(store.get(again)!.status, 'duplicate');
    assert.equal(normalizeJobUrl('https://acme.com/'), null, 'a home page is not a job page');
  });

  it('keeps a same-board opening in another city, and files jobs being applied to separately', () => {
    const store = new JobStore(':memory:');
    add(store, { externalId: 'acme:1', title: 'Automation Engineer', location: 'Tel Aviv', url: 'https://example.com/1' }, 'submitted');
    const haifa = add(store, { externalId: 'acme:2', title: 'Automation Engineer', location: 'Haifa', url: 'https://example.com/2' }, 'shortlisted');
    const approved = add(store, { externalId: 'acme:3', title: 'Integration Engineer', url: 'https://example.com/3' }, 'approved');
    const alert = add(store, { source: 'email', externalId: 'linkedin:3', title: 'Integration Engineer', url: 'https://www.linkedin.com/jobs/view/3/' }, 'shortlisted');
    assert.deepEqual(sweepAppliedListings(store, NOW.toISOString()), { applied: 0, inProgress: 1 });
    assert.equal(store.get(haifa)!.status, 'shortlisted');
    assert.equal(store.get(alert)!.duplicateOf, approved);
    assert.match(store.get(alert)!.statusReason!, /already being applied to as #\d+ \(approved\)/);
  });

  it("matches Indeed applications, which don't name the company, to the one Indeed listing with that title", () => {
    const store = new JobStore(':memory:');
    recordApplications(store, [{ company: '', title: 'AI Solution Manager', via: 'indeed', appliedAt: '2026-10-12T09:00:00.000Z', rejected: false, subject: 'Indeed Application: AI Solution Manager' }], NOW.toISOString());
    const later = add(store, { source: 'email', externalId: 'indeed:abc', company: 'Acme', title: 'AI Solution Manager' }, 'discovered');
    const elsewhere = add(store, { source: 'greenhouse', externalId: 'beta:1', company: 'Beta', title: 'AI Solution Manager' }, 'queued');
    sweepAppliedListings(store, NOW.toISOString());
    assert.equal(store.get(later)!.status, 'duplicate');
    assert.equal(store.get(elsewhere)!.status, 'queued', 'another company, not from Indeed');
  });
});
