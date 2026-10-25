import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyHardFilters } from '../src/pipeline/filters.ts';
import { NOW, makeJob, makePrefs } from './helpers.ts';
import type { NormalizedJob } from '../src/types.ts';

const prefs = makePrefs();
const check = (overrides: Parameters<typeof makeJob>[0]) => applyHardFilters(makeJob(overrides), prefs, NOW);
const code = (overrides: Parameters<typeof makeJob>[0]) => {
  const r = check(overrides);
  return r.pass ? 'pass' : r.code;
};

describe('hard filters', () => {
  it('passes a matching job', () => {
    assert.deepEqual(check({}), { pass: true });
  });

  it('excludes your current employer, with or without suffixes', () => {
    const mine = makePrefs({ excludeCompanies: ['Acme Health'] });
    const r = applyHardFilters(makeJob({ company: 'Acme Health Ltd.' }), mine, NOW);
    assert.equal(r.pass ? 'pass' : r.code, 'company');
  });

  it('applies title include/exclude and seniority lists', () => {
    assert.equal(code({ title: 'Account Executive' }), 'title_exclude');
    assert.equal(code({ title: 'Principal Engineer' }), 'seniority');
    assert.equal(code({ title: 'Software Engineering Intern' }), 'seniority');
    assert.equal(code({ title: 'Office Coordinator' }), 'title_include');
    assert.equal(code({ title: 'מפתח/ת אוטומציה' }), 'pass');
  });

  it('drops stale postings but keeps undated ones', () => {
    assert.equal(code({ postedAt: '2026-08-01T00:00:00Z' }), 'too_old');
    assert.equal(code({ postedAt: undefined }), 'pass');
  });

  it('checks location for on-site and hybrid roles', () => {
    assert.equal(code({ location: 'Haifa, Israel' }), 'pass'); // "israel" is allowed
    assert.equal(code({ location: 'Berlin, Germany' }), 'location');
    assert.equal(code({ location: 'חולון' }), 'pass');
    assert.equal(code({ location: '' }), 'pass'); // allowUnknown
  });

  it('allows remote roles unless restricted to an excluded region', () => {
    assert.equal(code({ workplaceType: 'remote', location: 'Remote' }), 'pass');
    assert.equal(code({ workplaceType: 'remote', location: 'Remote - US only' }), 'location');
    const noRemote = makePrefs({ locations: { ...prefs.locations, allowRemote: false } });
    const r = applyHardFilters(makeJob({ workplaceType: 'remote' }), noRemote, NOW);
    assert.equal(r.pass, false);
  });

  it('drops on-site roles when allowOnsite is off, keeping hybrid and unstated ones', () => {
    const remoteOrHybrid = makePrefs({ locations: { ...prefs.locations, allowOnsite: false } });
    const check = (job: Partial<NormalizedJob>) => {
      const r = applyHardFilters(makeJob(job), remoteOrHybrid, NOW);
      return r.pass ? 'pass' : r.code;
    };
    assert.equal(check({ workplaceType: 'onsite', location: 'Tel Aviv, Israel' }), 'location');
    assert.equal(check({ workplaceType: 'hybrid', location: 'Tel Aviv, Israel' }), 'pass');
    assert.equal(check({ workplaceType: 'unknown', location: 'Tel Aviv, Israel' }), 'pass');
    assert.equal(check({ workplaceType: 'hybrid', location: 'Berlin, Germany' }), 'location');
    assert.equal(check({ workplaceType: 'remote', location: 'Remote - Europe' }), 'pass');
    assert.equal(code({ workplaceType: 'onsite', location: 'Tel Aviv, Israel' }), 'pass'); // default allows on-site
  });

  it('filters by posting language and required languages', () => {
    const german = 'Wir suchen eine Entwicklerin für unser Team und die Arbeit mit der Plattform ist spannend und wir sind ein tolles Team.';
    assert.equal(code({ description: german }), 'posting_language');
    assert.equal(code({ description: 'You will build automations. Fluent German is required.' }), 'required_language');
    assert.equal(code({ description: 'You will build automations with us. German is a plus.' }), 'pass');
  });

  it('filters excluded employment types', () => {
    assert.equal(code({ employmentType: 'Part-time' }), 'employment_type');
  });
});
