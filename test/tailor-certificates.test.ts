import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderCvHtml } from '../src/tailor/render.ts';
import type { TailoredContent } from '../src/tailor/schema.ts';
import { cvCorpus, normalizeDraft } from '../src/tailor/verify.ts';
import { exampleCv, exampleTailorConfig, sampleDraft } from './tailor-helpers.ts';

const cv = {
  ...exampleCv(),
  certifications: [
    { id: 'cert-aws', name: 'AWS Certified Developer – Associate', issuer: 'Amazon Web Services', year: '2024' },
    { id: 'cert-scrum', name: 'Professional Scrum Master I' },
  ],
};

describe('certificates in tailoring', () => {
  it('keeps the certificates you hold that the writer chose, in its order, and drops any it invented', () => {
    const { body, issues } = normalizeDraft({ ...sampleDraft(), certifications: ['cert-scrum', 'cert-made-up', 'cert-scrum', 'cert-aws'] }, cv, exampleTailorConfig());
    assert.deepEqual(body.certifications, ['cert-scrum', 'cert-aws']);
    assert.ok(issues.some((i) => i.where === 'certifications' && /cert-made-up/.test(i.message)));
  });

  it('caps them at cv.maxCertifications', () => {
    const cfg = exampleTailorConfig();
    const { body } = normalizeDraft({ ...sampleDraft(), certifications: ['cert-aws', 'cert-scrum'] }, cv, { ...cfg, cv: { ...cfg.cv, maxCertifications: 1 } });
    assert.deepEqual(body.certifications, ['cert-aws']);
  });

  it('lets the fact-check find them in your CV', () => {
    assert.match(cvCorpus(cv), /AWS Certified Developer/);
  });

  it('shows the chosen ones on the CV with your wording, and no section when none were chosen', () => {
    const { body } = normalizeDraft({ ...sampleDraft(), certifications: ['cert-aws'] }, cv, exampleTailorConfig());
    const content: TailoredContent = { jobId: 1, company: 'Acme', jobTitle: 'Engineer', cvLanguage: 'en', letterLanguage: 'en', generatedAt: '', ...body };
    const html = renderCvHtml(content, cv, exampleTailorConfig());
    assert.match(html, /<h2>Certifications<\/h2>/);
    assert.match(html, /AWS Certified Developer – Associate/);
    assert.match(html, /Amazon Web Services/);
    assert.doesNotMatch(html, /Scrum/);
    const none = renderCvHtml({ ...content, certifications: undefined }, cv, exampleTailorConfig());
    assert.doesNotMatch(none, /Certifications/, 'a version tailored before certificates existed still renders');
  });
});
