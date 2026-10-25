import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { looksClosed } from '../pipeline/closed.ts';
import type { JobRow, WorkplaceType } from '../types.ts';
import { diceSimilarity, normalizeForMatch, normalizeTitle } from '../util/text.ts';
import { BLOCKED_DOMAINS, overlap } from './enrich.ts';

/*
 * The full posting behind a link you paste: a company's application page you reached yourself (from
 * LinkedIn's "Apply" button, a careers site...). The page is opened in Chrome, so pages that build
 * their text in the browser (Comeet, Ashby) work, and Claude copies the job description off it. The
 * copy is accepted only if it's really on the page and the page is about the same job.
 */

export interface PagePosting {
  title: string;
  company: string;
  location?: string;
  workplaceType?: WorkplaceType;
  postedAt?: string;
  description: string;
}

export type LinkResult =
  | { ok: true; posting: PagePosting; finalUrl: string; cost: number }
  | { ok: false; closed?: boolean; reason: string; cost: number };

const Extract = z.object({
  is_job_posting: z.boolean(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  workplace_type: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  date_posted: z.string(),
  description: z.string(),
});

const INSTRUCTIONS = `You get the text of a web page that should be one job posting. Copy the posting out of it:

- description: the posting's own text (what the role is, responsibilities, requirements, nice-to-haves), copied word for word in its language. Leave out navigation, the application form's field labels, cookie notices, benefits boilerplate and equal-opportunity statements. Under about 1,200 words.
- title, company, location as the page states them. workplace_type from what the page says.
- date_posted: YYYY-MM-DD only if the page states it, otherwise empty.
- is_job_posting: false if the page isn't a single job posting (a list of jobs, a login page, an error page). Then leave the rest empty.

Add nothing that isn't on the page.`;

/** Rejects links to sites whose terms forbid automated access, and anything that isn't a web page. */
export function checkLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'That is not a valid link';
  }
  if (!/^https?:$/.test(parsed.protocol)) return 'Paste a web link (https://…)';
  const host = parsed.hostname.toLowerCase();
  const blocked = BLOCKED_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
  if (blocked) return `${blocked} can't be read automatically: open the job there, click Apply, and paste the company page you land on`;
  return null;
}

/** The page's visible text, rendered in headless Chrome so script-built pages have their text. */
export async function renderPage(url: string, browserPath = ''): Promise<{ text: string; finalUrl: string }> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch(browserPath ? { executablePath: browserPath, headless: true } : { channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const gone = { text: 'This job is no longer available (page not found).', finalUrl: url };
    let res;
    try {
      res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (err) {
      // Chrome turns an empty error page (a bare 404) into a navigation error rather than a response.
      if (/ERR_HTTP_RESPONSE_CODE_FAILURE/.test((err as Error).message)) return gone;
      throw new Error(`could not open the page: ${(err as Error).message.split('\n')[0]}`);
    }
    if (res && (res.status() === 404 || res.status() === 410)) return { ...gone, finalUrl: page.url() };
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    let text = '';
    for (const frame of page.frames()) {
      text += '\n' + ((await frame.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string);
    }
    return { text: text.trim().slice(0, 60_000), finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

/** Whether a page's text is about this job: most of the title's words appear on it. */
export function textMentionsTitle(text: string, title: string): boolean {
  const words = normalizeForMatch(title).split(' ').filter((w) => w.length >= 3);
  if (!words.length) return true;
  const onPage = new Set(normalizeForMatch(text).split(' '));
  return words.filter((w) => onPage.has(w)).length / words.length >= 0.6;
}

/**
 * For an application that's already written: just check the pasted page is where to apply for this
 * job (open, about this job, readable). No model call: there's nothing to copy.
 */
export async function checkApplyPage(
  url: string,
  title: string,
  browserPath = '',
): Promise<{ ok: true; finalUrl: string } | { ok: false; closed?: boolean; reason: string }> {
  const bad = checkLink(url);
  if (bad) return { ok: false, reason: bad };
  const { text, finalUrl } = await renderPage(url, browserPath);
  const blocked = checkLink(finalUrl);
  if (blocked) return { ok: false, reason: blocked };
  if (looksClosed(text.slice(0, 20_000))) return { ok: false, closed: true, reason: 'the page says this job is no longer accepting applications' };
  if (text.length < 200) return { ok: false, reason: 'the page has almost no text (it may need a login)' };
  if (!textMentionsTitle(text, title)) return { ok: false, reason: `the page doesn't mention "${title}": check it's the right job` };
  return { ok: true, finalUrl };
}

/** Whether the page's job title is the card's job: near-identical, or one containing the other. */
export function sameTitle(a: string, b: string): boolean {
  const [x, y] = [normalizeTitle(a), normalizeTitle(b)];
  if (!x || !y) return false;
  return diceSimilarity(x, y) >= 0.6 || x.includes(y) || y.includes(x);
}

/** Claude copies the posting out of the page text; the copy is checked against the page and the job. */
export async function extractPosting(
  pageText: string,
  job: Pick<JobRow, 'title' | 'company'>,
  opts: { model?: string; client?: Pick<Anthropic, 'messages'> } = {},
): Promise<Exclude<LinkResult, { finalUrl: string }> | { ok: true; posting: PagePosting; cost: number }> {
  if (looksClosed(pageText.slice(0, 20_000))) return { ok: false, closed: true, reason: 'the page says this job is no longer accepting applications', cost: 0 };
  if (pageText.length < 200) return { ok: false, reason: 'the page has almost no text (it may need a login)', cost: 0 };
  const client = opts.client ?? new Anthropic({ maxRetries: 3, timeout: 120_000 });
  const message = await client.messages.parse({
    model: opts.model ?? 'claude-sonnet-5-5',
    max_tokens: 8000,
    system: INSTRUCTIONS,
    messages: [{ role: 'user', content: `<page>\n${pageText}\n</page>` }],
    output_config: { format: zodOutputFormat(Extract), effort: 'low' },
  });
  const u = message.usage;
  const cost = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0)) * 2 + (u.cache_read_input_tokens ?? 0) * 0.2 + u.output_tokens * 10) / 1e6;
  const x = message.parsed_output;
  if (message.stop_reason === 'refusal' || !x) return { ok: false, reason: 'the page could not be read', cost };
  if (!x.is_job_posting) return { ok: false, reason: "the page isn't a single job posting (a job list, a login or an error page?)", cost };
  if (!sameTitle(x.title, job.title)) return { ok: false, reason: `the page is for "${x.title}", not "${job.title}": check the link`, cost };
  const description = x.description.trim();
  if (description.length < 200) return { ok: false, reason: 'no job description found on the page', cost };
  const share = overlap(description, pageText);
  if (share < 0.85) return { ok: false, reason: `the copied description doesn't match the page (${Math.round(share * 100)}%)`, cost };
  const posted = /^\d{4}-\d{2}-\d{2}$/.test(x.date_posted.trim()) ? new Date(`${x.date_posted.trim()}T00:00:00Z`) : null;
  return {
    ok: true,
    cost,
    posting: {
      title: x.title.trim(),
      company: x.company.trim() || job.company,
      location: x.location.trim() || undefined,
      workplaceType: x.workplace_type,
      postedAt: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : undefined,
      description,
    },
  };
}

export async function postingFromLink(
  url: string,
  job: Pick<JobRow, 'title' | 'company'>,
  opts: { model?: string; browserPath?: string; client?: Pick<Anthropic, 'messages'> } = {},
): Promise<LinkResult> {
  const bad = checkLink(url);
  if (bad) return { ok: false, reason: bad, cost: 0 };
  const { text, finalUrl } = await renderPage(url, opts.browserPath);
  const blockedAfterRedirect = checkLink(finalUrl);
  if (blockedAfterRedirect) return { ok: false, reason: blockedAfterRedirect, cost: 0 };
  const result = await extractPosting(text, job, opts);
  return result.ok ? { ...result, finalUrl } : result;
}
