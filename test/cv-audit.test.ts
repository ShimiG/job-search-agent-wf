import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditCv, auditIsClean, formatAudit, MAX_SUMMARY_CHARS } from '../src/cv/audit.ts';
import { MasterCvSchema, type MasterCv } from '../src/config.ts';

const cv = (over: Partial<MasterCv> = {}): MasterCv =>
  MasterCvSchema.parse({
    name: 'Dana Levi',
    headline: 'Backend Developer',
    summary: 'Backend developer who builds data pipelines.',
    skills: [{ category: 'Languages', items: ['TypeScript', 'Python'] }],
    experience: [
      {
        id: 'acme',
        company: 'Acme',
        role: 'Backend Developer',
        start: '2021',
        highlights: [
          { id: 'acme-1', text: 'Built a TypeScript ingestion service that handles 40 requests a second' },
          { id: 'acme-2', text: 'Rewrote the Python billing jobs, cutting the nightly run from 3 hours to 20 minutes' },
        ],
      },
    ],
    ...over,
  });

test('a CV that follows the rules has nothing to fix', () => {
  const a = auditCv(cv());
  assert.equal(a.highlights, 2);
  assert.equal(a.withNumber, 2);
  assert.ok(auditIsClean(a));
  assert.match(formatAudit(a), /2 of 2 highlights state a number\.\nNothing else to fix/);
});

test('highlights: wording problems are listed with their ID, and ones with no number separately', () => {
  const base = cv();
  base.experience[0]!.highlights.push(
    { id: 'acme-3', text: 'Responsible for the deployment pipeline' },
    { id: 'acme-4', text: 'Migrated three services to Kubernetes' },
  );
  const a = auditCv(base);
  assert.deepEqual(a.wording.map((f) => f.id), ['acme-3', 'acme-4']);
  assert.match(a.wording[0]!.problems[0]!, /opens with "Responsible for"/);
  assert.equal(a.wording[0]!.entry, 'Backend Developer, Acme');
  // "three" is a number to a reader but not a digit: it is a wording fix, and still has no figure.
  assert.deepEqual(a.noNumber.map((f) => f.id), ['acme-3', 'acme-4']);
  assert.equal(a.withNumber, 2);
  assert.ok(!auditIsClean(a));
  const text = formatAudit(a);
  assert.match(text, /Wording \(2\):/);
  assert.match(text, /No number \(2\)\. If you have a real figure/);
});

test('skills: self-given grades, office tools, repeats and skills nothing shows', () => {
  const a = auditCv(
    cv({
      skills: [
        { category: 'Languages', items: ['TypeScript', 'Python (Advanced)', 'Go'] },
        { category: 'Tools', items: ['Jira', 'Docker', 'typescript'] },
      ],
      projects: [{ id: 'p', name: 'Side project', stack: ['Docker'], highlights: [{ id: 'p-1', text: 'Shipped 2 releases' }] }],
    }),
  );
  const of = (skill: string) => a.skills.filter((s) => s.skill === skill).map((s) => s.problem);
  assert.deepEqual(of('TypeScript'), []);
  // The grade is flagged; "Python" itself is shown by a highlight, so that is all.
  assert.equal(of('Python (Advanced)').length, 1);
  assert.match(of('Python (Advanced)')[0]!, /"Advanced" is a grade you gave yourself/);
  assert.match(of('Go')[0]!, /no highlight or project mentions it/);
  assert.deepEqual(a.skills.map((s) => s.kind), ['graded', 'unshown', 'generic', 'repeat']);
  assert.match(of('Jira')[0]!, /a tool every team uses/);
  // A project's stack counts as showing a skill.
  assert.deepEqual(of('Docker'), []);
  assert.match(of('typescript')[0]!, /also listed under "Languages"/);
});

test('"Go" is not found inside other words', () => {
  const base = cv({ skills: [{ category: 'Languages', items: ['Go'] }] });
  base.experience[0]!.highlights.push({ id: 'acme-5', text: 'Cut 12 cron jobs by going serverless on Google Cloud' });
  assert.match(auditCv(base).skills[0]!.problem, /no highlight or project mentions it/);
});

test('a skill of several words is shown by its telling word, in any form; a filler word does not count', () => {
  const base = cv({
    skills: [{ category: 'Other', items: ['REST APIs', 'Knowledge-base grounding', 'WhatsApp Business messaging', 'JavaScript (ES5 through modern)', 'Prompt engineering', 'Acme', 'Data pipelines'] }],
  });
  base.experience[0]!.highlights.push(
    { id: 'acme-6', text: 'Built 4 SOAP and REST integrations for WhatsApp automation' },
    { id: 'acme-7', text: 'Developed 2 support agents grounded in a knowledge base' },
  );
  const a = auditCv(base);
  // "engineering", "data" and "APIs" say nothing on their own; the employer's name is in the CV.
  assert.deepEqual(a.skills.map((s) => s.skill), ['JavaScript (ES5 through modern)', 'Prompt engineering', 'Data pipelines']);
  assert.match(formatAudit(a), /- No highlight or project mentions these, so a reader has only the word to go on: JavaScript \(ES5 through modern\), Prompt engineering, Data pipelines/);
});

test('summary and thin entries', () => {
  const base = cv({ summary: `Innovative developer. ${'Builds services. '.repeat(30)}` });
  base.experience[0]!.highlights.length = 1;
  const a = auditCv(base);
  assert.ok(a.general.some((g) => g.includes(`about four lines (${MAX_SUMMARY_CHARS})`)));
  assert.ok(a.general.some((g) => /The summary: "Innovative" praises the work/i.test(g)));
  // A summary is not a bullet: opening with a noun phrase is fine there.
  assert.ok(!a.general.some((g) => g.includes('active verb')));
  assert.ok(a.general.some((g) => g.startsWith('Fewer than 2 highlights') && g.includes('Backend Developer, Acme')));
});

test('a Hebrew CV is only checked for length', () => {
  const base = cv();
  base.experience[0]!.highlights = [{ id: 'h-1', text: 'אחראי על פיתוח שירותי צד שרת עבור 3 לקוחות' }, { id: 'h-2', text: 'בניתי מערכת ניטור עם 12 התראות' }];
  base.skills = [];
  assert.ok(auditIsClean(auditCv(base)));
});
