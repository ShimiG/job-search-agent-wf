import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { DEFAULT_FEEDS, alertJobToNormalized, parseAlertEmail } from '../src/sources/email-alerts.ts';
import { fixture } from './helpers.ts';

const linkedin = DEFAULT_FEEDS.find((f) => f.name === 'linkedin')!;
const drushim = DEFAULT_FEEDS.find((f) => f.name === 'drushim')!;
const indeed = DEFAULT_FEEDS.find((f) => f.name === 'indeed')!;

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

  it('produces partial jobs with remote detection', () => {
    const [, second] = parseAlertEmail(fixture('linkedin-alert.html'), linkedin);
    const job = alertJobToNormalized(second!, linkedin, new Date('2026-10-14T06:00:00Z'));
    assert.equal(job.source, 'email');
    assert.equal(job.externalId, 'linkedin:4099999999');
    assert.equal(job.descriptionIsPartial, true);
    assert.equal(job.workplaceType, 'remote');
  });
});
