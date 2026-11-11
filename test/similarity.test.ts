import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MasterCvSchema } from '../src/config.ts';
import { letterSimilarity, similarityMessages, similarityRedoNote, type EarlierLetter } from '../src/tailor/similarity.ts';
import { jsonFixture } from './helpers.ts';

const cv = MasterCvSchema.parse(jsonFixture('master-cv.json'));

const letter = (company: string, jobTitle: string, paragraphs: string[], closing = 'Thank you for reading.') => ({
  company, jobTitle, coverLetter: { greeting: 'Hello,', paragraphs, closing, signOff: 'Best regards' },
});
const earlier = (jobId: number, company: string, title: string, paragraphs: string[], closing = 'Thank you for reading.'): EarlierLetter => ({
  jobId, company, title, paragraphs: [...paragraphs, closing],
});

const template = (company: string, title: string) => [
  `I was excited to see the ${title} opening at ${company}, because building automation that customers actually enjoy talking to is what I care about most.`,
  `What draws me to ${company} is the chance to work on conversational products at scale, with a team that ships quickly and listens to its users.`,
];

describe('cover letters that read like your earlier ones', () => {
  it('catches a template that only swaps the company and title', () => {
    const s = letterSimilarity(letter('Beta', 'Integration Engineer', template('Beta', 'Integration Engineer')), [earlier(3, 'Acme', 'Automation Developer', template('Acme', 'Automation Developer'))], cv);
    assert.equal(s.flagged, true);
    assert.equal(s.closest!.jobId, 3);
    assert.ok(s.closest!.overlap > 0.9);
    assert.deepEqual(s.reused.map((r) => r.paragraph), [0, 1]);
    assert.equal(s.sameCompany, false);
    assert.equal(similarityMessages(s, 2).length, 1, 'a near-copy is reported once, not per paragraph');
  });

  it("doesn't count your CV's own facts, restated in every letter, as repetition", () => {
    const fact = "I am the sole developer of WhatsApp automation for Northwind Clinics, the company's largest account, for four years";
    const s = letterSimilarity(
      letter('Beta', 'Integration Engineer', [`Your posting asks for someone who owns a channel end to end. ${fact}.`, 'Your roadmap for clinics fits that experience well.']),
      [earlier(3, 'Acme', 'Automation Developer', [`Acme needs a builder who can carry a product alone. ${fact}.`, 'I would love to bring that to your support team.'])],
      cv,
    );
    assert.equal(s.flagged, false);
  });

  it('flags a reused closing line, and says when it is the same company', () => {
    const closing = 'I would be glad to walk you through these flows and how they could work for your customers.';
    const s = letterSimilarity(
      letter('Acme', 'Data Analyst', ['A first paragraph written fresh for this specific analyst role and its reporting needs.'], closing),
      [earlier(7, 'Acme Ltd.', 'Integration Engineer', ['Something entirely different about integrations and partner APIs for the earlier role.'], closing)],
      cv,
    );
    assert.deepEqual(s.reused.map((r) => r.paragraph), [1]);
    assert.equal(s.sameCompany, true);
    const messages = similarityMessages(s, 1);
    assert.ok(messages.some((m) => /^the closing line repeats your letter to Acme Ltd\. \(#7/.test(m)));
    assert.match(similarityRedoNote(s), /fresh words, with a different opening and closing: it reuses wording from my letter to Acme Ltd\./);
  });

  it('works for Hebrew letters', () => {
    const he = (company: string) => [`ראיתי את המשרה ב${company} ומיד הרגשתי שזה בדיוק התפקיד שחיפשתי, כי אני אוהב לבנות אוטומציה שעוזרת ללקוחות באמת.`];
    const s = letterSimilarity(letter('אומגה', 'מפתח אוטומציה', he('אומגה')), [earlier(2, 'דלתא', 'מפתח בוטים', he('דלתא'))], cv);
    assert.equal(s.flagged, true);
  });

  it('passes a letter with nothing to compare with', () => {
    const s = letterSimilarity(letter('Beta', 'Engineer', template('Beta', 'Engineer')), [], cv);
    assert.deepEqual(s, { compared: 0, closest: null, reused: [], sameCompany: false, flagged: false });
    assert.deepEqual(similarityMessages(s, 2), []);
  });
});
