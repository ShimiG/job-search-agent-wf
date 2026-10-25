import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cvStatus } from '../src/cv/ready.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'cv-'));
const write = (name: string, body: string) => (writeFileSync(path.join(dir, name), body), path.join(dir, name));

describe('is there a CV to work from', () => {
  it('no: missing, blank (the starter file), a TODO name, invalid, or no experience', () => {
    assert.equal(cvStatus(path.join(dir, 'missing.json')).ready, false);
    assert.equal(cvStatus(path.join(here, '..', 'examples', 'master-cv.json')).ready, false, 'the starter CV is blank');
    assert.equal(cvStatus(path.join(here, 'fixtures', 'master-cv.json')).ready, false, '"Dana TODO-last-name"');
    assert.equal(cvStatus(write('broken.json', '{')).ready, false);
    const base = { name: 'Dana Levi', headline: '', summary: '', skills: [], projects: [], education: [], languages: [], links: {} };
    assert.equal(cvStatus(write('empty.json', JSON.stringify({ ...base, experience: [] }))).reason, 'The CV has no work experience yet');
  });

  it('yes: a name and a job with highlights', () => {
    const cv = { name: 'Dana Levi', headline: '', summary: '', skills: [], projects: [], education: [], languages: [], links: {},
      experience: [{ id: 'acme', company: 'Acme', role: 'Engineer', start: '2021', highlights: [{ id: 'acme-1', text: 'Built integrations' }] }] };
    assert.deepEqual(cvStatus(write('ok.json', JSON.stringify(cv))), { ready: true });
  });
});
