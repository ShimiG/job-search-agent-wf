import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  addCertificate, CERTIFICATE_MAX_BYTES, certificateFile, certificateFiles, listCertificates, removeCertificate, sniffType, validateCertificate, withCertificates,
} from '../src/cv/certificates.ts';
import { exampleCv } from './tailor-helpers.ts';

const pdf = Buffer.from('%PDF-1.4 certificate');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe('certificate upload validation', () => {
  it('knows PDF, PNG and JPG by their content, whatever the name', () => {
    assert.equal(sniffType(pdf), 'pdf');
    assert.equal(sniffType(png), 'png');
    assert.equal(sniffType(jpg), 'jpg');
    assert.equal(sniffType(Buffer.from('MZ\x90\x00 an .exe renamed to .pdf')), null);
  });

  it('refuses empty, oversized and other files', () => {
    assert.equal(validateCertificate(pdf), null);
    assert.match(validateCertificate(Buffer.alloc(0))!, /empty/);
    assert.match(validateCertificate(Buffer.concat([pdf, Buffer.alloc(CERTIFICATE_MAX_BYTES)]))!, /over 5 MB/);
    assert.match(validateCertificate(Buffer.from('GIF89a'))!, /PDF, PNG or JPG/);
  });
});

describe('your certificates', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), 'certs-')), 'certificates');
  });

  it('adds, lists and removes certificates with their file and details', () => {
    const now = new Date('2026-10-28T09:00:00Z');
    const a = addCertificate(dir, { data: pdf, originalName: '../../aws.pdf', title: ' AWS Certified Developer ', issuer: 'Amazon Web Services', year: '2024' }, now);
    const b = addCertificate(dir, { data: png, originalName: 'scrum.png', title: 'Professional Scrum Master I' });
    assert.deepEqual(
      listCertificates(dir).map((c) => [c.title, c.type, c.originalName]),
      [['AWS Certified Developer', 'pdf', 'aws.pdf'], ['Professional Scrum Master I', 'png', 'scrum.png']],
    );
    assert.equal(a.uploadedAt, now.toISOString());
    assert.equal(a.size, pdf.length);
    assert.ok(existsSync(certificateFile(dir, a)), 'kept under its id, never under the uploaded name');
    assert.equal(path.dirname(certificateFile(dir, a)), dir);

    assert.equal(removeCertificate(dir, b.id), true);
    assert.equal(existsSync(certificateFile(dir, b)), false);
    assert.equal(removeCertificate(dir, b.id), false);
    assert.deepEqual(certificateFiles(dir).map((c) => c.id), [a.id]);
  });

  it('needs a title and a real year, and refuses an invalid file without saving anything', () => {
    assert.throws(() => addCertificate(dir, { data: pdf, originalName: 'x.pdf', title: '  ' }), /title/);
    assert.throws(() => addCertificate(dir, { data: pdf, originalName: 'x.pdf', title: 'AWS', year: '24' }), /2024/);
    assert.throws(() => addCertificate(dir, { data: Buffer.from('<html>'), originalName: 'x.pdf', title: 'AWS' }), /PDF, PNG or JPG/);
    assert.deepEqual(listCertificates(dir), []);
  });

  it('keeps at most 20', () => {
    for (let i = 0; i < 20; i++) addCertificate(dir, { data: pdf, originalName: `${i}.pdf`, title: `Cert ${i}` });
    assert.throws(() => addCertificate(dir, { data: pdf, originalName: 'x.pdf', title: 'One more' }), /up to 20/);
  });

  it('gives the Tailor what each certificate is, and nothing when there are none', () => {
    const cv = exampleCv();
    assert.equal(withCertificates(cv, dir), cv);
    const a = addCertificate(dir, { data: pdf, originalName: 'aws.pdf', title: 'AWS Certified Developer', issuer: 'Amazon Web Services', year: '2024' });
    assert.deepEqual(withCertificates(cv, dir).certifications, [{ id: a.id, name: 'AWS Certified Developer', issuer: 'Amazon Web Services', year: '2024' }]);
  });
});
