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

describe('workday adapter', () => {
  const board = { ats: 'workday' as const, host: 'acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'AcmeCareers', company: 'Acme', search: [] as string[], maxJobs: 200, enabled: true };
  const listing = (i: number) => ({ title: `Engineer ${i}`, externalPath: `/job/Tel-Aviv/Engineer-${i}_JR${100 + i}`, locationsText: 'Tel Aviv', postedOn: 'Posted 3 Days Ago', bulletFields: [`JR${100 + i}`] });
  const page = (total: number) => (body: { offset: number; limit: number }) => ({
    total: body.offset === 0 ? total : 0, // some tenants only send the total on the first page
    jobPostings: Array.from({ length: Math.max(0, Math.min(body.limit, total - body.offset)) }, (_, k) => listing(body.offset + k)),
  });
  const detail = (_: unknown, url: string) => {
    const i = Number(/Engineer-(\d+)_/.exec(url)![1]);
    return {
      jobPostingInfo: {
        title: `Engineer ${i}`,
        jobDescription: '<p>Build <b>integrations</b>.</p><ul><li>Node.js</li></ul>',
        location: 'Tel Aviv, Israel',
        additionalLocations: ['Haifa, Israel'],
        timeType: 'Full time',
        startDate: '2026-10-01',
        jobReqId: `JR${100 + i}`,
        externalUrl: `https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers/job/Tel-Aviv/Engineer-${i}_JR${100 + i}`,
        remoteType: 'Hybrid',
      },
      hiringOrganization: { name: 'Acme Inc.' },
    };
  };

  it('pages through the list 20 at a time, then reads each full posting', async () => {
    const http = fakeHttp({ '/wday/cxs/acme/AcmeCareers/jobs': page(25), '/wday/cxs/acme/AcmeCareers/job/': detail });
    const adapter = createBoardAdapter(board);
    const jobs = await adapter.fetchJobs(http);
    assert.equal(jobs.length, 25);
    assert.deepEqual(http.posts.map((p) => (p as { offset: number; limit: number }).offset), [0, 20]);
    assert.equal((http.posts[0] as { limit: number }).limit, 20);
    const [first] = jobs;
    assert.equal(adapter.key, 'workday:acme/AcmeCareers');
    assert.equal(first!.externalId, 'acme/AcmeCareers:JR100');
    assert.match(first!.location, /Tel Aviv, Israel.*Haifa, Israel/);
    assert.equal(first!.workplaceType, 'hybrid');
    assert.match(first!.description, /Build integrations\./);
    assert.match(first!.description, /Node\.js/);
    assert.equal(first!.descriptionIsPartial, false);
    assert.equal(first!.postedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(first!.employmentType, 'Full time');
    assert.match(first!.url, /en-US\/AcmeCareers\/job\/Tel-Aviv\/Engineer-0_JR100$/);
    assert.equal(adapter.lastFetchComplete!(), true);
  });

  it('stops at maxJobs and reports the fetch as incomplete, so nothing it skipped gets closed', async () => {
    const http = fakeHttp({ '/jobs': page(500), '/job/': detail });
    const adapter = createBoardAdapter({ ...board, maxJobs: 30 });
    assert.equal((await adapter.fetchJobs(http)).length, 30);
    assert.equal(adapter.lastFetchComplete!(), false);
    assert.equal(http.posts.length, 2);
  });

  it('runs each search term and merges the results', async () => {
    const http = fakeHttp({
      '/jobs': (body: { searchText: string }) => ({ total: 2, jobPostings: body.searchText === 'automation' ? [listing(1), listing(2)] : [listing(2), listing(3)] }),
      '/job/': detail,
    });
    const jobs = await createBoardAdapter({ ...board, search: ['automation', 'integration'] }).fetchJobs(http);
    assert.deepEqual(jobs.map((j) => j.externalId), ['acme/AcmeCareers:JR101', 'acme/AcmeCareers:JR102', 'acme/AcmeCareers:JR103']);
    assert.deepEqual(http.posts.map((p) => (p as { searchText: string }).searchText), ['automation', 'integration']);
  });

  it('keeps the summary when one posting fails, and fails loudly when no posting matches the format', async () => {
    const http = fakeHttp({ '/jobs': page(2), '/job/Tel-Aviv/Engineer-1_': new Error('HTTP 500'), '/job/': detail });
    const jobs = await createBoardAdapter(board).fetchJobs(http);
    assert.equal(jobs[1]!.descriptionIsPartial, true);
    assert.equal(jobs[1]!.externalId, 'acme/AcmeCareers:JR101', 'same ID either way');
    assert.ok(jobs[1]!.postedAt, 'dated from "Posted 3 Days Ago"');

    const changed = fakeHttp({ '/jobs': page(2), '/job/': { somethingElse: true } });
    await assert.rejects(createBoardAdapter(board).fetchJobs(changed), (err: Error) => err instanceof SourceFormatError && /job details/.test(err.message));
  });
});

describe('smartrecruiters adapter', () => {
  const board = { ats: 'smartrecruiters' as const, token: 'AcmeCo', company: 'Acme', search: [] as string[], maxJobs: 200, enabled: true };
  const summary = (i: number) => ({
    id: String(7440000 + i),
    name: `Integration Engineer ${i}`,
    releasedDate: '2026-10-05T10:00:00.000Z',
    location: { city: 'Tel Aviv', country: 'il', remote: i === 0 },
    typeOfEmployment: { label: 'Full-time' },
    department: { label: 'R&D' },
    company: { name: 'Acme Co' },
  });
  const list = (total: number) => (_: unknown, url: string) => {
    const offset = Number(/offset=(\d+)/.exec(url)![1]);
    return { totalFound: total, content: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, k) => summary(offset + k)) };
  };
  const detail = (_: unknown, url: string) => ({
    name: `Integration Engineer ${Number(/postings\/(\d+)/.exec(url)![1]) - 7440000}`,
    postingUrl: `https://jobs.smartrecruiters.com/AcmeCo/${/postings\/(\d+)/.exec(url)![1]}-integration-engineer`,
    applyUrl: `https://jobs.smartrecruiters.com/AcmeCo/${/postings\/(\d+)/.exec(url)![1]}-integration-engineer?oga=true`,
    jobAd: {
      sections: {
        companyDescription: { title: 'Company Description', text: '<p>We make tools.</p>' },
        jobDescription: { title: 'Job Description', text: '<p>Own our <b>REST</b> integrations.</p>' },
        qualifications: { title: 'Qualifications', text: '<ul><li>3 years Node.js</li></ul>' },
      },
    },
  });

  it('reads summaries, then full ads with apply links', async () => {
    const http = fakeHttp({ 'companies/AcmeCo/postings?': list(2), 'companies/AcmeCo/postings/': detail });
    const adapter = createBoardAdapter(board);
    const [remote, office] = await adapter.fetchJobs(http);
    assert.equal(adapter.key, 'smartrecruiters:AcmeCo');
    assert.equal(remote!.externalId, 'AcmeCo:7440000');
    assert.equal(remote!.workplaceType, 'remote');
    assert.equal(office!.location, 'Tel Aviv, Israel');
    assert.match(office!.description, /^Job Description\nOwn our REST integrations\./);
    assert.match(office!.description, /Qualifications\n- 3 years Node\.js/);
    assert.match(office!.description, /We make tools\.$/, 'the company blurb goes last');
    assert.match(office!.url, /jobs\.smartrecruiters\.com\/AcmeCo\/7440001-integration-engineer$/);
    assert.match(office!.applyUrl!, /\?oga=true$/);
    assert.equal(office!.postedAt, '2026-10-05T10:00:00.000Z');
    assert.equal(office!.department, 'R&D');
    assert.equal(adapter.lastFetchComplete!(), true);
  });

  it('pages 100 at a time and stops at maxJobs', async () => {
    const http = fakeHttp({ 'postings?': list(250), 'postings/': detail });
    const adapter = createBoardAdapter({ ...board, maxJobs: 150 });
    assert.equal((await adapter.fetchJobs(http)).length, 150);
    assert.equal(adapter.lastFetchComplete!(), false);
    assert.deepEqual(http.calls.filter((u) => u.includes('postings?')).map((u) => /offset=(\d+)/.exec(u)![1]), ['0', '100']);
  });
});

describe('http client', () => {
  it('sends JSON POST bodies, for Workday lists', async () => {
    const { FetchHttp } = await import('../src/sources/http.ts');
    let seen: RequestInit | undefined;
    const http = new FetchHttp({
      retries: 0,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init;
        return new Response(JSON.stringify({ total: 0, jobPostings: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await http.postJson('https://x.wd1.myworkdayjobs.com/wday/cxs/x/y/jobs', { limit: 20 }), { total: 0, jobPostings: [] });
    assert.equal(seen!.method, 'POST');
    assert.equal(seen!.body, '{"limit":20}');
    assert.equal((seen!.headers as Record<string, string>)['Content-Type'], 'application/json');
    await http.getJson('https://example.com/a');
    assert.equal(seen!.method, 'GET');
    assert.equal(seen!.body, undefined);
  });
});
