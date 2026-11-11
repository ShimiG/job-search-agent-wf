import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeProjects, parseProjectsFile } from '../src/cv/projects.ts';
import { exampleCv } from './tailor-helpers.ts';

const project = (id: string, name: string, highlightIds: string[] = [`${id}-1`]) => ({
  id, name, stack: ['TypeScript'], highlights: highlightIds.map((h) => ({ id: h, text: `Did ${h}` })),
});

describe('updating the CV\'s projects from a file', () => {
  it('replaces a project with the same ID or the same name, adds the rest, and keeps the others', () => {
    const cv = exampleCv();
    const before = cv.projects.map((p) => p.name);
    assert.deepEqual(before, ['Ticket Router', 'Photo Sorter']);
    const merged = mergeProjects(cv, [project('ticket-router', 'Ticket Router v2'), project('photos', 'photo  sorter'), project('new-one', 'New One')]);
    assert.deepEqual(merged.updated, ['Ticket Router v2', 'photo  sorter']);
    assert.deepEqual(merged.added, ['New One']);
    assert.deepEqual([merged.kept, merged.removed], [[], []]);
    assert.deepEqual(merged.cv.projects.map((p) => p.id), ['ticket-router', 'photos', 'new-one']);
    assert.equal(merged.cv.experience, cv.experience, 'the rest of the CV is untouched');
    assert.deepEqual(cv.projects.map((p) => p.name), before, 'the CV passed in is not changed');
  });

  it('keeps projects the file does not list, unless told to replace them all', () => {
    const cv = exampleCv();
    const kept = mergeProjects(cv, [project('new-one', 'New One')]);
    assert.deepEqual([kept.added, kept.kept], [['New One'], ['Ticket Router', 'Photo Sorter']]);
    assert.deepEqual(kept.cv.projects.map((p) => p.name), ['New One', 'Ticket Router', 'Photo Sorter']);
    const all = mergeProjects(cv, [project('new-one', 'New One')], { replaceAll: true });
    assert.deepEqual([all.removed, all.cv.projects.map((p) => p.name)], [['Ticket Router', 'Photo Sorter'], ['New One']]);
  });

  it('refuses highlight IDs that are not unique across the CV, and a project listed twice', () => {
    const cv = exampleCv();
    assert.throws(() => mergeProjects(cv, [project('x', 'X', ['acme-booking'])]), /"acme-booking" is used by both .*Acme Health and the project "X"/);
    assert.throws(() => mergeProjects(cv, [project('x', 'X', ['ticket-router-pipeline'])]), /used by both the project "X" and the project "Ticket Router"/);
    assert.throws(() => mergeProjects(cv, [project('x', 'X'), project('y', 'x')]), /in the file twice/);
  });

  it('reads a list or an object with a projects list, and rejects anything else', () => {
    assert.equal(parseProjectsFile([project('a', 'A')]).length, 1);
    assert.equal(parseProjectsFile({ projects: [project('a', 'A')] })[0]!.stack[0], 'TypeScript');
    assert.throws(() => parseProjectsFile({ projects: [{ name: 'no id' }] }));
  });
});
