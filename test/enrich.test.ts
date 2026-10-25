import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkApplyUrl, checkReport, overlap } from '../src/llm/enrich.ts';

const page = `Careers at Acme. AI Transformation Engineer, Tel Aviv. You'll join the AI Platform team building agentic workflows
and tooling for our R&D organization. Requirements: experience building agentic systems, strong TypeScript or Python, and
production LLM integrations. Nice to have: evaluation pipelines and developer tooling. Apply now.`;
const description = `You'll join the AI Platform team building agentic workflows and tooling for our R&D organization.
Requirements: experience building agentic systems, strong TypeScript or Python, and production LLM integrations.
Nice to have: evaluation pipelines and developer tooling.`;
const report = (over = {}) => ({
  found: true, job_status: 'open' as 'open' | 'closed' | 'unknown', url: 'https://boards.greenhouse.io/acme/jobs/1', description, location: 'Tel Aviv', workplace_type: 'hybrid' as const, date_posted: '2026-10-01', apply_url: '', note: 'company page', ...over,
});
const fetched = new Map([['https://boards.greenhouse.io/acme/jobs/1/', page]]);

describe('full posting lookup', () => {
  it('accepts text copied from a page it fetched', () => {
    const { posting } = checkReport(report(), fetched);
    assert.equal(posting?.url, 'https://boards.greenhouse.io/acme/jobs/1');
    assert.equal(posting?.workplaceType, 'hybrid');
    assert.equal(posting?.postedAt, '2026-10-01T00:00:00.000Z');
    assert.equal(checkReport(report({ date_posted: 'last week' }), fetched).posting?.postedAt, undefined, 'only a stated date');
  });

  it('rejects pages it never fetched, blocked sites, and text that is not on the page', () => {
    assert.match(checkReport(report({ url: 'https://jobs.example.com/acme/1' }), fetched).reason, /did not fetch/);
    assert.match(checkReport(report({ url: 'https://www.linkedin.com/jobs/view/1/' }), fetched).reason, /not allowed/);
    const invented = 'Lead our quantum blockchain marketplace. Requirements: Rust, Solidity, Kubernetes and ten years managing distributed teams across continents. '.repeat(2);
    assert.match(checkReport(report({ description: invented }), fetched).reason, /doesn't match the fetched page/);
    assert.match(checkReport(report({ found: false, note: 'no posting online' }), fetched).reason, /no posting online/);
  });

  it('believes a closed job only when the fetched page says so', () => {
    const closedPage = new Map([['https://acme.example/jobs/1', 'AI Engineer. This position is no longer accepting applications.']]);
    const said = checkReport(report({ found: false, job_status: 'closed', url: 'https://acme.example/jobs/1', description: '' }), closedPage);
    assert.equal(said.closed, true);
    const unsupported = checkReport(report({ job_status: 'closed' }), fetched);
    assert.notEqual(unsupported.closed, true, 'the fetched page has no closing wording');
  });

  it("accepts an apply page only on an ATS or the company's own site, and only one it saw", () => {
    const seen = new Set(['https://www.comeet.com/jobs/voyantis/86.00B/ai-native-software-engineer/89.E6C', 'https://voyantis.ai/careers/ai-engineer', 'https://freehire.me/jobs/ai-engineer-voyantis']);
    assert.ok(checkApplyUrl('https://www.comeet.com/jobs/voyantis/86.00B/ai-native-software-engineer/89.E6C', 'Voyantis', seen));
    assert.ok(checkApplyUrl('https://voyantis.ai/careers/ai-engineer', 'Voyantis', seen), "the company's own domain");
    assert.equal(checkApplyUrl('https://freehire.me/jobs/ai-engineer-voyantis', 'Voyantis', seen), undefined, 'a copy site has no form');
    assert.equal(checkApplyUrl('https://job-boards.greenhouse.io/voyantis/jobs/1', 'Voyantis', seen), undefined, 'never seen: could be made up');
    assert.equal(checkApplyUrl('https://www.linkedin.com/jobs/view/1/', 'Voyantis', new Set(['https://www.linkedin.com/jobs/view/1/'])), undefined);
    const withApply = checkReport(report({ apply_url: 'https://boards.greenhouse.io/acme/jobs/1/' }), fetched, { company: 'Acme', seen: new Set(fetched.keys()) });
    assert.equal(withApply.applyUrl, 'https://boards.greenhouse.io/acme/jobs/1/');
  });

  it('measures how much of a description is on the page, in any language', () => {
    assert.equal(overlap('מפתח מערכות בינה מלאכותית', 'דרוש מפתח מערכות בינה מלאכותית לצוות'), 1);
    assert.ok(overlap(description, page) > 0.95);
  });
});
