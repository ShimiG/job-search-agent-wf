import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { DEFAULT_FEEDS, alertJobToNormalized, parseAlertEmail } from '../src/sources/email-alerts.ts';
import { EmailFeedSchema } from '../src/config.ts';
import { fixture } from './helpers.ts';

const linkedin = DEFAULT_FEEDS.find((f) => f.name === 'linkedin')!;
const drushim = DEFAULT_FEEDS.find((f) => f.name === 'drushim')!;
const indeed = DEFAULT_FEEDS.find((f) => f.name === 'indeed')!;
const alljobs = DEFAULT_FEEDS.find((f) => f.name === 'alljobs')!;
const jobmaster = DEFAULT_FEEDS.find((f) => f.name === 'jobmaster')!;
const ziprecruiter = DEFAULT_FEEDS.find((f) => f.name === 'ziprecruiter')!;
const greenhouseAlerts = DEFAULT_FEEDS.find((f) => f.name === 'greenhouse-alerts')!;

describe('alert email parser', () => {
  it('extracts one job per ID with title, company and location', () => {
    const jobs = parseAlertEmail(fixture('linkedin-alert.html'), linkedin);
    assert.equal(jobs.length, 2);
    const [first, second] = jobs;
    assert.deepEqual(first, {
      id: '4012345678',
      title: 'AI Automation Engineer',
      company: 'Acme',
      location: 'Tel Aviv-Yafo, Tel Aviv District, Israel (Hybrid)',
      url: 'https://www.linkedin.com/jobs/view/4012345678/',
    });
    assert.equal(second!.title, 'Integration Engineer');
    assert.equal(second!.company, 'Zeta Health');
    assert.equal(second!.location, 'Remote');
  });

  it('reads LinkedIn cards where the whole card is one link', () => {
    const card = (id: string, lines: string[]) =>
      `<tr><td><a href="https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=x"><table>${lines.map((l) => `<tr><td>${l}</td></tr>`).join('')}</table></a></td></tr>`;
    const html = `<table>${card('4476584424', ['Product Engineer (AI-Native)', 'Jobgether · Israel (Remote)', 'Easy Apply', 'Fast growing'])}${card('4466205729', ['AI Engineer, Backend', 'Deel · Israel (Remote)', '$60K-$130K / year', '1 school alum'])}</table>`;
    const jobs = parseAlertEmail(html, linkedin);
    assert.deepEqual(
      jobs.map((j) => [j.title, j.company, j.location]),
      [
        ['Product Engineer (AI-Native)', 'Jobgether', 'Israel (Remote)'],
        ['AI Engineer, Backend', 'Deel', 'Israel (Remote)'],
      ],
    );
  });

  it("unwraps Indeed's tracking links to the job key", () => {
    const wrap = (u: string) => `https://cts.indeed.com/v3/${gzipSync(JSON.stringify({ u })).toString('base64url')}`;
    const html = `<table><tr><td><a href="${wrap('https://il.indeed.com/rc/clk?jk=1816e1ec47bb370d&from=email')}">AI Developer</a></td></tr>
      <tr><td>Acme Medical</td></tr><tr><td>Tel Aviv</td></tr>
      <tr><td><a href="${wrap('https://profile.indeed.com?from=email')}">Edit profile</a></td></tr></table>`;
    const jobs = parseAlertEmail(html, indeed);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.url, 'https://www.indeed.com/viewjob?jk=1816e1ec47bb370d');
    assert.equal(jobs[0]!.title, 'AI Developer');
    assert.equal(jobs[0]!.company, 'Acme Medical');
  });

  it('ignores links that are not job links', () => {
    const jobs = parseAlertEmail(fixture('linkedin-alert.html'), linkedin);
    assert.ok(jobs.every((j) => /^\d+$/.test(j.id)));
  });

  it('works for another feed pattern', () => {
    const html = `<div><div><a href="https://www.drushim.co.il/job/34567890/abcd/">מפתח/ת אינטגרציות</a>
      <div>חברת אומגה</div><div>תל אביב יפו</div></div>
      <div><a href="https://www.drushim.co.il/job/34567891/efgh/">Backend Developer</a><div>Omega | Holon</div></div></div>`;
    const jobs = parseAlertEmail(html, drushim);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]!.company, 'חברת אומגה');
    assert.equal(jobs[0]!.location, 'תל אביב יפו');
    assert.equal(jobs[1]!.company, 'Omega');
    assert.equal(jobs[1]!.location, 'Holon');
  });

  it('reads Hebrew AllJobs cards: buttons, job type and posting age are skipped', () => {
    const job = (id: string, rows: string[]) =>
      `<table dir="rtl"><tr><td><a href="https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=${id}&utm_source=SmartAgent">\u202B${rows[0]}\u202C</a></td></tr>${rows
        .slice(1)
        .map((r) => `<tr><td>${r}</td></tr>`)
        .join('')}<tr><td><a href="https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=${id}&send=1">שליחת קו"ח</a></td></tr></table>`;
    const html = `<div>${job('8123456', ['מפתח/ת Full Stack', 'משרה חמה', 'אומגה מערכות', 'משרה מלאה', 'תל אביב יפו', 'פורסם לפני 2 ימים'])}${job('8123457', [
      'Backend Developer',
      'חדש',
      'חברה: Zeta Health',
      'מיקום המשרה: חיפה, היברידי',
      'סוג משרה: משרה מלאה',
      'לפרטים נוספים',
    ])}</div>`;
    const jobs = parseAlertEmail(html, alljobs);
    assert.deepEqual(
      jobs.map((j) => [j.id, j.title, j.company, j.location, j.url]),
      [
        ['8123456', 'מפתח/ת Full Stack', 'אומגה מערכות', 'תל אביב יפו', 'https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=8123456'],
        ['8123457', 'Backend Developer', 'Zeta Health', 'חיפה, היברידי', 'https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=8123457'],
      ],
    );
    const normalized = alertJobToNormalized(jobs[1]!, alljobs);
    assert.equal(normalized.externalId, 'alljobs:8123457');
    assert.equal(normalized.workplaceType, 'hybrid');
  });

  it('finds AllJobs job IDs inside redirect links and with the label on its own line', () => {
    const target = encodeURIComponent('https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=7654321');
    const html = `<table><tr><td><a href="https://mail.alljobs.co.il/track/click?url=${target}">מנהל/ת מוצר</a></td></tr>
      <tr><td>חברה:</td><td>חברת דלתא</td></tr><tr><td>אזור:</td><td>מרכז</td></tr>
      <tr><td><a href="https://www.alljobs.co.il/User/Unsubscribe.aspx">הסרה</a></td></tr></table>`;
    const jobs = parseAlertEmail(html, alljobs);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.id, '7654321');
    assert.equal(jobs[0]!.company, 'חברת דלתא');
    assert.equal(jobs[0]!.location, 'מרכז');
  });

  it('reads JobMaster alerts by the job key in the link', () => {
    const html = `<table dir="rtl"><tr><td><a href="https://www.jobmaster.co.il/jobs/checknum.asp?key=9876543&utm_source=agent">מפתח/ת Backend</a></td></tr>
      <tr><td>חברה: אומגה מערכות</td></tr><tr><td>אזור: תל אביב</td></tr>
      <tr><td><a href="https://www.jobmaster.co.il/jobs/checknum.asp?key=9876543">לצפייה במשרה</a></td></tr></table>`;
    assert.deepEqual(parseAlertEmail(html, jobmaster), [
      { id: '9876543', title: 'מפתח/ת Backend', company: 'אומגה מערכות', location: 'תל אביב', url: 'https://www.jobmaster.co.il/jobs/checknum.asp?key=9876543' },
    ]);
  });

  it("keeps ZipRecruiter's tracking link as the job's address, and skips buttons and footer links", () => {
    const link = (token: string, text: string) => `<a href="https://www.ziprecruiter.com/ekm/${token}">${text}</a>`;
    const html = `<table><tr><td>${link('AAAbbbCCC111222333xyz', 'Integration Engineer')}<div>Acme Robotics</div><div>Tel Aviv, Israel</div>${link('AAAbbbCCC111222333xyz', '1-Click Apply')}</td></tr>
      <tr><td>${link('ZZZyyyXXX999888777abc', 'Backend Developer')}<div>Beta Labs · Remote</div></td></tr>
      <tr><td>${link('FOOTERfooter0000000001', 'View All Jobs')} ${link('FOOTERfooter0000000002', 'Unsubscribe')} ${link('FOOTERfooter0000000003', 'Manage alerts')}</td></tr></table>`;
    const jobs = parseAlertEmail(html, ziprecruiter);
    assert.deepEqual(
      jobs.map((j) => [j.title, j.company, j.location, j.url]),
      [
        ['Integration Engineer', 'Acme Robotics', 'Tel Aviv, Israel', 'https://www.ziprecruiter.com/ekm/AAAbbbCCC111222333xyz'],
        ['Backend Developer', 'Beta Labs', 'Remote', 'https://www.ziprecruiter.com/ekm/ZZZyyyXXX999888777abc'],
      ],
    );
    assert.equal(alertJobToNormalized(jobs[0]!, ziprecruiter).externalId, 'ziprecruiter:AAAbbbCCC111222333xyz');
  });

  it('reads Greenhouse job alerts, whether the job is on the board or on the company site', () => {
    const html = `<div><div><a href="https://job-boards.greenhouse.io/acme/jobs/7012345?gh_src=alert">AI Automation Engineer</a><div>Tel Aviv</div></div>
      <div><a href="https://careers.beta.com/open-roles?gh_jid=5599001">Solutions Engineer</a><div>Remote</div></div>
      <div><a href="https://job-boards.greenhouse.io/acme">See all jobs at Acme</a></div></div>`;
    const jobs = parseAlertEmail(html, greenhouseAlerts);
    assert.deepEqual(
      jobs.map((j) => [j.id, j.title, j.url]),
      [
        ['7012345', 'AI Automation Engineer', 'https://job-boards.greenhouse.io/acme/jobs/7012345?gh_src=alert'],
        ['5599001', 'Solutions Engineer', 'https://careers.beta.com/open-roles?gh_jid=5599001'],
      ],
    );
  });

  it('has a feed for every board you get alerts from', () => {
    assert.deepEqual(DEFAULT_FEEDS.map((f) => f.name), ['linkedin', 'indeed', 'drushim', 'alljobs', 'jobmaster', 'ziprecruiter', 'greenhouse-alerts']);
    for (const f of DEFAULT_FEEDS) assert.doesNotThrow(() => EmailFeedSchema.parse(f), f.name);
    assert.throws(() => EmailFeedSchema.parse({ name: 'x', from: 'x.com', linkPattern: 'x/(\\d+)', urlTemplate: 'https://x.com/job' }), /\{id\} or \{link\}/);
  });

  it('produces partial jobs with remote detection', () => {
    const [, second] = parseAlertEmail(fixture('linkedin-alert.html'), linkedin);
    const job = alertJobToNormalized(second!, linkedin, new Date('2026-10-14T06:00:00Z'));
    assert.equal(job.source, 'email');
    assert.equal(job.externalId, 'linkedin:4099999999');
    assert.equal(job.descriptionIsPartial, true);
    assert.equal(job.workplaceType, 'remote');
  });
});
