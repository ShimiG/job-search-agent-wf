import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderCvHtml, skillsHtml } from '../src/tailor/render.ts';
import { CV_SECTIONS, TailorConfigSchema, type TailoredContent } from '../src/tailor/schema.ts';
import { exampleCv, exampleTailorConfig } from './tailor-helpers.ts';

const cv = exampleCv();
const content: TailoredContent = {
  jobId: 1, company: 'Acme', jobTitle: 'Engineer', cvLanguage: 'en', letterLanguage: 'en',
  headline: 'Automation Developer', summary: 'Builds conversational automation.',
  skills: ['REST APIs', 'LLM-powered support agents', 'SOAP', 'Node.js', 'Prompt engineering'],
  experience: [{ id: 'acme', bullets: [{ source: 'acme-booking', text: 'Built appointment-booking flows' }] }],
  projects: [{ id: 'ticket-router', bullets: [{ source: 'ticket-router-pipeline', text: 'Built a job discovery agent' }] }],
  coverLetter: { greeting: '', paragraphs: [], closing: '', signOff: '' },
  notes: { emphasized: [], requirementsNotMet: [] },
  generatedAt: '2026-10-15T09:00:00.000Z',
};
const headings = (html: string) => [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);

describe('CV layout', () => {
  it('groups skills under their CV categories, the most relevant category first, comma-separated', () => {
    const html = skillsHtml(content.skills, cv, true);
    assert.deepEqual(
      [...html.matchAll(/<span class="skills-cat">([^<]+)<\/span> ([^<]+)<\/div>/g)].map((m) => [m[1], m[2]]),
      [['Integrations:', 'REST APIs, SOAP'], ['AI:', 'LLM-powered support agents, Prompt engineering'], ['Web (personal projects):', 'Node.js']],
    );
    // One line when grouping is off, or when everything is in one category.
    assert.equal(skillsHtml(content.skills, cv, false), '<p>REST APIs · LLM-powered support agents · SOAP · Node.js · Prompt engineering</p>');
    assert.equal(skillsHtml(['REST APIs', 'SOAP'], cv, true), '<p>REST APIs · SOAP</p>');
    assert.equal(skillsHtml([], cv, true), '');
  });

  it('keeps today\'s section order by default, and follows the order you set', () => {
    assert.deepEqual(headings(renderCvHtml(content, cv, exampleTailorConfig())), ['Summary', 'Experience', 'Projects', 'Skills', 'Education', 'Languages'].filter((h) => h !== 'Education' || cv.education.length > 0));
    const cfg = exampleTailorConfig();
    // The order the report recommends for mid-level and senior engineers: no summary, skills before projects.
    cfg.cv.sections = ['experience', 'skills', 'projects', 'education', 'languages'];
    const html = renderCvHtml(content, cv, cfg);
    assert.deepEqual(headings(html).slice(0, 3), ['Experience', 'Skills', 'Projects']);
    assert.doesNotMatch(html, /Builds conversational automation/, 'the summary is not printed');
    assert.match(html, /Automation Developer/, 'the headline stays in the header');
  });

  it('refuses a section list without experience or with a section twice', () => {
    const base = { contact: { email: 'a@b.co' } };
    assert.deepEqual(TailorConfigSchema.parse(base).cv.sections, [...CV_SECTIONS]);
    assert.equal(TailorConfigSchema.parse(base).cv.groupSkills, true);
    assert.throws(() => TailorConfigSchema.parse({ ...base, cv: { sections: ['skills', 'education'] } }), /needs its \\?"experience\\?" section/);
    assert.throws(() => TailorConfigSchema.parse({ ...base, cv: { sections: ['experience', 'skills', 'skills'] } }), /each section once/);
  });

  it('keeps the last-resort compact layout at 10pt type and half-inch margins', () => {
    const compact = renderCvHtml(content, cv, exampleTailorConfig(), { compact: true });
    assert.match(compact, /margin: 12\.7mm 14mm/);
    assert.match(compact, /font-size: 10pt/);
  });
});
