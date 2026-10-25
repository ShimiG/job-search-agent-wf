import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { docxText, pdfLinks, toMasterCv } from '../src/cv/import.ts';

const source = `Dana Levi
Integration Engineer · Tel Aviv
Built REST integrations between CRM systems and WhatsApp for enterprise clients.
Led the migration of 40 bot flows to the new runtime without downtime.
Acme Corp, Integration Engineer, 2021-03 to present`;

const extracted = {
  transcript: '',
  name: 'Dana Levi',
  headline: 'Integration Engineer',
  location: 'Tel Aviv',
  summary: '',
  email: 'dana@example.com',
  phone: '+972-50-000-0000',
  links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/dana' }, { label: 'GitHub', url: '' }],
  skills: [{ category: 'Integration', items: ['REST', ' CRM '] }, { category: 'Empty', items: [] }],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Integration Engineer',
      start: '2021-03',
      end: '',
      highlights: [
        'Built REST integrations between CRM systems and WhatsApp for enterprise clients.',
        'Led the migration of 40 bot flows to the new runtime without downtime.',
        'Increased revenue by 300% through visionary leadership.',
      ],
    },
  ],
  projects: [],
  education: [{ institution: 'Open University', degree: 'B.Sc. Computer Science', year: '' }],
  languages: [{ language: 'Hebrew', level: 'Native' }],
};

describe('CV import', () => {
  it('builds the master CV with stable highlight IDs', () => {
    const { cv, contact } = toMasterCv(extracted, source);
    assert.equal(cv.name, 'Dana Levi');
    assert.equal(cv.experience[0]!.end, undefined, 'a current role has no end date');
    assert.deepEqual(cv.experience[0]!.highlights.map((h) => h.id), ['acme-corp-integration-engineer-1', 'acme-corp-integration-engineer-2', 'acme-corp-integration-engineer-3']);
    const described = toMasterCv({ ...extracted, experience: [{ ...extracted.experience[0]!, company: 'Acme Health — enterprise customer-engagement & AI automation platform', role: 'AI & Automation Developer, Professional Services' }] }, source).cv;
    assert.equal(described.experience[0]!.id, 'acme-health-ai-automation-developer', 'short company name, cut at a word');
    assert.deepEqual(cv.links, { linkedin: 'https://www.linkedin.com/in/dana' }, 'links without a URL are dropped');
    assert.deepEqual(cv.skills, [{ category: 'Integration', items: ['REST', 'CRM'] }]);
    assert.deepEqual(contact, { email: 'dana@example.com', phone: '+972-50-000-0000' });
  });

  it("flags anything that isn't word for word in the file", () => {
    const { warnings } = toMasterCv(extracted, source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Increased revenue by 300%/);
    assert.match(toMasterCv(extracted, '').warnings[0]!, /Could not read the text/);
  });

  it("finds the addresses behind a PDF's links, plain or compressed", () => {
    const plain = '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://www.linkedin.com/in/dana) >> >>';
    const packed = deflateSync(Buffer.from('<< /A << /S /URI /URI (https://github.com/dana) >> >>')).toString('latin1');
    const pdf = Buffer.from(`%PDF-1.7\n1 0 obj ${plain} endobj\n2 0 obj << /Filter /FlateDecode >>\nstream\n${packed}\nendstream\nendobj`, 'latin1');
    assert.deepEqual(pdfLinks(pdf).sort(), ['https://github.com/dana', 'https://www.linkedin.com/in/dana']);
  });

  it('reads the text of a Word file', async () => {
    // A minimal .docx, built the way Word stores one: a zip of XML parts.
    const JSZip = createRequire(import.meta.url)('jszip');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dana Levi</w:t></w:r></w:p><w:p><w:r><w:t>Integration Engineer</w:t></w:r></w:p></w:body></w:document>');
    const text = await docxText(await zip.generateAsync({ type: 'nodebuffer' }));
    assert.match(text, /Dana Levi\s+Integration Engineer/);
  });
});
