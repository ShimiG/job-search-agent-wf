import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPdfText, pageText, pdfTextMessage, pdfTextOk } from '../src/tailor/pdf-text.ts';
import { renderCvHtml } from '../src/tailor/render.ts';
import type { TailoredContent } from '../src/tailor/schema.ts';
import { exampleCv, exampleTailorConfig } from './tailor-helpers.ts';

const PAGE = `<!doctype html><html><head><title>Not on the page</title><style>h2 { text-transform: uppercase; }</style></head><body>
<h1>Dana Levi</h1>
<h2>Experience</h2>
<div class="entry-head"><div>Backend Developer · Acme</div><div>2021 – Present</div></div>
<ul><li>Built a billing service (Node.js) that handles 40 requests a second</li><li>Cut the nightly run from 3 hours to 20 minutes</li></ul>
<h2>Skills</h2>
<div class="skills"><span class="skills-cat">Languages:</span> TypeScript, Python</div>
</body></html>`;

test('pageText: every piece of text on the page, in reading order, without the title or styles', () => {
  assert.deepEqual(pageText(PAGE), [
    'Dana Levi',
    'Experience',
    'Backend Developer · Acme',
    '2021 – Present',
    'Built a billing service (Node.js) that handles 40 requests a second',
    'Cut the nightly run from 3 hours to 20 minutes',
    'Skills',
    'Languages:',
    'TypeScript, Python',
  ]);
});

test('text that reads back whole and in order passes, whatever the line breaks, spacing and capitals', () => {
  const extracted = `Dana Levi\nEXPERIENCE\nBackend Developer · Acme2021 – Present\nBuilt a billing service (Node.js) that handles 40\nrequests a second\nCut the nightly run from 3 hours to 20 minutes\nSKILLS\nLanguages: TypeScript, Python`;
  const c = checkPdfText(extracted, pageText(PAGE));
  assert.equal(c.checked, 9);
  assert.ok(pdfTextOk(c));
  assert.equal(pdfTextMessage(c), 'All 9 lines of the CV read back out of the PDF as text, in order.');
});

test('a character the font drew with no text behind it is caught', () => {
  // What a real PDF gave before ligatures and contextual glyphs were turned off: the "(" is gone.
  const extracted = `Dana Levi\nEXPERIENCE\nBackend Developer · Acme 2021 – Present\nBuilt a billing service Node.js) that handles 40 requests a second\nCut the nightly run from 3 hours to 20 minutes\nSKILLS\nLanguages: TypeScript, Python`;
  const c = checkPdfText(extracted, pageText(PAGE));
  assert.deepEqual(c.missing, ['Built a billing service (Node.js) that handles 40 requests a second']);
  assert.deepEqual(c.outOfOrder, []);
  assert.match(pdfTextMessage(c), /^1 of 9 lines can't be read back out of the PDF as they appear on the page/);
});

test('text read in a different place than it is on the page is reported as out of order', () => {
  // A two-column layout read column by column: the skills come out before the experience.
  const extracted = `Dana Levi\nSKILLS\nLanguages: TypeScript, Python\nEXPERIENCE\nBackend Developer · Acme 2021 – Present\nBuilt a billing service (Node.js) that handles 40 requests a second\nCut the nightly run from 3 hours to 20 minutes`;
  const c = checkPdfText(extracted, pageText(PAGE));
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.outOfOrder, ['Skills', 'Languages:', 'TypeScript, Python']);
  assert.match(pdfTextMessage(c), /3 line\(s\) are read out of the PDF in a different place/);
});

test('Hebrew is stored in the order it is drawn: the same characters in another order pass, a missing word does not', () => {
  const pieces = ['מפתח צד שרת', 'בניתי שירות ב-TypeScript שמטפל ב-40 בקשות בשנייה (REST API) והפחית עלויות ב-30%'];
  // As Chromium writes it: words right to left, wrapped over two lines.
  const drawn = 'שרת צד מפתח\nבשנייה בקשות 40-ב שמטפל TypeScript-ב שירות בניתי\n30%-ב עלויות והפחית (REST API)';
  assert.ok(pdfTextOk(checkPdfText(drawn, pieces)));
  const c = checkPdfText(drawn.replace('עלויות', ''), pieces);
  assert.equal(c.missing.length, 1);
  assert.match(c.missing[0]!, /^בניתי שירות/);
});

test('the CV template yields one piece per line, with grouped skills as label and list', () => {
  const cv = exampleCv();
  const content = {
    headline: 'Automation Developer',
    summary: 'Builds support agents.',
    skills: cv.skills.flatMap((g) => g.items).slice(0, 4),
    experience: [{ id: cv.experience[0]!.id, bullets: [{ source: cv.experience[0]!.highlights[0]!.id, text: 'Built 3 agents' }] }],
    projects: [],
    certifications: [],
    cvLanguage: 'en',
  } as unknown as TailoredContent;
  const pieces = pageText(renderCvHtml(content, cv, exampleTailorConfig()));
  assert.equal(pieces[0], cv.name);
  assert.ok(pieces.includes('Built 3 agents') && pieces.includes('Builds support agents.') && pieces.includes('Experience'));
  assert.ok(!pieces.some((p) => p.includes('font-variant')), 'no CSS in the text');
});
