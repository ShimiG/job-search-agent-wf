import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bulletProblems, formatStyleNotes, hasNumber, MAX_BULLET_CHARS, sentenceCount, styleNotes, styleRedoNote } from '../src/tailor/style.ts';
import { exampleCv } from './tailor-helpers.ts';

const problems = (text: string) => bulletProblems(text).map((p) => p.split(':')[0]);

describe('CV bullet style', () => {
  it('passes a bullet that opens with a verb, uses digits and fits two lines', () => {
    assert.deepEqual(bulletProblems('Reduced checkout API p99 latency by 48% (1.8s to 210ms) under a 3,200 QPS peak load by refactoring PostgreSQL joins and adding a Redis cache'), []);
    assert.deepEqual(bulletProblems('Built LLM-powered support agents grounded in a knowledge base'), []);
    assert.deepEqual(bulletProblems('Maintain the US region i/o pipeline for 3 teams'), [], '"US" and "i/o" are not pronouns');
  });

  it('flags weak openers, pronouns, praise words, spelled-out numbers and noun or -ing openers', () => {
    assert.deepEqual(problems('Responsible for optimizing database queries'), ['opens with "Responsible for"']);
    assert.deepEqual(problems('Worked on the billing service with my team'), ['opens with "Worked on"', 'uses "my"']);
    assert.deepEqual(problems('Built a tool that I use daily'), ['uses "I"']);
    assert.deepEqual(problems('Successfully migrated three services to Kubernetes'), ['"Successfully" praises the work without describing it', 'write "three" as a digit']);
    assert.deepEqual(problems('The main developer of the WhatsApp automation'), ['opens with a noun phrase']);
    assert.deepEqual(problems('Developing internal tools for support'), ['opens with "Developing"']);
    assert.deepEqual(problems('Delivered a cutting edge, world-class pipeline'), ['"cutting edge" praises the work without describing it']);
  });

  it('flags a bullet over two lines in any language, and applies wording rules to English only', () => {
    assert.match(bulletProblems(`Built ${'x'.repeat(MAX_BULLET_CHARS)}`)[0]!, /^runs to about three lines \(\d+ characters/);
    assert.deepEqual(bulletProblems('אחראי על פיתוח אוטומציות עבור הלקוח הגדול של החברה'), []);
    assert.equal(bulletProblems(`אחראי על ${'א'.repeat(MAX_BULLET_CHARS)}`).length, 1);
    assert.deepEqual([hasNumber('Cut build time by 40%'), hasNumber('Built the booking flows')], [true, false]);
  });

  it("lists a tailored CV's bullets that break a rule, and says which are the CV's own wording", () => {
    const cv = exampleCv();
    const own = cv.experience[0]!.highlights[0]!;
    const notes = styleNotes(
      {
        experience: [{ id: 'acme', bullets: [{ source: own.id, text: own.text }, { source: 'acme-booking', text: 'Responsible for appointment-booking flows' }, { source: 'acme-audit', text: 'Audited bot scripts to find routing bugs' }] }],
        projects: [{ id: 'ticket-router', bullets: [{ source: 'ticket-router-pipeline', text: cv.projects[0]!.highlights[0]!.text }] }],
      },
      cv,
    );
    // The CV's own "…for four years" spells a number; the reworded line has a weak opener; the third is fine.
    assert.deepEqual(notes.map((n) => [n.where, n.fromCv, n.problems.length]), [['bullet:acme-northwind-owner', true, 1], ['bullet:acme-booking', false, 1]]);
    const redo = styleRedoNote(notes);
    assert.match(redo, /Rewrite these CV bullets[\s\S]*"Responsible for appointment-booking flows…" \(opens with "Responsible for"\)/);
    assert.equal(styleRedoNote(notes.filter((n) => n.fromCv)), '', "nothing to redo when every flagged line is the CV's own");
  });

  it('counts sentences without being fooled by Node.js, e.g. or version numbers', () => {
    assert.equal(sentenceCount(''), 0);
    assert.equal(sentenceCount('Backend developer building Node.js services, e.g. REST APIs on v2.1 of the platform.'), 1);
    assert.equal(sentenceCount('Software engineer building AI agents. Sole owner of a production system. Also builds tools.'), 3);
    assert.equal(sentenceCount('Owns 5 integrations. 3 of them are SOAP.'), 2);
    assert.equal(sentenceCount('Integrations for clients, e.g. REST and SOAP, at Acme Inc. in Tel Aviv. Runs them in production.'), 2);
    assert.equal(sentenceCount('מפתח אוטומציה. בונה סוכני AI.'), 2);
  });

  it('flags a summary over two sentences, and a project that outweighs the latest role', () => {
    const cv = exampleCv();
    const bullet = (source: string) => ({ source, text: cv.experience[0]!.highlights.find((h) => h.id === source)?.text ?? 'Built it' });
    const content = {
      summary: 'Software engineer building AI agents. Owns a production WhatsApp system. Also builds tools.',
      experience: [{ id: 'acme', bullets: [bullet('acme-booking'), bullet('acme-audit')] }],
      projects: [{ id: 'ticket-router', bullets: [{ source: 'ticket-router-pipeline', text: 'Built a router' }, { source: 'x', text: 'Built tests' }, { source: 'y', text: 'Built a CLI' }] }],
    };
    const notes = styleNotes(content, cv);
    assert.deepEqual(notes.map((n) => [n.where, n.fromCv]), [['summary', false], ['projects:ticket-router', false]]);
    assert.match(notes[0]!.problems[0]!, /^the summary is 3 sentences: two at most/);
    assert.match(notes[1]!.problems[0]!, /^this project has 3 bullets and your latest role 2/);
    assert.equal(notes[1]!.text, 'Ticket Router');
    const redo = styleRedoNote(notes);
    assert.match(redo, /^Shorten the summary to two sentences: role title, core stack, production scope, one ownership signal\. Give the project "Ticket Router" fewer bullets than the latest role\.$/);
    assert.match(formatStyleNotes(notes).join('\n'), /^## Wording and layout\n/);
    // Two sentences, and a project no bigger than the role: nothing to say.
    assert.deepEqual(styleNotes({ ...content, summary: 'Software engineer building AI agents. Owns a production system.', projects: [{ id: 'ticket-router', bullets: content.projects[0]!.bullets.slice(0, 2) }] }, cv), []);
    // The CV's own summary, when the writer kept it: the fix belongs in the CV.
    assert.equal(styleNotes({ ...content, summary: `${cv.summary} One. Two.`, projects: [] }, { ...cv, summary: `${cv.summary} One. Two.` })[0]!.fromCv, true);
  });
});
