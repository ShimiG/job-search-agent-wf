import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyVerdicts, claimsForReview, extractTerms, factCheck, normalizeDraft, unknownNumbers } from '../src/tailor/verify.ts';
import { exampleCv, exampleTailorConfig, sampleDraft } from './tailor-helpers.ts';

const cv = exampleCv();
const cfg = exampleTailorConfig();
const posting = 'Acme is hiring an AI Automation Engineer. You will build LLM agents. Kubernetes experience required.';

describe('term and number extraction', () => {
  it('finds tool-like and mid-sentence capitalized terms, ignoring sentence starts', () => {
    const terms = extractTerms('Built flows with Node.js and C# on GPT-4.1. Deployed them to Kubernetes for Northwind.');
    assert.deepEqual(terms.sort(), ['C#', 'Northwind', 'GPT-4.1', 'Kubernetes', 'Node.js'].sort());
    assert.ok(!terms.includes('Built') && !terms.includes('Deployed'));
  });

  it('finds Latin terms inside Hebrew text', () => {
    assert.deepEqual(extractTerms('פיתחתי סוכני LLM עם Kubernetes').sort(), ['Kubernetes', 'LLM']);
  });

  it('flags numbers missing from the source', () => {
    assert.deepEqual(unknownNumbers('Cut handling time by 35% across 4 teams', 'across 4 teams'), ['35']);
  });
});

describe('normalizeDraft', () => {
  it('drops unknown highlights, projects and skills; dedupes and keeps CV casing', () => {
    const { body, issues } = normalizeDraft(sampleDraft(), cv, cfg);
    assert.deepEqual(body.experience[0]!.bullets.map((b) => b.source), ['acme-llm-agents', 'acme-booking', 'acme-northwind-owner']);
    assert.deepEqual(body.projects.map((p) => p.id), ['ticket-router']);
    assert.deepEqual(body.skills, ['REST APIs', 'LLM-powered support agents', 'Node.js']);
    const messages = issues.map((i) => i.message).join(' | ');
    assert.match(messages, /not-a-real-id/);
    assert.match(messages, /ghost-project/);
    assert.match(messages, /Kubernetes/);
  });

  it('restores roles the model left out and enforces limits', () => {
    const draft = sampleDraft();
    draft.experience = [];
    const small = exampleTailorConfig({ cv: { ...cfg.cv, maxProjects: 0 } });
    const { body, issues } = normalizeDraft(draft, cv, small);
    assert.equal(body.experience.length, cv.experience.length);
    assert.equal(body.experience[0]!.bullets[0]!.text, cv.experience[0]!.highlights[0]!.text);
    assert.equal(body.projects.length, 0);
    assert.ok(issues.some((i) => /restored/.test(i.message)));
  });
});

describe('factCheck', () => {
  it('reverts bullets that add numbers or tools, keeps honest rewrites', () => {
    const { body } = normalizeDraft(sampleDraft(), cv, cfg);
    const { issues } = factCheck(body, cv, posting, 'en', cfg);
    const [llm, booking] = body.experience[0]!.bullets;
    assert.match(llm!.text, /in production/); // honest rewrite kept (no new numbers/terms)
    assert.equal(booking!.text, cv.experience[0]!.highlights.find((h) => h.id === 'acme-booking')!.text);
    assert.ok(issues.some((i) => i.severity === 'fixed' && i.where === 'bullet:acme-booking'));
  });

  it('flags instead of reverting when the CV is translated', () => {
    const { body } = normalizeDraft(sampleDraft(), cv, cfg);
    const { issues } = factCheck(body, cv, posting, 'he', cfg);
    assert.ok(issues.some((i) => i.severity === 'unresolved' && i.where === 'bullet:acme-booking'));
  });

  it('marks letter terms that appear only in the posting for the fact-checker', () => {
    const { body } = normalizeDraft(sampleDraft(), cv, cfg);
    const { letterSuspects, issues } = factCheck(body, cv, posting, 'en', cfg);
    assert.deepEqual(letterSuspects.get(2), ['Kubernetes']);
    assert.ok(!issues.some((i) => i.where === 'letter:2'), 'posting terms are not hard failures');
  });

  it('hard-flags letter terms found in neither the CV nor the posting', () => {
    const draft = sampleDraft();
    draft.coverLetter.paragraphs.push({ text: 'I hold an AWS Solutions Architect certification.', sources: [] });
    const { body } = normalizeDraft(draft, cv, cfg);
    const { issues } = factCheck(body, cv, posting, 'en', cfg);
    assert.ok(issues.some((i) => i.severity === 'unresolved' && i.where === 'letter:3' && /AWS/.test(i.message)));
  });

  it('warns about long letters and avoided phrases', () => {
    const draft = sampleDraft();
    draft.coverLetter.paragraphs = [{ text: 'I am writing to apply. ' + 'word '.repeat(400), sources: [] }];
    const { body } = normalizeDraft(draft, cv, cfg);
    const { issues } = factCheck(body, cv, posting, 'en', cfg);
    assert.ok(issues.some((i) => /words \(limit/.test(i.message)));
    assert.ok(issues.some((i) => /avoided phrase/.test(i.message)));
  });
});

describe('claims and verdicts', () => {
  it('sends only reworded text for review, with posting-only terms called out', () => {
    const { body } = normalizeDraft(sampleDraft(), cv, cfg);
    const { letterSuspects } = factCheck(body, cv, posting, 'en', cfg);
    const claims = claimsForReview(body, cv, letterSuspects);
    const ids = claims.map((c) => c.id);
    assert.ok(ids.includes('bullet:acme-llm-agents'));
    assert.ok(!ids.includes('bullet:acme-northwind-owner'), 'unchanged bullets are your own words');
    assert.ok(!ids.includes('headline'), 'unchanged headline');
    assert.match(claims.find((c) => c.id === 'letter:2')!.note!, /Kubernetes/);
  });

  it('reverts unsupported bullets and summary, and returns letter problems', () => {
    const { body } = normalizeDraft(sampleDraft(), cv, cfg);
    const { issues, letterProblems } = applyVerdicts(
      body,
      cv,
      {
        claims: [
          { id: 'bullet:acme-llm-agents', supported: false, problem: 'says production' },
          { id: 'summary', supported: false, problem: 'overstates' },
          { id: 'letter:2', supported: false, problem: 'claims Kubernetes experience' },
          { id: 'letter:0', supported: true, problem: '' },
        ],
      },
      'en',
    );
    assert.equal(body.summary, cv.summary);
    assert.equal(body.experience[0]!.bullets[0]!.text, cv.experience[0]!.highlights.find((h) => h.id === 'acme-llm-agents')!.text);
    assert.equal(issues.length, 2);
    assert.deepEqual([...letterProblems], [[2, 'claims Kubernetes experience']]);
  });
});
