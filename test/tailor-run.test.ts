import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { JobStore } from '../src/db/store.ts';
import { launchPdfEngine } from '../src/tailor/render.ts';
import { rerender, runTailor, type TailorDeps, recentLetterLines } from '../src/tailor/run.ts';
import type { TailoredContent, VerificationReport } from '../src/tailor/schema.ts';
import { silentLogger } from '../src/util/logger.ts';
import { makeJob } from './helpers.ts';
import { FakeVerifier, FakeWriter, exampleCv, exampleTailorConfig, sampleDraft } from './tailor-helpers.ts';

const BROWSER = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', process.env.TAILOR_TEST_BROWSER ?? ''].find((p) => p && existsSync(p));
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

    // Coverage is measured on the final CV text: the reverted Kubernetes bullet doesn't count.
    assert.deepEqual(
      report.keywords!.items.map((k) => [k.term, k.status]),
      [['REST', 'matched'], ['LLM agents', 'reworded'], ['Kubernetes', 'missing']],
    );
    assert.deepEqual([report.keywords!.matched, report.keywords!.supported, report.keywords!.total], [1, 2, 3]);
    assert.match(md, /## ATS keywords\n1 of 3 of the posting's key terms appear in this CV word for word \(0 of 2 must-haves\)/);
    assert.match(md, /LLM agents: "Developed LLM-powered support agents/);
  });

  it("warns when a letter repeats your letter to another job, but not your own earlier version", async () => {
    const writer = new FakeWriter(sampleDraft, fixLetter);
    await runTailor(deps({ writer }));
    const first = store.latestApplication(jobId)!.verification as VerificationReport;
    assert.equal(first.letterSimilarity!.flagged, false, 'nothing earlier to compare with');

    store.setTailorFeedback(jobId, 'shorter');
    store.setStatus(jobId, 'selected', null, 'user', '2026-10-15T08:30:00.000Z');
    await runTailor(deps({ writer }));
    assert.equal((store.latestApplication(jobId)!.verification as VerificationReport).letterSimilarity!.flagged, false, 'v2 of the same job');

    const other = store.upsert(makeJob({ externalId: 'beta:1', company: 'Beta', title: 'Integration Engineer', description: 'LLM agents and REST integrations.' }), '2026-10-15T08:00:00.000Z').id;
    store.setStatus(other, 'selected', null, 'user', '2026-10-15T08:00:00.000Z');
    await runTailor(deps({ writer }));
    const app = store.latestApplication(other)!;
    const report = app.verification as VerificationReport;
    assert.equal(report.letterSimilarity!.flagged, true);
    assert.equal(report.letterSimilarity!.closest!.jobId, jobId);
    const warnings = report.issues.filter((i) => i.where === 'letter-wording').map((i) => i.message);
    assert.match(warnings[0]!, /^\d+% of this letter's wording is the same as your letter to Acme \(#\d+, AI Automation Engineer\)$/);
    assert.match(readFileSync(path.join(app.dir, 'report.md'), 'utf8'), /\*\*letter-wording\*\*: \d+% of this letter's wording/);
  });

  it('shows the writer how your latest letters to other jobs opened and closed, so the next one differs', async () => {
    const writer = new FakeWriter(sampleDraft, fixLetter);
    await runTailor(deps({ writer }));
    assert.equal(writer.drafts[0]!.recentLetters, undefined, 'no earlier letters yet');

    // A new version of the same job isn't compared with itself.
    store.setTailorFeedback(jobId, 'shorter');
    store.setStatus(jobId, 'selected', null, 'user', '2026-10-15T08:30:00.000Z');
    await runTailor(deps({ writer }));
    assert.equal(writer.drafts[1]!.recentLetters, undefined);

    const other = store.upsert(makeJob({ externalId: 'beta:1', company: 'Beta', title: 'Integration Engineer', description: 'LLM agents and REST integrations.' }), '2026-10-15T08:00:00.000Z').id;
    store.setStatus(other, 'selected', null, 'user', '2026-10-15T08:00:00.000Z');
    await runTailor(deps({ writer }));
    assert.deepEqual(writer.drafts[2]!.recentLetters, [
      { opening: 'Your posting describes LLM agents that resolve support conversations, which is the work I do every day.', closing: 'I would be glad to walk you through these flows.' },
    ]);

    // Turned off in config: the writer is told nothing.
    const third = store.upsert(makeJob({ externalId: 'gamma:1', company: 'Gamma', title: 'Bot Developer', description: 'LLM agents.' }), '2026-10-15T08:00:00.000Z').id;
    store.setStatus(third, 'selected', null, 'user', '2026-10-15T08:00:00.000Z');
    const off = exampleTailorConfig();
    off.coverLetter.varyFromRecent = 0;
    await runTailor(deps({ writer, cfg: off }));
    assert.equal(writer.drafts[3]!.recentLetters, undefined);
  });

  it('gives the writer only letters in the same language, each pair once', () => {
    const save = (externalId: string, letterLanguage: 'en' | 'he', first: string, closing: string) => {
      const id = store.upsert(makeJob({ externalId }), '2026-10-15T08:00:00.000Z').id;
      store.saveApplication({
        jobId: id, dir: outDir, cvLanguage: 'en', letterLanguage,
        content: { company: 'X', jobTitle: 'Y', letterLanguage, coverLetter: { greeting: '', paragraphs: [first, 'More.'], closing, signOff: '' } },
        verification: {}, feedback: null, model: null, createdAt: '2026-10-14T08:00:00.000Z',
      });
    };
    save('a:1', 'en', 'I build bots. And more.', 'Talk soon.');
    save('a:2', 'en', 'I build bots. Different second sentence.', 'Talk soon.');
    save('a:3', 'he', 'אני בונה בוטים. ועוד.', 'נדבר.');
    const now = new Date('2026-10-15T09:00:00Z');
    assert.deepEqual(recentLetterLines(store, jobId, 'en', 5, now), [{ opening: 'I build bots.', closing: 'Talk soon.' }]);
    assert.deepEqual(recentLetterLines(store, jobId, 'he', 5, now), [{ opening: 'אני בונה בוטים.', closing: 'נדבר.' }]);
    assert.deepEqual(recentLetterLines(store, jobId, 'en', 0, now), []);
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

  it('trims a CV over its page target, weakest parts first, until it fits', async () => {
    // A stand-in PDF engine: more than 3 bullets spill onto a second page.
    const rendered: number[] = [];
    const pdf = {
      async render(html: string, out: string) {
        writeFileSync(out, '%PDF-1.4');
        const bullets = (html.match(/<li>/g) ?? []).length;
        rendered.push(bullets);
        return { pages: html.includes('Cover Letter') || bullets <= 3 ? 1 : 2 };
      },
      async close() {},
    };
    await runTailor(deps({ pdf }));
    const app = store.latestApplication(jobId)!;
    const report = app.verification as VerificationReport;
    assert.equal(report.cvPages, 1);
    assert.match(report.issues.find((i) => i.where === 'layout')!.message, /trimmed to fit 1 page\(s\): /);
    const saved = JSON.parse(readFileSync(path.join(app.dir, 'content.json'), 'utf8'));
    const count = saved.experience.reduce((n: number, x: { bullets: unknown[] }) => n + x.bullets.length, 0) + saved.projects.reduce((n: number, x: { bullets: unknown[] }) => n + x.bullets.length, 0);
    assert.ok(count <= 3, `the saved content is the trimmed version (${count} bullets)`);
    assert.ok(rendered[0]! > 3 && rendered.length > 2, 'it rendered, trimmed and rendered again');
    assert.deepEqual((app.content as { experience: unknown[] }).experience, saved.experience, 'the database has the version in the PDF');
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
    // The CV's text reads back out of the PDF whole and in order, brackets and dashes included.
    assert.ok(report.pdfText && report.pdfText.checked > 10, 'the text check ran');
    assert.deepEqual({ missing: report.pdfText.missing, outOfOrder: report.pdfText.outOfOrder }, { missing: [], outOfOrder: [] });
    assert.ok(!report.issues.some((i) => i.where === 'pdf-text'));
    assert.match(readFileSync(path.join(app.dir, 'report.md'), 'utf8'), /## PDF text\nAll \d+ lines of the CV read back out of the PDF as text, in order\./);
  });

  it('warns when text on the page does not read back out of the PDF, and when the check cannot run', async () => {
    const engine = (readText: (file: string) => Promise<string>) => ({
      async render(_html: string, out: string) {
        writeFileSync(out, '%PDF-1.4');
        return { pages: 1 };
      },
      readText,
      async close() {},
    });
    // A parser that gets the name and nothing else.
    await runTailor(deps({ pdf: engine(async () => 'Dana TODO-last-name') }));
    let report = store.latestApplication(jobId)!.verification as VerificationReport;
    assert.ok(report.pdfText!.missing.length > 5);
    const issue = report.issues.find((i) => i.where === 'pdf-text')!;
    assert.equal(issue.severity, 'warning');
    assert.match(issue.message, /can't be read back out of the PDF as they appear on the page, so an applicant tracking system may not see them/);
    assert.equal(report.ok, true, 'a warning, not something to verify against your CV');

    // Rendered again without a PDF: there is nothing to check, and the old finding goes.
    ({ report } = await rerender(jobId, { store, cv: exampleCv(), cfg: exampleTailorConfig(), pdf: null }));
    assert.equal(report.pdfText, undefined);
    assert.ok(!report.issues.some((i) => i.where === 'pdf-text'));

    ({ report } = await rerender(jobId, { store, cv: exampleCv(), cfg: exampleTailorConfig(), pdf: engine(async () => { throw new Error('bad XRef entry'); }) }));
    assert.equal(report.pdfText, undefined);
    assert.match(report.issues.find((i) => i.where === 'pdf-text')!.message, /could not read the PDF's text back to check it: bad XRef entry/);
  });
});
