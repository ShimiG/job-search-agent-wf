import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import type { FieldMapper } from '../src/submit/llm.ts';
import { markSubmitted, openBrowser, runSubmitter, type BrowserSession, type SubmitDeps } from '../src/submit/run.ts';
import type { CodeSource } from '../src/submit/otp.ts';
import { SubmitFileSchema, type PlannedAnswer } from '../src/submit/schema.ts';
import type { NormalizedJob } from '../src/types.ts';
import { silentLogger } from '../src/util/logger.ts';
import { makeJob } from './helpers.ts';
import { exampleCv } from './tailor-helpers.ts';

const BROWSER = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', process.env.TAILOR_TEST_BROWSER ?? ''].find((p) => p && existsSync(p));
const FORMS = new URL('./fixtures/forms/', import.meta.url);
const baseSettings = SubmitFileSchema.parse(JSON.parse(readFileSync(new URL('../examples/submit.json', import.meta.url), 'utf8')));

/** Drafts the motivation question, refuses everything else, like a well-behaved model. */
const draftingMapper: FieldMapper = {
  async map(input) {
    return input.fields.map((f) =>
      /why do you want/i.test(f.label)
        ? { key: f.key, type: 'draft', value: 'I build LLM support agents every day and want to do it at Acme.', reason: 'cover letter' }
        : { key: f.key, type: 'unknown', value: '', reason: 'not in data' },
    );
  },
};

describe('Submitter against local forms', { skip: !BROWSER && 'no Chromium available' }, () => {
  let server: Server;
  let base = '';
  let posted: Array<Record<string, unknown>> = [];
  let browser: BrowserSession;
  let store: JobStore;
  let appDir: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          posted.push(JSON.parse(body));
          res.end('ok');
        });
        return;
      }
      const name = req.url === '/thanks' ? 'thanks.html' : (req.url ?? '/').split('?')[0]!.slice(1);
      const file = new URL(name, FORMS);
      if (!name || !existsSync(file)) {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await openBrowser({ browserPath: BROWSER!, headless: true, userDataDir: mkdtempSync(path.join(tmpdir(), 'profile-')) });
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  beforeEach(() => {
    posted = [];
    store = new JobStore(':memory:');
    appDir = mkdtempSync(path.join(tmpdir(), 'app-'));
    writeFileSync(path.join(appDir, 'Dana-CV.pdf'), '%PDF-1.4 cv');
    writeFileSync(path.join(appDir, 'Dana-Cover-Letter.pdf'), '%PDF-1.4 letter');
  });

  /** An approved job with a tailored package, pointing at one of the local forms. */
  function approvedJob(page: string, over: Partial<NormalizedJob> = {}): number {
    const now = '2026-10-15T08:00:00.000Z';
    const id = store.upsert(makeJob({ externalId: `acme:${page}:${Math.random()}`, applyUrl: `${base}/${page}`, ...over }), now).id;
    store.saveApplication({
      jobId: id, dir: appDir, cvLanguage: 'en', letterLanguage: 'en', feedback: null, model: null, createdAt: now,
      content: { coverLetter: { greeting: 'Dear team,', paragraphs: ['Hello.'], closing: 'Thanks.', signOff: 'Best regards' }, headline: '', summary: '' },
      verification: { ok: true, issues: [] },
    });
    store.setStatus(id, 'approved', null, 'user', now);
    return id;
  }

  const deps = (over: Partial<SubmitDeps> = {}): SubmitDeps => ({
    store,
    cv: exampleCv(),
    answers: { ...baseSettings, profile: { ...baseSettings.profile, lastName: 'Levi', city: 'Holon', linkedin: 'https://linkedin.com/in/dana' } },
    contact: { email: 'dana@example.com', phone: '+972-50-1234567' },
    cfg: { ...baseSettings, autoSubmit: true, assistTimeoutMinutes: 1 },
    mapper: draftingMapper,
    browser,
    logger: silentLogger,
    timing: { settleMs: 300, confirmTimeoutMs: 5000, pollMs: 150, betweenMs: 0 },
    ...over,
  });

  const lastFields = (id: number) => store.submissions(id).at(-1)!.fields as PlannedAnswer[];
  const field = (id: number, label: string) => lastFields(id).find((f) => f.label === label)!;

  it('prepare: fills everything it can, never submits, leaves the job approved', async () => {
    const id = approvedJob('greenhouse.html');
    const stats = await runSubmitter(deps(), 'prepare');
    assert.equal(stats.prepared, 1);
    assert.equal(posted.length, 0, 'nothing was submitted');
    assert.equal(store.get(id)!.status, 'approved');

    const sub = store.submissions(id).at(-1)!;
    assert.equal(sub.outcome, 'prepared');
    assert.match(sub.reason!, /1 required need you: "I agree to the privacy policy"/);
    assert.match(sub.reason!, /1 written by the model/);
    assert.ok(sub.screenshots.length === 1 && existsSync(sub.screenshots[0]!));

    assert.deepEqual([field(id, 'First Name').value, field(id, 'First Name').filled], ['Dana', true]);
    assert.equal(field(id, 'Last Name').value, 'Levi');
    assert.equal(field(id, 'Resume/CV').value, 'Dana-CV.pdf');
    assert.equal(field(id, 'LinkedIn Profile').value, 'https://linkedin.com/in/dana');
    assert.equal(field(id, 'Are you legally authorized to work in Israel?').source, 'answer_bank');
    assert.equal(field(id, 'Why do you want to work at Acme?').source, 'model_draft');
    assert.equal(field(id, 'What are your salary expectations?').value, '', 'answer bank says ask me');
    assert.equal(field(id, 'Gender').value, 'Decline To Self Identify');
  });

  it('Greenhouse-style widgets: picks suggestions, skips hidden inputs, sends each document to its own upload', async () => {
    const id = approvedJob('greenhouse-react.html');
    const stats = await runSubmitter(deps(), 'auto');
    assert.equal(stats.submitted, 1, store.get(id)!.statusReason ?? '');
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.location, 'Holon, Tel Aviv, Israel', 'not the "Holonga" namesake listed first');
    assert.equal(posted[0]!.country, 'Israel +972');
    assert.equal(posted[0]!.resume, 'Dana-CV.pdf');
    assert.equal(posted[0]!.cover_letter, 'Dana-Cover-Letter.pdf');
    const labels = lastFields(id).map((f) => f.label);
    assert.equal(labels.filter((l) => l === 'Phone').length, 1, 'the hidden required input is not a second Phone field');
    assert.equal(labels.filter((l) => l === 'Location (City)').length, 1);
  });

  it('never submits while filling, even when an autocomplete has no match', async () => {
    const id = approvedJob('greenhouse-react.html?nocity');
    await runSubmitter(deps(), 'prepare');
    assert.equal(posted.length, 0, 'nothing was submitted');
    const loc = field(id, 'Location (City)');
    assert.equal(loc.filled, false);
    assert.match(loc.error!, /no suggestion matches "Holon, Israel"/);
    assert.match(store.submissions(id).at(-1)!.reason!, /required need you: "Location \(City\)"/);
  });

  it('reads an emailed security code from the inbox, enters it, and finishes the application', async () => {
    const id = approvedJob('security-code.html');
    const asked: Date[] = [];
    const codes: CodeSource = { async waitForCode({ since }) { asked.push(since); return 'X7KP2MQA'; } };
    const stats = await runSubmitter(deps({ codes }), 'auto');
    assert.equal(stats.submitted, 1, store.get(id)!.statusReason ?? '');
    assert.deepEqual(posted, [{ email: 'dana@example.com', code: 'X7KP2MQA' }]);
    assert.equal(asked.length, 1, 'asked the inbox once');
  });

  it('hands the job to you when no security code arrives', async () => {
    const id = approvedJob('security-code.html');
    const codes: CodeSource = { async waitForCode() { return null; } };
    await runSubmitter(deps({ codes, timing: { settleMs: 300, confirmTimeoutMs: 1500, pollMs: 150, betweenMs: 0, codeTimeoutMs: 100 } }), 'auto');
    assert.equal(posted.length, 0);
    assert.equal(store.get(id)!.status, 'needs_manual');
    assert.match(store.get(id)!.statusReason!, /saw no confirmation/);
  });

  it('auto: sends answers Claude wrote only as far as autoSubmitModelAnswers allows', async () => {
    const consenting = { ...baseSettings, profile: { ...baseSettings.profile, lastName: 'Levi' }, consentToPrivacyPolicies: true };
    const facts = approvedJob('greenhouse.html');
    await runSubmitter(deps({ answers: consenting, cfg: { ...baseSettings, autoSubmit: true, autoSubmitModelAnswers: 'facts', assistTimeoutMinutes: 1 } }), 'auto');
    assert.equal(posted.length, 0, '"Why Acme?" was written by the model: facts only stops it');
    assert.match(store.get(facts)!.statusReason!, /written by the model/);

    const all = approvedJob('greenhouse.html');
    await runSubmitter(deps({ answers: consenting, cfg: { ...baseSettings, autoSubmit: true, autoSubmitModelAnswers: 'all', assistTimeoutMinutes: 1 } }), 'auto', { jobIds: [all] });
    assert.equal(posted.length, 1);
    assert.equal(store.get(all)!.status, 'submitted');
  });

  it("won't fill an application page found by the web lookup unless it's about this job", async () => {
    const id = approvedJob('greenhouse.html', { title: 'Agent Platform Engineer' });
    store.setApplyUrl(id, `${base}/greenhouse.html`, '2026-10-15T08:00:00.000Z');
    await runSubmitter(deps(), 'auto');
    assert.equal(posted.length, 0);
    assert.match(store.get(id)!.statusReason!, /doesn't mention "Agent Platform Engineer"/);
  });

  it('auto: refuses when anything needs you, and says why', async () => {
    const id = approvedJob('greenhouse.html');
    await runSubmitter(deps(), 'auto');
    assert.equal(posted.length, 0);
    const job = store.get(id)!;
    assert.equal(job.status, 'needs_manual');
    assert.match(job.statusReason!, /required question\(s\) need you: "I agree to the privacy policy"/);
    assert.match(job.statusReason!, /written by the model/);
    assert.match(job.statusReason!, /--mode assist/);
  });

  it('auto: submits a fully answerable form and records the confirmation', async () => {
    const id = approvedJob('lever.html');
    const stats = await runSubmitter(deps({ mapper: null }), 'auto');
    assert.equal(stats.submitted, 1);
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], {
      name: 'Dana Levi',
      email: 'dana@example.com',
      phone: '+972-50-1234567',
      org: 'Acme Health',
      'urls[LinkedIn]': 'https://linkedin.com/in/dana',
      resume: 'Dana-CV.pdf',
      sponsorship: 'no',
      comments: '',
    });
    const job = store.get(id)!;
    assert.equal(job.status, 'submitted');
    const sub = store.submissions(id).at(-1)!;
    assert.match(sub.confirmation!, /thanks|submitted/i);
    assert.equal(sub.screenshots.length, 2, 'filled + confirmed');
  });

  it('auto: never submits twice, and respects the per-company limit', async () => {
    const first = approvedJob('lever.html');
    await runSubmitter(deps({ mapper: null }), 'auto');
    const again = await runSubmitter(deps({ mapper: null }), 'auto', { jobIds: [first] });
    assert.equal(again.attempted, 0);

    const second = approvedJob('lever.html', { title: 'Backend Developer' });
    await runSubmitter(deps({ mapper: null, cfg: { ...baseSettings, autoSubmit: true, maxPerCompanyPer30Days: 1 } }), 'auto');
    assert.equal(store.get(second)!.status, 'needs_manual');
    assert.match(store.get(second)!.statusReason!, /already applied to Acme 1 time/);
    assert.equal(posted.length, 1);
  });

  it('stops at CAPTCHAs and sign-in walls', async () => {
    const captcha = approvedJob('captcha.html');
    const login = approvedJob('login.html', { title: 'Data Engineer' });
    await runSubmitter(deps({ mapper: null }), 'auto');
    assert.match(store.get(captcha)!.statusReason!, /CAPTCHA \(reCAPTCHA\)/);
    assert.match(store.get(login)!.statusReason!, /sign in or create an account/);
  });

  it('hands LinkedIn and Workday jobs to you without opening them', async () => {
    const id = approvedJob('x', { applyUrl: 'https://www.linkedin.com/jobs/view/123/' });
    await runSubmitter(deps(), 'auto');
    assert.match(store.get(id)!.statusReason!, /LinkedIn forbids automated applications/);
    markSubmitted(store, id, 'applied on LinkedIn');
    assert.equal(store.get(id)!.status, 'submitted');
    assert.throws(() => markSubmitted(store, id, null), /already marked/);
  });

  it('finds forms behind an Apply button inside an iframe', async () => {
    const id = approvedJob('embed.html');
    await runSubmitter(deps(), 'prepare');
    assert.equal(field(id, 'First Name').filled, true);
    assert.equal(field(id, 'Email').value, 'dana@example.com');
  });

  it('assist: fills, waits for you to submit, then records it', async () => {
    const id = approvedJob('greenhouse.html');
    let shown: string[] = [];
    const stats = await runSubmitter(
      deps({
        onAssist: async ({ page, unresolved }) => {
          shown = unresolved.map((u) => u.label);
          // Play the human: tick consent, then submit.
          const frame = page.frames().find((f) => f.url().includes('greenhouse')) ?? page.mainFrame();
          await frame.check('#privacy');
          await frame.click('button[type=submit]');
        },
      }),
      'assist',
    );
    assert.deepEqual(shown, ['I agree to the privacy policy']);
    assert.equal(stats.submitted, 1);
    assert.equal(store.get(id)!.status, 'submitted');
    assert.equal(posted[0]!.q_why, 'I build LLM support agents every day and want to do it at Acme.');
    assert.equal(posted[0]!.q_auth, '1');
    assert.equal(posted[0]!.gender, 'Decline To Self Identify');
    assert.equal(posted[0]!.cover_letter, 'Dana-Cover-Letter.pdf');
  });
});
