import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { launchPdfEngine } from '../src/tailor/render.ts';
import { rerender, runTailor, type TailorDeps } from '../src/tailor/run.ts';
import type { TailoredContent, VerificationReport } from '../src/tailor/schema.ts';
import { silentLogger } from '../src/util/logger.ts';
import { makeJob } from './helpers.ts';
import { FakeVerifier, FakeWriter, exampleCv, exampleTailorConfig, sampleDraft } from './tailor-helpers.ts';

const BROWSER = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', process.env.TAILOR_TEST_BROWSER ?? ''].find((p) => p && existsSync(p));
const fixLetter = (p: string) => (p.includes('Kubernetes') ? 'My production work is integrations: I build and support SOAP and REST flows.' : p);

describe('runTailor', () => {
  let store: JobStore;
  let outDir: string;
  let jobId: number;
  const deps = (over: Partial<TailorDeps> = {}): TailorDeps => ({
    store,
    cv: exampleCv(),
    cfg: exampleTailorConfig(),
    writer: new FakeWriter(sampleDraft, fixLetter),
    verifier: new FakeVerifier(),
    pdf: null,
    outDir,
    logger: silentLogger,
    model: 'test-model',
    clock: () => new Date('2026-10-15T09:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    store = new JobStore(':memory:');
    outDir = mkdtempSync(path.join(tmpdir(), 'tailor-'));
    const now = '2026-10-15T08:00:00.000Z';
    jobId = store.upsert(makeJob({ title: 'AI Automation Engineer', company: 'Acme', description: 'Build LLM agents. Kubernetes required. You will work with REST integrations and our support team.' }), now).id;
    store.setStatus(jobId, 'selected', null, 'user', now);
  });

  it('writes a verified, versioned package and moves the job to tailored', async () => {
    const writer = new FakeWriter(sampleDraft, fixLetter);
    const stats = await runTailor(deps({ writer }));
    assert.deepEqual(stats, { attempted: 1, tailored: 1, needsReview: 0, errors: [] });

    const job = store.get(jobId)!;
    assert.equal(job.status, 'tailored');
    assert.equal(job.statusReason, 'v1 ready');
    const app = store.latestApplication(jobId)!;
    assert.equal(app.version, 1);
    assert.equal(app.model, 'test-model');
    assert.deepEqual(readdirSync(app.dir).sort(), ['Dana-TODO-last-name-CV.html', 'Dana-TODO-last-name-Cover-Letter.html', 'content.json', 'report.md'].sort());

    const report = app.verification as VerificationReport;
    assert.equal(report.ok, true);
    assert.equal(report.revised, true);
    assert.deepEqual(writer.revisions, [[{ paragraph: 2, problem: 'claims Kubernetes' }]]);

    const content = app.content as TailoredContent;
    assert.ok(!content.coverLetter.paragraphs.join(' ').includes('Kubernetes experience'));
    assert.ok(!JSON.stringify(content.experience).includes('Led a team'), 'embellished bullet reverted');
    assert.deepEqual(content.notes.requirementsNotMet, ['Kubernetes']);

    const cvHtml = readFileSync(path.join(app.dir, 'Dana-TODO-last-name-CV.html'), 'utf8');
    assert.match(cvHtml, /Automation and AI Agent Developer · Acme Health/);
    assert.match(cvHtml, /you@example\.com/);
    assert.doesNotMatch(cvHtml, /TODO<\/span>/, 'TODO links are left out of the contact line');
    const md = readFileSync(path.join(app.dir, 'report.md'), 'utf8');
    assert.match(md, /Ready to approve/);
    assert.match(md, /~~Developed LLM-powered support agents/);
  });

  it('flags the package when a letter claim survives the revision', async () => {
    const stats = await runTailor(deps({ writer: new FakeWriter(sampleDraft) })); // revision changes nothing
    assert.equal(stats.needsReview, 1);
    assert.match(store.get(jobId)!.statusReason!, /1 item\(s\) need your review/);
    const report = store.latestApplication(jobId)!.verification as VerificationReport;
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((i) => i.severity === 'unresolved' && i.where === 'letter:2'));
  });

  it('passes your redo note to the writer, then clears it and bumps the version', async () => {
    await runTailor(deps());
    store.setTailorFeedback(jobId, 'lead with the integration work');
    store.setStatus(jobId, 'selected', 'redo', 'user', '2026-10-15T10:00:00Z');
    const writer = new FakeWriter(sampleDraft, fixLetter);
    await runTailor(deps({ writer }));
    assert.equal(writer.drafts[0]!.feedback, 'lead with the integration work');
    const app = store.latestApplication(jobId)!;
    assert.equal(app.version, 2);
    assert.equal(app.feedback, 'lead with the integration work');
    assert.equal(store.get(jobId)!.tailorFeedback, null);
    assert.match(app.dir, /v2$/);
  });

  it('records failures as tailor_error and retries them next run', async () => {
    const broken = new FakeWriter(() => {
      throw new Error('API overloaded');
    });
    const stats = await runTailor(deps({ writer: broken }));
    assert.equal(stats.errors.length, 1);
    assert.equal(store.get(jobId)!.status, 'tailor_error');
    await runTailor(deps());
    assert.equal(store.get(jobId)!.status, 'tailored');
  });

  it('writes the cover letter in the posting language when configured', async () => {
    const now = '2026-10-15T08:00:00.000Z';
    const heId = store.upsert(
      makeJob({ externalId: 'acme:he', title: 'מפתח/ת אוטומציה', description: 'אנחנו מחפשים מפתח/ת אוטומציה לצוות הבוטים שלנו, עבודה עם מערכות שיחה ו-WhatsApp ועם ממשקי REST.' }),
      now,
    ).id;
    store.setStatus(heId, 'selected', null, 'user', now);
    const writer = new FakeWriter(sampleDraft, fixLetter);
    await runTailor(deps({ writer }), { jobIds: [heId] });
    assert.equal(writer.drafts[0]!.letterLanguage, 'he');
    assert.equal(writer.drafts[0]!.cvLanguage, 'en');
    const app = store.latestApplication(heId)!;
    const letter = readFileSync(path.join(app.dir, 'Dana-TODO-last-name-Cover-Letter.html'), 'utf8');
    assert.match(letter, /<html lang="he" dir="rtl">/);
    assert.match(letter, /מועמדות למשרת/);
    assert.match(letter, /בברכה,<br>/);
  });

  it('re-renders hand edits with rule warnings and no reverts', async () => {
    await runTailor(deps());
    const app = store.latestApplication(jobId)!;
    const file = path.join(app.dir, 'content.json');
    const content = JSON.parse(readFileSync(file, 'utf8')) as TailoredContent;
    content.experience[0]!.bullets[0]!.text = 'Built LLM support agents used by 3 hospitals';
    writeFileSync(file, JSON.stringify(content));
    const { report } = await rerender(jobId, { store, cv: exampleCv(), cfg: exampleTailorConfig(), pdf: null });
    assert.equal(report.llmChecked, false);
    assert.ok(report.issues.some((i) => i.severity === 'warning' && /number 3/.test(i.message)));
    const saved = store.latestApplication(jobId)!.content as TailoredContent;
    assert.equal(saved.experience[0]!.bullets[0]!.text, 'Built LLM support agents used by 3 hospitals');
    assert.equal(store.latestApplication(jobId)!.version, 1);
  });

  it('renders real PDFs and counts CV pages', { skip: !BROWSER && 'no Chromium available' }, async () => {
    const pdf = await launchPdfEngine(BROWSER!);
    try {
      await runTailor(deps({ pdf }));
    } finally {
      await pdf.close();
    }
    const app = store.latestApplication(jobId)!;
    const files = readdirSync(app.dir);
    assert.ok(files.includes('Dana-TODO-last-name-CV.pdf') && files.includes('Dana-TODO-last-name-Cover-Letter.pdf'));
    const report = app.verification as VerificationReport;
    assert.equal(report.cvPages, 1);
    assert.ok(readFileSync(path.join(app.dir, 'Dana-TODO-last-name-CV.pdf')).subarray(0, 5).toString() === '%PDF-');
  });
});
