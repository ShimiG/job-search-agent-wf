import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import type { EmailFeed, ImapCredentials } from '../config.ts';
import type { NormalizedJob } from '../types.ts';
import type { Logger } from '../util/logger.ts';
import { tidyText } from '../util/text.ts';
import { detectWorkplaceType, type SourceAdapter } from './common.ts';

/*
 * Job alert emails (LinkedIn, Drushim, AllJobs...) are an approved way to get postings from
 * boards whose terms forbid scraping. They only carry a summary, so jobs from here are
 * marked descriptionIsPartial and get fuller data if the same job is found on an ATS board.
 *
 * The parser is deliberately generic: find links matching the feed's pattern, then read
 * title / company / location from the text around each link. Alert templates change, so if a
 * feed parses badly, adjust its linkPattern or tune extractCard() against a real email.
 */

export const DEFAULT_FEEDS: EmailFeed[] = [
  {
    // Saved-search alerts (jobalerts-noreply@) and "X is hiring" mails (jobs-noreply@) both carry
    // jobs. Gmail matches whole address parts, so "noreply@linkedin.com" would find neither.
    name: 'linkedin',
    from: 'linkedin.com',
    linkPattern: 'linkedin\\.com/(?:comm/)?jobs/view/(\\d+)',
    urlTemplate: 'https://www.linkedin.com/jobs/view/{id}/',
  },
  {
    // Links are cts.indeed.com tracking URLs; safeDecode unwraps them to …/rc/clk?jk=<job key>.
    name: 'indeed',
    from: 'indeed.com',
    linkPattern: 'indeed\\.com/(?:rc/clk|viewjob|pagead/clk)\\?(?:[^#]*&)?jk=([a-f0-9]{16})',
    urlTemplate: 'https://www.indeed.com/viewjob?jk={id}',
  },
  {
    name: 'drushim',
    from: 'drushim.co.il',
    linkPattern: 'drushim\\.co\\.il/job/(\\d+)',
    urlTemplate: 'https://www.drushim.co.il/job/{id}/',
  },
];

const NOISE_LINE =
  /^(view job|apply|easy apply|see (all|more) jobs|new|promoted|actively recruiting|fast growing|be an early applicant|\d+ (applicants?|connections?|school alumn?i?)|[$€£₪][\d.,]+k?(\s*[-–]\s*[$€£₪]?[\d.,]+k?)?(\s*\/\s*\w+)?|לצפייה במשרה|הגש מועמדות|למשרה)$/i;
const SEPARATOR = /\s+[·•|]\s+|\s+-\s+/;

export interface ParsedAlertJob {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
}

export function parseAlertEmail(html: string, feed: EmailFeed): ParsedAlertJob[] {
  const $ = cheerio.load(html);
  const pattern = new RegExp(feed.linkPattern, 'i');
  const byId = new Map<string, ParsedAlertJob>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const match = pattern.exec(safeDecode(href));
    const id = match?.[1];
    if (!id) return;
    const existing = byId.get(id);
    if (existing && existing.title) return;
    const url = feed.urlTemplate.replace('{id}', id);
    // LinkedIn makes the whole card one link: title, "Company · Location", then badges, on separate lines.
    const linkLines = blockLines($, $(el)).filter((l) => !NOISE_LINE.test(l));
    if (linkLines.length >= 2) {
      byId.set(id, { id, url, title: linkLines[0]!, ...companyAndLocation(linkLines.slice(1)) });
      return;
    }
    const linkText = cleanLine($(el).text());
    if (!linkText || NOISE_LINE.test(linkText)) {
      if (!existing) byId.set(id, { id, title: '', company: '', location: '', url });
      return;
    }
    const card = extractCard($, el, linkText, pattern);
    byId.set(id, { id, url, title: linkText, ...card });
  });

  return [...byId.values()].filter((j) => j.title);
}

/** Walk up from the title link to the largest ancestor that holds only this one job, then read its lines. */
function extractCard($: cheerio.CheerioAPI, link: Parameters<cheerio.CheerioAPI>[0], title: string, pattern: RegExp) {
  let container = $(link).parent();
  for (let depth = 0; depth < 8; depth++) {
    const parent = container.parent();
    if (!parent.length) break;
    const ids = new Set<string>();
    parent.find('a[href]').each((_, a) => {
      const m = pattern.exec(safeDecode($(a).attr('href') ?? ''));
      if (m?.[1]) ids.add(m[1]);
    });
    if (ids.size > 1) break;
    container = parent;
  }

  return companyAndLocation(blockLines($, container).filter((l) => l !== title && !NOISE_LINE.test(l)));
}

/** The first "Company · Location" line, or the first two plain lines. */
function companyAndLocation(lines: string[]): { company: string; location: string } {
  const dotted = lines.find((l) => l.includes(' · '));
  if (dotted) {
    const at = dotted.lastIndexOf(' · ');
    return { company: cleanLine(dotted.slice(0, at)), location: cleanLine(dotted.slice(at + 3)) };
  }
  let company = '';
  let location = '';
  for (const line of lines) {
    const parts = line.split(SEPARATOR).map(cleanLine).filter(Boolean);
    if (!company && parts.length >= 2) {
      company = parts[0]!;
      location = parts.slice(1).join(', ');
      break;
    }
    if (!company) company = line;
    else if (!location) {
      location = line;
      break;
    }
  }
  return { company, location };
}

/** Text of an element split on block-level boundaries. */
function blockLines($: cheerio.CheerioAPI, el: ReturnType<cheerio.CheerioAPI>): string[] {
  const clone = el.clone();
  clone.find('br').replaceWith('\n');
  clone.find('p, div, tr, td, li, h1, h2, h3, h4, table, span[style*="block"]').each((_, node) => {
    $(node).prepend('\n').append('\n');
  });
  return clone
    .text()
    .split('\n')
    .map(cleanLine)
    .filter((l) => l.length > 1);
}

function cleanLine(text: string): string {
  return text.replace(/[\s\u00a0\u200b-\u200f]+/g, ' ').trim();
}

function safeDecode(href: string): string {
  let url = href;
  try {
    url = decodeURIComponent(href);
  } catch {
    // keep it as it is
  }
  return unwrapTracking(url);
}

/**
 * Indeed wraps every link as cts.indeed.com/v3/<gzip, base64url JSON> whose "u" is the real URL
 * (…/rc/clk?jk=<job key>). Unwrapped, the job key is a stable ID like any other board's.
 */
function unwrapTracking(href: string): string {
  const m = /cts\.indeed\.com\/v3\/([A-Za-z0-9_-]+)/.exec(href);
  if (!m) return href;
  try {
    const target = JSON.parse(gunzipSync(Buffer.from(m[1]!, 'base64url')).toString('utf8')).u;
    return typeof target === 'string' ? target : href;
  } catch {
    return href;
  }
}

export function alertJobToNormalized(job: ParsedAlertJob, feed: EmailFeed, receivedAt?: Date): NormalizedJob {
  return {
    source: 'email',
    externalId: `${feed.name}:${job.id}`,
    company: job.company || 'Unknown company',
    title: job.title,
    location: job.location,
    workplaceType: detectWorkplaceType(null, job.location, job.title),
    url: job.url,
    description: tidyText(`${job.title}\n${job.company}\n${job.location}`),
    descriptionIsPartial: true,
    postedAt: receivedAt?.toISOString(),
  };
}

export interface EmailAlertOptions {
  credentials: ImapCredentials;
  mailbox: string;
  sinceDays: number;
  feeds: EmailFeed[];
  logger: Logger;
}

export function createEmailAlertAdapter(opts: EmailAlertOptions): SourceAdapter {
  return {
    key: 'email:alerts',
    kind: 'email',
    // No snapshotPrefix: alert emails are a feed, not a full listing, so absence means nothing.
    async fetchJobs() {
      const { ImapFlow } = await import('imapflow');
      const { simpleParser } = await import('mailparser');
      const client = new ImapFlow({
        host: opts.credentials.host,
        port: opts.credentials.port,
        secure: true,
        auth: { user: opts.credentials.user, pass: opts.credentials.password },
        logger: false,
      });
      const since = new Date(Date.now() - opts.sinceDays * 86_400_000);
      const jobs: NormalizedJob[] = [];
      await client.connect();
      try {
        const lock = await client.getMailboxLock(opts.mailbox, { readOnly: true });
        try {
          for (const feed of opts.feeds) {
            const uids = await client.search({ since, from: feed.from }, { uid: true });
            if (!uids || uids.length === 0) continue;
            let count = 0;
            for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
              if (!msg.source) continue;
              const mail = await simpleParser(msg.source);
              const html = typeof mail.html === 'string' ? mail.html : '';
              if (!html) continue;
              for (const parsed of parseAlertEmail(html, feed)) {
                jobs.push(alertJobToNormalized(parsed, feed, mail.date ?? undefined));
                count++;
              }
            }
            opts.logger.debug(`email feed ${feed.name}: ${uids.length} emails, ${count} job links`);
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => undefined);
      }
      return jobs;
    },
  };
}
