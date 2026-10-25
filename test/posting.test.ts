import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { checkApplyPage, checkLink, extractPosting, renderPage, sameTitle, textMentionsTitle } from '../src/llm/posting.ts';

const description =
  'You will build agentic workflows for our customers: design the integrations, write the orchestration code in TypeScript, and run them in production. Requirements: three years building integrations, REST APIs, and experience with LLM agents in production.';
const page = `Careers at Acme · Jobs · Life at Acme\nAI Integration Engineer\nTel Aviv · Hybrid\n${description}\nApply for this job\nFirst name\nLast name\nEmail`;

/** A Claude client that returns a fixed extraction. */
const client = (out: Record<string, unknown>) => ({
  messages: {
    parse: async () => ({
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200 },
      parsed_output: { is_job_posting: true, title: 'AI Integration Engineer', company: 'Acme', location: 'Tel Aviv', workplace_type: 'hybrid', date_posted: '', description, ...out },
    }),
  },
}) as never;

const job = { title: 'AI Integration Engineer', company: 'Acme' };

describe('reading a pasted application link', () => {
  it('refuses links that can\'t be read automatically', () => {
    assert.match(checkLink('https://www.linkedin.com/jobs/view/123/')!, /linkedin\.com can't be read automatically/);
    assert.match(checkLink('not a link')!, /not a valid link/);
    assert.equal(checkLink('https://job-boards.greenhouse.io/acme/jobs/1'), null);
  });

  it('matches job titles loosely, but not different jobs', () => {
    assert.ok(sameTitle('AI Integration Engineer', 'AI Integration Engineer (Hybrid)'));
    assert.ok(sameTitle('Senior AI Integration Engineer', 'AI Integration Engineer'));
    assert.ok(!sameTitle('Product Marketing Manager', 'AI Integration Engineer'));
  });

  it('accepts a description copied from the page, for this job', async () => {
    const r = await extractPosting(page, job, { client: client({}) });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.posting.workplaceType, 'hybrid');
  });

  it('rejects another job, an invented description, a closed job, and a non-posting', async () => {
    const other = await extractPosting(page, job, { client: client({ title: 'Office Manager' }) });
    assert.match(other.ok ? '' : other.reason, /is for "Office Manager"/);
    const invented = await extractPosting(page, job, { client: client({ description: 'Lead quantum blockchain research across continents with ten years of Solidity, Rust and Kubernetes leadership experience, managing distributed teams and owning budgets. Travel to client sites in three regions every quarter is expected.' }) });
    assert.match(invented.ok ? '' : invented.reason, /doesn't match the page/);
    const closed = await extractPosting(`${page}\nThis position has been filled.`, job, { client: client({}) });
    assert.equal(closed.ok ? false : closed.closed, true);
    const list = await extractPosting(page, job, { client: client({ is_job_posting: false }) });
    assert.match(list.ok ? '' : list.reason, /isn't a single job posting/);
  });

  it('knows when a page is about this job', () => {
    assert.ok(textMentionsTitle(page, 'AI Integration Engineer'));
    assert.ok(!textMentionsTitle(page, 'Product Marketing Manager'));
  });

  const BROWSER = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', process.env.TAILOR_TEST_BROWSER ?? ''].find((p) => p && existsSync(p));
  it('checks a pasted apply page: open, readable and about this job', { skip: !BROWSER && 'no Chrome available' }, async () => {
    const pages: Record<string, string> = {
      '/open': `<h1>AI Integration Engineer</h1><p>${description}</p><form><input name="email"><button>Submit application</button></form>`,
      '/closed': `<h1>AI Integration Engineer</h1><p>This position has been filled. ${description}</p>`,
      '/other': `<h1>Office Manager</h1><p>${description}</p>`,
    };
    const server = createServer((req, res) => (pages[req.url!] ? res.end(pages[req.url!]) : ((res.statusCode = 404), res.end())));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.deepEqual(await checkApplyPage(`${base}/open`, 'AI Integration Engineer', BROWSER), { ok: true, finalUrl: `${base}/open` });
      const closed = await checkApplyPage(`${base}/closed`, 'AI Integration Engineer', BROWSER);
      assert.equal(closed.ok ? false : closed.closed, true);
      const other = await checkApplyPage(`${base}/other`, 'AI Integration Engineer', BROWSER);
      assert.match(other.ok ? '' : other.reason, /doesn't mention "AI Integration Engineer"/);
      const gone = await checkApplyPage(`${base}/gone`, 'AI Integration Engineer', BROWSER);
      assert.equal(gone.ok ? false : gone.closed, true, 'a missing page counts as closed');
    } finally {
      server.close();
    }
  });

  it('reads text a page builds in the browser, like Comeet', { skip: !BROWSER && 'no Chrome available' }, async () => {
    const html = `<!doctype html><body><div id="app"></div><script>
      setTimeout(() => { document.getElementById('app').innerText = ${JSON.stringify(page)}; }, 300);</script></body>`;
    const server = createServer((_, res) => res.end(html));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { text } = await renderPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, BROWSER);
      assert.match(text, /experience with LLM agents in production/);
    } finally {
      server.close();
    }
  });
});
