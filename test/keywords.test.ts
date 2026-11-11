import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MasterCvSchema } from '../src/config.ts';
import { keywordCoverage, redoNote } from '../src/tailor/keywords.ts';
import type { TailoredContent } from '../src/tailor/schema.ts';
import { jsonFixture } from './helpers.ts';

const cv = MasterCvSchema.parse(jsonFixture('master-cv.json'));

const content = (over: Partial<TailoredContent> = {}): Pick<TailoredContent, 'headline' | 'summary' | 'skills' | 'experience' | 'projects' | 'keywords'> => ({
  headline: 'Automation Developer',
  summary: 'Builds conversational automation.',
  skills: ['REST APIs'],
  experience: [{ id: 'acme', bullets: [{ source: 'acme-booking', text: 'Built appointment-booking flows with date/time slot pagination on top of SOAP and REST integrations' }] }],
  projects: [],
  ...over,
});

describe('ATS keyword coverage', () => {
  const posting = 'Integration Engineer. Must have: SOAP, Node.js, chatbot experience, Salesforce. Nice to have: SQLite.';
  const keywords = [
    { term: 'SOAP', cvTerm: 'SOAP', required: true, evidence: ['acme-booking'] },
    { term: 'Node.js', cvTerm: 'Node.js', required: true, evidence: [] },
    { term: 'chatbot experience', cvTerm: 'chatbot experience', required: true, evidence: ['acme-audit'] },
    { term: 'Salesforce', cvTerm: 'Salesforce', required: true, evidence: [] },
    { term: 'SQLite', cvTerm: 'SQLite', required: false, evidence: [] },
    { term: 'Kafka', cvTerm: 'Kafka', required: true, evidence: [] },
  ];

  it('checks every term against real text: the tailored CV, then your CV, then the cited highlight', () => {
    const c = keywordCoverage(content({ keywords }), cv, posting);
    assert.deepEqual(
      c.items.map((k) => [k.term, k.status]),
      [['SOAP', 'matched'], ['Node.js', 'left_out'], ['SQLite', 'left_out'], ['chatbot experience', 'reworded'], ['Salesforce', 'missing']],
      'Kafka is not in the posting, so it is dropped',
    );
    assert.match(c.items.find((k) => k.term === 'chatbot experience')!.evidence!, /^Audited bot scripts/);
    assert.deepEqual([c.matched, c.supported, c.total, c.requiredMatched, c.requiredTotal], [1, 4, 5, 1, 4]);
  });

  it('matches a Hebrew posting by the term in the CV language', () => {
    const c = keywordCoverage(
      content({ keywords: [{ term: 'ממשקי REST', cvTerm: 'REST APIs', required: true, evidence: [] }] }),
      cv,
      'מפתח/ת אוטומציה, עבודה עם ממשקי REST',
    );
    assert.deepEqual(c.items.map((k) => [k.term, k.status]), [['REST APIs', 'matched']]);
  });

  it('turns the terms your CV backs up into a note for the Tailor, and never asks for missing ones', () => {
    const note = redoNote(keywordCoverage(content({ keywords }), cv, posting));
    assert.match(note, /my CV already uses: Node\.js, SQLite\./);
    assert.match(note, /use the posting's wording: chatbot experience\./);
    assert.doesNotMatch(note, /Salesforce/);
  });

  it('handles versions made before keywords were tracked', () => {
    assert.equal(keywordCoverage(content(), cv, posting).total, 0);
  });
});
