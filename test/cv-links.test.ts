import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LinkError, overriddenBy, setCvLink } from '../src/cv/links.ts';
import { AnswersConfigSchema } from '../src/submit/schema.ts';
import { buildProfile } from '../src/submit/answers.ts';
import { renderCvHtml } from '../src/tailor/render.ts';
import type { TailoredContent } from '../src/tailor/schema.ts';
import { exampleCv, exampleTailorConfig } from './tailor-helpers.ts';

const URL_ = 'https://dana.example.io/portfolio/';
const withLinks = (links: Record<string, string>) => ({ ...exampleCv(), links });

describe('links in the CV', () => {
  it('adds a portfolio link, which forms get in their portfolio or website field and the CV shows in its header', () => {
    const cv = withLinks({ linkedin: 'https://www.linkedin.com/in/dana' });
    const change = setCvLink(cv, 'Portfolio', `  ${URL_} `);
    assert.deepEqual([change.key, change.previous], ['portfolio', null]);
    assert.deepEqual(change.cv.links, { linkedin: 'https://www.linkedin.com/in/dana', portfolio: URL_ });
    assert.deepEqual(cv.links, { linkedin: 'https://www.linkedin.com/in/dana' }, 'the CV passed in is not changed');

    const profile = buildProfile(change.cv, AnswersConfigSchema.parse({}), exampleTailorConfig().contact);
    assert.equal(profile.website, URL_);
    const content = { headline: 'Developer', summary: '', skills: [], experience: [], projects: [], certifications: [], cvLanguage: 'en' } as unknown as TailoredContent;
    assert.ok(renderCvHtml(content, change.cv, exampleTailorConfig()).includes(`<span>${URL_}</span>`));
  });

  it('replaces a link whatever its capitals, keeping its name and place', () => {
    const change = setCvLink(withLinks({ GitHub: 'https://github.com/old', portfolio: URL_ }), 'github', 'https://github.com/new');
    assert.deepEqual([change.key, change.previous], ['GitHub', 'https://github.com/old']);
    assert.deepEqual(Object.entries(change.cv.links), [['GitHub', 'https://github.com/new'], ['portfolio', URL_]]);
  });

  it('removes a link, and says which exist when asked to remove one that does not', () => {
    const cv = withLinks({ linkedin: 'https://www.linkedin.com/in/dana', portfolio: URL_ });
    assert.deepEqual(setCvLink(cv, 'portfolio', null).cv.links, { linkedin: 'https://www.linkedin.com/in/dana' });
    assert.throws(() => setCvLink(cv, 'blog', null), (e) => e instanceof LinkError && /no "blog" link\. It has: linkedin, portfolio/.test(e.message));
  });

  it('accepts only full web addresses', () => {
    const cv = withLinks({});
    for (const bad of ['dana.example.io/portfolio', 'javascript:alert(1)', 'mailto:dana@example.com', 'https://localhost', '']) {
      assert.throws(() => setCvLink(cv, 'portfolio', bad), LinkError, bad);
    }
    assert.throws(() => setCvLink(cv, ' - ', URL_), /Give the link a name/);
  });

  it('says when something else is what forms will get', () => {
    const cv = withLinks({ portfolio: URL_ });
    assert.equal(overriddenBy(cv, 'portfolio', { website: '' }), null);
    assert.equal(overriddenBy(cv, 'portfolio', { website: URL_ }), null);
    assert.match(overriddenBy(cv, 'portfolio', { website: 'https://old.example.com' })!, /profile\.website set to https:\/\/old\.example\.com, and the Submitter uses that first/);
    assert.match(overriddenBy(withLinks({ website: 'https://old.example.com', portfolio: URL_ }), 'portfolio')!, /also has a "website" link .*cv-link website --remove/);
    // A link no form field asks for by name is only in the header.
    assert.equal(overriddenBy(withLinks({ blog: URL_ }), 'blog', { website: 'https://old.example.com' }), null);
  });
});
