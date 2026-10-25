import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { looksClosed } from '../pipeline/closed.ts';
import { normalizeCompany } from '../util/text.ts';
import type { JobRow, WorkplaceType } from '../types.ts';

/*
 * Job alert emails carry only a title, company and location. For the ones that make your shortlist,
 * Claude looks for the same job on the company's own careers page and copies the full posting, which
 * then replaces the summary and gets scored properly.
 *
 * LinkedIn, Indeed and other sites whose terms forbid automated access are blocked from search and
 * fetch. The basic search/fetch tool versions are used on purpose: they return the page text, so the
 * reported description can be checked against what was actually fetched.
 */

export interface FullPosting {
  /** Where the description came from: the company's page or a site copying it. */
  url: string;
  description: string;
  location?: string;
  workplaceType?: WorkplaceType;
  /** ISO date, when the page states when it was posted. */
  postedAt?: string;
}

export interface EnrichUsage {
  /** Input billed at full price, read from cache (0.1×) and written to cache (1.25×). */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  searches: number;
  fetches: number;
}

export interface Enricher {
  find(job: Pick<JobRow, 'title' | 'company' | 'location' | 'url'>): Promise<LookupResult>;
}

export interface LookupResult {
  posting: FullPosting | null;
  /** The company's own page for applying (its ATS or careers site), when one was seen. */
  applyUrl?: string;
  closed?: boolean;
  reason: string;
  usage: EnrichUsage;
}

/** Applicant tracking systems: their job pages carry the application form. */
const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'comeet.com', 'comeet.co', 'smartrecruiters.com',
  'bamboohr.com', 'teamtailor.com', 'recruitee.com', 'breezy.hr', 'jobvite.com', 'personio.de', 'personio.com',
  'pinpointhq.com', 'jazzhr.com', 'applytojob.com', 'rippling-ats.com', 'myworkdayjobs.com', 'hibob.com',
];

export const BLOCKED_DOMAINS = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'];

const INSTRUCTIONS = `You find the full text of one job posting on the web. The candidate saw it in a job alert that only gave the title, company and location.

1. Search for this job on the company's own careers page or its applicant tracking system (Greenhouse, Lever, Ashby, Workable, Comeet, SmartRecruiters, BambooHR, Teamtailor, Workday and similar). Use another job site only if the company's own page can't be found.
   Look for the company's own application page too (its careers site or ATS job page, with the apply form): that's where the candidate will apply, so report it as apply_url even when the description came from elsewhere.
2. Fetch the page with web_fetch. This is required: a page you only saw in search results can't be reported, because the text is checked against what you fetched. Check it is the same job: the same company, the same or a near-identical title, and a compatible location. A different role at the same company does not count.
3. Call report_posting once.

If you found it, "description" is the posting's own text copied from the page you fetched: what the role is, responsibilities, requirements and nice-to-haves, in the page's own words and language. Do not summarize or rephrase, and add nothing that isn't on the page. Leave out navigation, cookie notices, benefits boilerplate and equal-opportunity statements. Keep it under about 1,200 words. "url" is the address of the page you fetched. "date_posted" is when the page says the job was posted, or empty if it doesn't say; never guess it.

If a page about this exact job says it's closed, expired, filled or no longer accepting applications, report job_status "closed" with that page's url. Otherwise "open" when you found it, "unknown" when you didn't.

If you can't find it with confidence, report found: false. A wrong posting is worse than none.`;

const REPORT_TOOL = {
  name: 'report_posting',
  description: 'Report the job posting you found, or that you could not find it. Call exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['found', 'job_status', 'url', 'description', 'location', 'workplace_type', 'date_posted', 'apply_url', 'note'],
    properties: {
      found: { type: 'boolean', description: 'True only if the fetched page is this exact job.' },
      job_status: {
        type: 'string',
        enum: ['open', 'closed', 'unknown'],
        description: 'closed if a fetched page about this exact job says it is closed, expired, filled or no longer accepting applications. Then url is that page.',
      },
      url: { type: 'string', description: 'The fetched page with the posting. Empty when not found.' },
      description: { type: 'string', description: "The posting's text copied from that page. Empty when not found." },
      location: { type: 'string', description: 'Location as the page states it, or empty.' },
      workplace_type: { type: 'string', enum: ['remote', 'hybrid', 'onsite', 'unknown'] },
      date_posted: { type: 'string', description: 'YYYY-MM-DD if the page states when the job was posted, otherwise empty.' },
      apply_url: {
        type: 'string',
        description:
          "The company's own page where you apply for this job: its careers site or applicant tracking system (Greenhouse, Lever, Ashby, Comeet, Workable, SmartRecruiters and similar). Never a site that copies postings. Empty if you didn't see one.",
      },
      note: { type: 'string', description: 'One short sentence: where you found it, or why not.' },
    },
  },
};

const ReportSchema = z.object({
  found: z.boolean(),
  job_status: z.enum(['open', 'closed', 'unknown']),
  url: z.string(),
  description: z.string(),
  location: z.string(),
  workplace_type: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  date_posted: z.string(),
  apply_url: z.string(),
  note: z.string(),
});

const normUrl = (u: string) => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const words = (text: string) => text.toLowerCase().match(/\p{L}{4,}/gu) ?? [];

/** Share of the description's words that appear on the fetched page. Copied text scores near 1. */
export function overlap(description: string, page: string): number {
  const onPage = new Set(words(page));
  const used = words(description);
  if (used.length === 0) return 0;
  return used.filter((w) => onPage.has(w)).length / used.length;
}

/**
 * Accepts a report only if it names a page that was really fetched, and its description is that
 * page's text rather than something written from memory.
 */
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const onHost = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * An apply page is accepted only if Claude actually saw it (fetched, or in search results), and it's an
 * ATS or the company's own site. A site copying the posting has no form you can apply with.
 */
export function checkApplyUrl(url: string, company: string, seen: Set<string>): string | undefined {
  const host = hostOf(url);
  if (!host || onHost(host, BLOCKED_DOMAINS)) return undefined;
  if (![...seen].some((u) => normUrl(u) === normUrl(url))) return undefined;
  const companyWords = normalizeCompany(company).split(' ').filter((w) => w.length >= 3);
  const companySite = companyWords.some((w) => host.replace(/[^a-z0-9]/g, '').includes(w.replace(/[^a-z0-9]/g, '')));
  return onHost(host, ATS_HOSTS) || companySite ? url : undefined;
}

export function checkReport(
  report: z.infer<typeof ReportSchema>,
  fetched: Map<string, string>,
  context: { company: string; seen: Set<string> } = { company: '', seen: new Set(fetched.keys()) },
): Omit<LookupResult, 'usage'> {
  const applyUrl = report.apply_url.trim() ? checkApplyUrl(report.apply_url.trim(), context.company, context.seen) : undefined;
  if (report.job_status === 'closed') {
    // Believed only when the closing wording is on a page that was actually fetched.
    const page = [...fetched].find(([url]) => normUrl(url) === normUrl(report.url))?.[1];
    if (page !== undefined && looksClosed(page)) return { posting: null, closed: true, reason: `no longer accepting applications (${report.url})` };
  }
  if (!report.found) return { posting: null, applyUrl, reason: report.note || 'not found' };
  const host = hostOf(report.url);
  if (!host) return { posting: null, applyUrl, reason: `not a valid URL: ${report.url}` };
  if (onHost(host, BLOCKED_DOMAINS)) return { posting: null, applyUrl, reason: `${host} is not allowed` };
  const page = [...fetched].find(([url]) => normUrl(url) === normUrl(report.url))?.[1];
  if (page === undefined) return { posting: null, applyUrl, reason: `reported a page it did not fetch: ${report.url}` };
  const description = report.description.trim();
  if (description.length < 200) return { posting: null, applyUrl, reason: 'the description is too short to be a full posting' };
  const share = overlap(description, page);
  if (share < 0.85) {
    return { posting: null, applyUrl, reason: `the description doesn't match the fetched page (${Math.round(share * 100)}% of its words are there)` };
  }
  const posted = /^\d{4}-\d{2}-\d{2}$/.test(report.date_posted.trim()) ? new Date(`${report.date_posted.trim()}T00:00:00Z`) : null;
  return {
    posting: {
      url: report.url,
      description,
      location: report.location.trim() || undefined,
      workplaceType: report.workplace_type,
      postedAt: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : undefined,
    },
    applyUrl,
    reason: report.note,
  };
}

/** Dollars, at Sonnet 5.5 rates: $2 / $10 per million tokens, $10 per thousand searches. */
export function enrichCost(u: EnrichUsage): number {
  return (u.inputTokens * 2 + u.cacheReadTokens * 0.2 + u.cacheWriteTokens * 2.5 + u.outputTokens * 10) / 1e6 + u.searches * 0.01;
}

export class AnthropicEnricher implements Enricher {
  private readonly client: Pick<Anthropic, 'beta'>;
  readonly model: string;

  constructor(opts: { model?: string; apiKey?: string; client?: Pick<Anthropic, 'beta'> } = {}) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 180_000 });
    this.model = opts.model ?? 'claude-sonnet-5-5';
  }

  async find(job: Pick<JobRow, 'title' | 'company' | 'location' | 'url'>) {
    const usage: EnrichUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, searches: 0, fetches: 0 };
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'user',
        content: `Title: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location || 'not stated'}\nSeen at: ${job.url} (for reference only; that site can't be fetched)`,
      },
    ];
    const fetched = new Map<string, string>();
    const searched = new Set<string>();

    // Searches and fetches run server-side; a long turn pauses and is resumed by sending it back.
    for (let turn = 0; turn < 4; turn++) {
      const message = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        // Each search step re-reads everything before it; caching makes those re-reads ~10x cheaper.
        cache_control: { type: 'ephemeral' },
        system: INSTRUCTIONS,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 3, blocked_domains: BLOCKED_DOMAINS },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, blocked_domains: BLOCKED_DOMAINS, max_content_tokens: 8000 },
          REPORT_TOOL,
        ],
        messages,
      });
      usage.inputTokens += message.usage.input_tokens;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      usage.outputTokens += message.usage.output_tokens;
      usage.searches += message.usage.server_tool_use?.web_search_requests ?? 0;
      usage.fetches += message.usage.server_tool_use?.web_fetch_requests ?? 0;

      for (const block of message.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === 'web_search_result') searched.add(r.url);
        }
        if (block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result') {
          const source = block.content.content.source;
          if (source.type === 'text') fetched.set(block.content.url, source.data);
        }
      }
      if (message.stop_reason === 'refusal') return { posting: null, reason: 'the model declined', usage };
      const report = message.content.find((b) => b.type === 'tool_use' && b.name === 'report_posting');
      if (report && report.type === 'tool_use') {
        const parsed = ReportSchema.safeParse(report.input);
        if (!parsed.success) return { posting: null, reason: 'malformed report', usage };
        return { ...checkReport(parsed.data, fetched, { company: job.company, seen: new Set([...fetched.keys(), ...searched]) }), usage };
      }
      if (message.stop_reason !== 'pause_turn') return { posting: null, reason: `stopped without a report (${message.stop_reason})`, usage };
      messages.push({ role: 'assistant', content: message.content });
    }
    return { posting: null, reason: 'gave up after too many search rounds', usage };
  }
}
