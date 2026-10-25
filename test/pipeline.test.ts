import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import type { Enricher } from '../src/llm/enrich.ts';
import type { Scorer } from '../src/llm/scorer.ts';
import { runScout, type RunDeps } from '../src/pipeline/run.ts';
import type { SourceAdapter } from '../src/sources/common.ts';
import type { NormalizedJob, ScoreResult } from '../src/types.ts';
import { silentLogger } from '../src/util/logger.ts';
import { fakeHttp, makeJob, makePrefs } from './helpers.ts';

function board(key: string, jobs: () => NormalizedJob[]): SourceAdapter {
  const [kind, token] = key.split(':') as [NormalizedJob['source'], string];
  return { key, kind, snapshotPrefix: `${token}:`, fetchJobs: async () => jobs() };
}

function feed(jobs: () => NormalizedJob[]): SourceAdapter {
  return { key: 'email:alerts', kind: 'email', fetchJobs: async () => jobs() };
}

const broken: SourceAdapter = {
  key: 'lever:broken',
  kind: 'lever',
  snapshotPrefix: 'broken:',
  fetchJobs: async () => {
    throw new Error('HTTP 404 Not Found');
  },
};

/** Scores by title so tests can steer outcomes; "boom" throws. */
class FakeScorer implements Scorer {
  calls: string[] = [];
  async score(job: NormalizedJob): Promise<ScoreResult> {
    this.calls.push(job.title);
    if (/boom/i.test(job.title)) throw new Error('API overloaded');
    const score = /great/i.test(job.title) ? 90 : /decent/i.test(job.title) ? 58 : 40;
    return { score, verdict: score >= 85 ? 'strong' : 'poor', seniorityFit: 'fit', matchReasons: [], gaps: [], dealbreakers: [], summary: '' };
  }
}

const atsJob = (id: string, title: string, extra: Partial<NormalizedJob> = {}) =>
  makeJob({ source: 'greenhouse', externalId: `acme:${id}`, title, url: `https://example.com/${id}`, ...extra });

const emailJob = (id: string, title: string, extra: Partial<NormalizedJob> = {}) =>
  makeJob({
    source: 'email',
    externalId: `linkedin:${id}`,
    title,
    url: `https://www.linkedin.com/jobs/view/${id}/`,
    description: `${title}\nAcme\nTel Aviv`,
    descriptionIsPartial: true,
    ...extra,
  });

describe('runScout', () => {
  let store: JobStore;
  let scorer: FakeScorer;
  let clock: Date;
  const deps = (adapters: SourceAdapter[], overrides: Partial<RunDeps> = {}): RunDeps => ({
    store,
    adapters,
    http: fakeHttp({}),
    prefs: makePrefs(),
    logger: silentLogger,
    scorer,
    clock: () => clock,
    // Never the network: found posting pages are re-checked over HTTP otherwise.
    checkPage: async () => 'unknown',
    ...overrides,
  });

  beforeEach(() => {
    store = new JobStore(':memory:');
    scorer = new FakeScorer();
    clock = new Date('2026-10-15T08:00:00Z');
  });

  it('fetches, filters, dedupes and scores in one pass', async () => {
    const stats = await runScout(
      deps([
        board('greenhouse:acme', () => [
          atsJob('1', 'Great Automation Engineer'),
          atsJob('2', 'Principal Engineer'),
          atsJob('3', 'Integration Engineer', { workplaceType: 'remote', location: 'Remote - US only' }),
          atsJob('4', 'Backend Developer'),
        ]),
        feed(() => [emailJob('900', 'Great Automation Engineer')]),
        broken,
      ]),
    );

    assert.equal(stats.sources.ok, 2);
    assert.equal(stats.sources.failed, 1);
    assert.match(stats.sources.errors[0]!.error, /404/);
    assert.equal(stats.inserted, 5);
    assert.equal(stats.filteredOut, 2);
    assert.deepEqual(stats.filterReasons, { seniority: 1, location: 1 });
    assert.equal(stats.duplicates, 1);
    assert.equal(stats.shortlisted, 1);
    assert.equal(stats.lowScore, 1);
    assert.deepEqual(scorer.calls.sort(), ['Backend Developer', 'Great Automation Engineer']);

    const [top] = store.listByStatus(['shortlisted']);
    assert.equal(top!.externalId, 'acme:1');
    assert.equal(top!.score, 90);
    const dup = store.listByStatus(['duplicate'])[0]!;
    assert.equal(dup.source, 'email');
    assert.equal(dup.duplicateOf, top!.id);

    const health = store.sourceHealth();
    assert.ok(health.find((h) => h.source_key === 'lever:broken')?.last_error);
    assert.equal(health.find((h) => h.source_key === 'greenhouse:acme')?.last_job_count, 4);
  });

  it('replaces an alert-email job when the full posting shows up later', async () => {
    await runScout(deps([feed(() => [emailJob('900', 'Great Automation Engineer')])]));
    const [fromEmail] = store.listByStatus(['shortlisted']);
    assert.equal(fromEmail!.source, 'email');

    clock = new Date('2026-10-16T08:00:00Z');
    await runScout(deps([board('greenhouse:acme', () => [atsJob('1', 'Great Automation Engineer')])]));
    const [fromBoard] = store.listByStatus(['shortlisted']);
    assert.equal(fromBoard!.source, 'greenhouse');
    assert.equal(store.get(fromEmail!.id)!.status, 'duplicate');
    assert.equal(store.get(fromEmail!.id)!.duplicateOf, fromBoard!.id);
  });

  it('closes jobs that disappear from a board, but not when the board fails', async () => {
    let jobs = [atsJob('1', 'Great Automation Engineer'), atsJob('2', 'Great Integration Developer')];
    let fail = false;
    const adapter: SourceAdapter = {
      ...board('greenhouse:acme', () => jobs),
      fetchJobs: async () => {
        if (fail) throw new Error('timeout');
        return jobs;
      },
    };
    await runScout(deps([adapter]));
    assert.equal(store.listByStatus(['shortlisted']).length, 2);

    clock = new Date('2026-10-16T08:00:00Z');
    fail = true;
    await runScout(deps([adapter]));
    assert.equal(store.listByStatus(['shortlisted']).length, 2, 'a failed fetch must not close anything');

    clock = new Date('2026-10-17T08:00:00Z');
    fail = false;
    jobs = [atsJob('1', 'Great Automation Engineer')];
    const stats = await runScout(deps([adapter]));
    assert.equal(stats.closed, 1);
    assert.equal(store.listByStatus(['shortlisted']).length, 1);
    assert.equal(store.listByStatus(['shortlisted'], { includeClosed: true }).length, 2);
  });

  it('re-evaluates a job when its posting changes, but leaves picked jobs alone', async () => {
    let title = 'Great Automation Engineer';
    const adapter = board('greenhouse:acme', () => [atsJob('1', title), atsJob('2', 'Great Integration Developer')]);
    await runScout(deps([adapter]));
    const picked = store.listByStatus(['shortlisted']).find((j) => j.externalId === 'acme:2')!;
    store.setStatus(picked.id, 'selected', null, 'user', clock.toISOString());

    clock = new Date('2026-10-16T08:00:00Z');
    title = 'Automation Engineer';
    scorer.calls = [];
    const stats = await runScout(deps([adapter]));
    assert.equal(stats.changed, 1);
    assert.deepEqual(scorer.calls, ['Automation Engineer']);
    assert.equal(store.listByStatus(['low_score'])[0]!.externalId, 'acme:1');
    assert.equal(store.get(picked.id)!.status, 'selected');
  });

  it('caps scoring per run and carries the backlog to the next run', async () => {
    const prefs = makePrefs({ scoring: { threshold: 65, maxJobsPerRun: 2, concurrency: 2, maxAttempts: 3 } });
    const adapter = board('greenhouse:acme', () => ['1', '2', '3'].map((id) => atsJob(id, `Great Developer ${id}`)));
    const first = await runScout(deps([adapter], { prefs }));
    assert.equal(first.scored, 2);
    assert.equal(first.scoringBacklog, 1);

    const second = await runScout(deps([adapter], { prefs }));
    assert.equal(second.scored, 1);
    assert.equal(second.scoringBacklog, 0);
  });

  it('gives summary-only alert jobs their own cutoff, and applies edited cutoffs without re-scoring', async () => {
    const scoring = { threshold: 65, maxJobsPerRun: 10, concurrency: 1, maxAttempts: 3 };
    const adapters = [board('greenhouse:acme', () => [atsJob('1', 'Decent Developer')]), feed(() => [emailJob('9', 'Decent Engineer')])];
    await runScout(deps(adapters, { prefs: makePrefs({ scoring: { ...scoring, partialThreshold: 55 } }) }));
    const [alert] = store.listByStatus(['shortlisted']);
    assert.equal(alert?.externalId, 'linkedin:9', '58 clears the partial cutoff of 55');
    assert.equal(store.listByStatus(['low_score'])[0]!.externalId, 'acme:1', 'a full posting still needs 65');

    const calls = scorer.calls.length;
    await runScout(deps(adapters, { prefs: makePrefs({ scoring: { ...scoring, partialThreshold: 60 } }) }));
    assert.equal(store.get(alert!.id)!.status, 'low_score');
    await runScout(deps(adapters, { prefs: makePrefs({ scoring: { ...scoring, threshold: 50 } }) }));
    assert.deepEqual(store.listByStatus(['shortlisted']).map((j) => j.externalId).sort(), ['acme:1', 'linkedin:9']);
    assert.equal(scorer.calls.length, calls, 'nothing was scored again');
  });

  it('looks up shortlisted alert jobs once, and scores the full posting against the full cutoff', async () => {
    const prefs = makePrefs({ scoring: { threshold: 65, partialThreshold: 55, maxJobsPerRun: 10, concurrency: 1, maxAttempts: 3 } });
    const lookups: string[] = [];
    const posting = 'Build agentic workflows on our AI platform. Requirements: TypeScript, LLM agents, integrations. '.repeat(4);
    const enricher: Enricher = {
      async find(job) {
        lookups.push(job.title);
        const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searches: 1, fetches: 1 };
        return /found/i.test(job.title)
          ? { posting: { url: 'https://mirror.example/acme-1', description: posting, workplaceType: 'hybrid' as const }, applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', reason: 'company page', usage }
          : { posting: null, reason: 'not found', usage };
      },
    };
    const alerts = feed(() => [emailJob('1', 'Decent Engineer Found'), emailJob('2', 'Decent Engineer Missing')]);
    const stats = await runScout(deps([alerts], { prefs, enricher }));
    assert.deepEqual([stats.enrich.tried, stats.enrich.found], [2, 1]);

    const found = store.findByExternalId('email', 'linkedin:1')!;
    assert.equal(found.descriptionIsPartial, false);
    assert.equal(found.postingUrl, 'https://mirror.example/acme-1', 'where the description came from');
    assert.equal(found.applyUrl, 'https://boards.greenhouse.io/acme/jobs/1', 'where to apply');
    assert.equal(found.status, 'low_score', 'the full posting scored 58, under the full-posting cutoff of 65');
    const missing = store.findByExternalId('email', 'linkedin:2')!;
    assert.equal(missing.status, 'shortlisted');
    assert.ok(missing.enrichedAt);

    // The same alert email is read again next run: no second lookup, and the full posting stays.
    await runScout(deps([alerts], { prefs, enricher }));
    assert.equal(lookups.length, 2);
    assert.equal(store.get(found.id)!.description, posting);
  });

  it('drops LinkedIn alert jobs whose ID shows they were posted long ago, before scoring them', async () => {
    // A week of alerts with IDs rising 0.5M a day, then one old ID and one a few weeks old.
    const week = Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 5 }, (_, k) =>
        emailJob(String(4_480_000_000 + d * 500_000 + k), `Automation Engineer ${d}${k}`, { postedAt: `2026-10-0${d + 3}T08:00:00.000Z` }),
      ),
    ).flat();
    const old = emailJob('4400000000', 'Great Automation Engineer Old', { postedAt: '2026-10-14T08:00:00.000Z' });
    const recent = emailJob('4470000000', 'Great Automation Engineer Recent', { postedAt: '2026-10-14T08:00:00.000Z' });
    const stats = await runScout(deps([feed(() => [...week, old, recent])]));
    assert.equal(stats.oldAlerts, 1);
    const dropped = store.findByExternalId('email', 'linkedin:4400000000')!;
    assert.equal(dropped.status, 'filtered_out');
    assert.match(dropped.statusReason!, /posted about \d+ days ago \(estimated from its LinkedIn job ID\)/);
    assert.ok(!scorer.calls.includes('Great Automation Engineer Old'), 'never scored');
    assert.equal(store.findByExternalId('email', 'linkedin:4470000000')!.status, 'shortlisted', 'about 30 days old: kept');
  });

  it('applies your filters to a found full posting, including its real date', async () => {
    const prefs = makePrefs({ scoring: { threshold: 65, partialThreshold: 55, maxJobsPerRun: 10, concurrency: 1, maxAttempts: 3 } });
    const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searches: 1, fetches: 1 };
    const enricher: Enricher = {
      async find() {
        const description = 'Build agentic workflows and integrations for our customers in Tel Aviv. '.repeat(4);
        return { posting: { url: 'https://acme.example/jobs/1', description, postedAt: '2026-06-01T00:00:00.000Z' }, reason: 'company page', usage };
      },
    };
    await runScout(deps([feed(() => [emailJob('1', 'Decent Engineer')])], { prefs, enricher }));
    const job = store.findByExternalId('email', 'linkedin:1')!;
    assert.equal(job.status, 'filtered_out');
    assert.match(job.statusReason!, /posted \d+ days ago/);
    assert.equal(scorer.calls.length, 1, 'scored once as a partial job, not again');
  });

  it('drops shortlisted jobs whose posting closed: found by the lookup, or on a later re-check', async () => {
    const prefs = makePrefs({ scoring: { threshold: 65, partialThreshold: 55, maxJobsPerRun: 10, concurrency: 1, maxAttempts: 3 } });
    const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searches: 1, fetches: 1 };
    const description = 'Build agentic workflows and integrations for our customers in Tel Aviv. '.repeat(4);
    const enricher: Enricher = {
      async find(job) {
        return /closed/i.test(job.title)
          ? { posting: null, closed: true, reason: 'no longer accepting applications (https://acme.example/2)', usage }
          : { posting: { url: 'https://acme.example/1', description }, reason: 'company page', usage };
      },
    };
    let pageClosed = false;
    const checkPage = async (): Promise<'open' | 'closed'> => (pageClosed ? 'closed' : 'open');
    const alerts = feed(() => [emailJob('1', 'Great Engineer'), emailJob('2', 'Decent Engineer Closed')]);
    const first = await runScout(deps([alerts], { prefs, enricher, checkPage }));
    assert.equal(first.closedPostings, 1);
    assert.equal(store.findByExternalId('email', 'linkedin:2')!.status, 'filtered_out');
    assert.equal(store.findByExternalId('email', 'linkedin:1')!.status, 'shortlisted', 'found, open, and 90 on the full posting');

    pageClosed = true; // the company took it down since
    const second = await runScout(deps([alerts], { prefs, enricher, checkPage }));
    assert.equal(second.closedPostings, 1);
    const job = store.findByExternalId('email', 'linkedin:1')!;
    assert.equal(job.status, 'filtered_out');
    assert.ok(job.closedAt);
    assert.equal(store.listByStatus(['shortlisted']).length, 0);
  });

  it('retries scoring errors up to maxAttempts', async () => {
    const prefs = makePrefs({ scoring: { threshold: 65, maxJobsPerRun: 10, concurrency: 1, maxAttempts: 2 } });
    const adapter = board('greenhouse:acme', () => [atsJob('1', 'Boom Developer')]);
    const first = await runScout(deps([adapter], { prefs }));
    assert.equal(first.scoreErrors, 1);
    const [job] = store.listByStatus(['score_error']);
    assert.match(job!.statusReason!, /overloaded/);

    await runScout(deps([adapter], { prefs }));
    const third = await runScout(deps([adapter], { prefs }));
    assert.equal(third.scoreErrors, 0, 'gives up after maxAttempts');
    assert.equal(store.get(job!.id)!.scoreAttempts, 2);
  });

  it('runs filters only without a scorer, and reevaluate sends everything back through', async () => {
    const adapter = board('greenhouse:acme', () => [atsJob('1', 'Great Automation Engineer'), atsJob('2', 'Principal Engineer')]);
    const stats = await runScout(deps([adapter], { scorer: undefined }));
    assert.equal(stats.scored, 0);
    assert.equal(store.listByStatus(['queued']).length, 1);

    await runScout(deps([adapter]));
    assert.equal(store.listByStatus(['shortlisted']).length, 1);

    const moved = store.requeueForReevaluation(clock.toISOString());
    assert.equal(moved, 2);
    const lenient = makePrefs({ seniority: { exclude: [] } });
    const again = await runScout(deps([adapter], { prefs: lenient }));
    assert.equal(again.filteredOut, 0);
    assert.equal(again.scored, 2);
    assert.equal(store.get(store.listByStatus(['shortlisted'])[0]!.id)!.score, 90);
  });

  it('records history and run stats', async () => {
    await runScout(deps([board('greenhouse:acme', () => [atsJob('1', 'Great Automation Engineer')])]));
    const [job] = store.listByStatus(['shortlisted']);
    assert.deepEqual(
      store.history(job!.id).map((h) => h.to_status),
      ['discovered', 'queued', 'shortlisted'],
    );
    const run = store.db.prepare('SELECT agent, finished_at, stats_json FROM runs').get() as { agent: string; finished_at: string; stats_json: string };
    assert.equal(run.agent, 'scout');
    assert.ok(run.finished_at);
    assert.equal(JSON.parse(run.stats_json).shortlisted, 1);
  });
});
