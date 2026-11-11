import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fileReply } from '../src/archiver/record.ts';
import { buildReport, groupApplications } from '../src/archiver/report.ts';
import { JobStore, type ResponseRecord, type SentApplication } from '../src/db/store.ts';
import { makeJob, NOW } from './helpers.ts';

let n = 1;
const reply = (over: Partial<ResponseRecord>): ResponseRecord => ({
  id: n++,
  messageId: `m${n}`,
  jobId: null,
  receivedAt: '2026-10-12T09:00:00.000Z',
  fromName: '',
  fromAddress: 'no-reply@acme.example',
  subject: 'Thank you for applying',
  kind: 'confirmation',
  company: '',
  title: '',
  summary: '',
  action: '',
  model: 'test',
  ...over,
});
const sent = (company: string, via: string): SentApplication => ({
  job: { ...makeJob({ company, title: `Engineer at ${company}` }), id: n++ } as SentApplication['job'],
  appliedAt: '2026-10-10T00:00:00.000Z',
  via,
  outcome: null,
  archiveChoice: null,
});

describe('replies about applications you sent yourself', () => {
  let store: JobStore;
  const rows = () => groupApplications(store.sentApplications());
  beforeEach(() => {
    store = new JobStore(':memory:');
  });

  it('records the application from its confirmation, and files later replies under it', () => {
    const first = fileReply(store, reply({ company: 'Acme', title: 'Automation Engineer' }), rows(), NOW.toISOString());
    assert.ok(first.created && first.jobId !== null);
    const app = store.sentApplications()[0]!;
    assert.equal(app.job.id, first.jobId);
    assert.equal(app.job.status, 'submitted');
    assert.equal(app.via, 'from your email');
    assert.equal(app.appliedAt, '2026-10-12T09:00:00.000Z', 'dated by the email');

    const viewed = fileReply(store, reply({ kind: 'viewed', company: 'Acme', title: 'Automation Engineer', receivedAt: '2026-10-13T09:00:00.000Z' }), rows(), NOW.toISOString());
    assert.deepEqual(viewed, { jobId: first.jobId, created: false });
    assert.equal(store.sentApplications().length, 1, 'the same application once');
  });

  it('a rejection with nothing recorded still means you applied: recorded, and counted as rejected', () => {
    const r = reply({ kind: 'rejection', company: 'Globex', title: 'AI Engineer', subject: 'Your application to Globex', receivedAt: '2026-10-14T09:00:00.000Z' });
    const filed = fileReply(store, r, rows(), NOW.toISOString());
    assert.ok(filed.created && filed.jobId !== null);
    store.saveResponse({ ...r, jobId: filed.jobId }, NOW.toISOString());
    const { stats } = buildReport(store.sentApplications(), store.responses(), new Date('2026-10-20T00:00:00Z'));
    assert.equal(stats.applied, 1);
    assert.equal(stats.rejected, 1);
    assert.equal(stats.manual, 1);
    assert.equal(stats.viaTool, 0);
    assert.equal(stats.unmatched, 0);
  });

  it('records nothing from a reply naming neither company nor role, nor from unrelated mail', () => {
    assert.deepEqual(fileReply(store, reply({ kind: 'rejection' }), rows(), NOW.toISOString()), { jobId: null, created: false });
    assert.deepEqual(fileReply(store, reply({ kind: 'not_related', company: 'Acme', title: 'Engineer' }), rows(), NOW.toISOString()), { jobId: null, created: false });
    assert.equal(store.sentApplications().length, 0);
  });

  it('counts applications sent with this tool and by you, with the total, without splitting the rest', () => {
    const apps = [sent('A', 'this tool'), sent('B', 'LinkedIn'), sent('C', 'from your email'), sent('D', 'marked by you')];
    const { stats } = buildReport(apps, [], NOW);
    assert.equal(stats.applied, 4);
    assert.equal(stats.viaTool, 1);
    assert.equal(stats.manual, 3);
    assert.equal(stats.awaiting, 4, 'the stage counts cover every application');
  });
});
