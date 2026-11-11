import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bulletProblems, hasNumber, MAX_BULLET_CHARS, styleNotes, styleRedoNote } from '../src/tailor/style.ts';
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
});
