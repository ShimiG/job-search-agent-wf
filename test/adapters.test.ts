import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBoardAdapter } from '../src/sources/ats.ts';
import { SourceFormatError } from '../src/sources/common.ts';
import { fakeHttp, jsonFixture } from './helpers.ts';

describe('greenhouse adapter', () => {
  it('normalizes jobs and decodes entity-encoded content', async () => {
    const http = fakeHttp({ 'boards-api.greenhouse.io/v1/boards/acme/jobs?content=true': jsonFixture('greenhouse.json') });
    const jobs = await createBoardAdapter({ ats: 'greenhouse', token: 'acme', company: 'Acme', enabled: true }).fetchJobs(http);
    assert.equal(jobs.length, 2);
    const [first, second] = jobs;
    assert.equal(first!.externalId, 'acme:7012345');
    assert.equal(first!.location, 'Tel Aviv, Israel');
    assert.equal(first!.department, 'R&D');
    assert.equal(first!.postedAt, '2026-10-08T13:00:00.000Z');
    assert.match(first!.description, /We build LLM agents/);
    assert.match(first!.description, /- 3\+ years JavaScript/);
    assert.equal(second!.workplaceType, 'remote');
  });

  it('reports a readable error when the payload shape is wrong', async () => {
    const http = fakeHttp({ greenhouse: { nope: true } });
    await assert.rejects(
      createBoardAdapter({ ats: 'greenhouse', token: 'acme', company: 'Acme', enabled: true }).fetchJobs(http),
      (err: Error) => err instanceof SourceFormatError && /greenhouse:acme/.test(err.message) && /jobs/.test(err.message),
    );
  });
});

describe('lever adapter', () => {
  it('merges description lists and uses the explicit workplace type', async () => {
    const http = fakeHttp({ 'api.lever.co/v0/postings/beta?mode=json': jsonFixture('lever.json') });
    const [job] = await createBoardAdapter({ ats: 'lever', token: 'beta', region: 'global', company: 'Beta', enabled: true }).fetchJobs(http);
    assert.equal(job!.externalId, 'beta:a1b2c3d4-0000-4000-8000-000000000001');
    assert.equal(job!.workplaceType, 'hybrid');
    assert.equal(job!.location, 'Herzliya / Tel Aviv');
    assert.equal(job!.employmentType, 'Full-time');
    assert.match(job!.description, /Requirements\n- Node\.js/);
    assert.match(job!.description, /hybrid model/);
  });

  it('uses the EU host for EU boards', async () => {
    const http = fakeHttp({ 'api.eu.lever.co': [] });
    await createBoardAdapter({ ats: 'lever', token: 'beta', region: 'eu', company: 'Beta', enabled: true }).fetchJobs(http);
    assert.match(http.calls[0]!, /^https:\/\/api\.eu\.lever\.co\//);
  });
});

describe('ashby adapter', () => {
  it('skips unlisted jobs and maps remote roles', async () => {
    const http = fakeHttp({ 'posting-api/job-board/gamma': jsonFixture('ashby.json') });
    const jobs = await createBoardAdapter({ ats: 'ashby', token: 'gamma', company: 'Gamma', enabled: true }).fetchJobs(http);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.workplaceType, 'remote');
    assert.equal(jobs[0]!.location, 'Remote / Israel');
  });
});

describe('workable adapter', () => {
  it('builds a location and keeps the apply URL', async () => {
    const http = fakeHttp({ 'widget/accounts/delta?details=true': jsonFixture('workable.json') });
    const [job] = await createBoardAdapter({ ats: 'workable', token: 'delta', company: '', enabled: true }).fetchJobs(http);
    assert.equal(job!.company, 'Delta Ltd');
    assert.equal(job!.externalId, 'delta:A1B2C3D4E5');
    assert.equal(job!.location, 'Petah Tikva, Israel');
    assert.equal(job!.applyUrl, 'https://apply.workable.com/j/A1B2C3D4E5/apply');
    assert.equal(job!.description, 'Build automations with JavaScript and APIs.');
  });
});

describe('comeet adapter', () => {
  it('orders detail sections and handles Hebrew postings', async () => {
    const http = fakeHttp({ 'careers-api/2.0/company/A1.B2C/positions?token=tok&details=true': jsonFixture('comeet.json') });
    const [job] = await createBoardAdapter({ ats: 'comeet', uid: 'A1.B2C', token: 'tok', company: 'Epsilon', enabled: true }).fetchJobs(http);
    assert.equal(job!.title, 'מפתח/ת אוטומציה');
    assert.equal(job!.workplaceType, 'hybrid');
    assert.equal(job!.url, 'https://epsilon.co.il/careers/?comeet_pos=F6.A12');
    assert.ok(job!.description.indexOf('Description') < job!.description.indexOf('Requirements'));
    assert.match(job!.description, /WhatsApp/);
  });
});
