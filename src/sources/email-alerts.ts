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
  {
  // AllJobs "smart agent" (סוכן חכם) mails, in Hebrew. Job pages are …/Search/UploadSingle.aspx?JobID=<id>;
  // safeDecode unwraps redirect links that carry that URL encoded in a parameter.
    name: 'alljobs',
    from: 'alljobs.co.il',
    linkPattern: 'alljobs\\.co\\.il/[^\\s"\'<>]*?[?&]jobid=(\\d+)',
    urlTemplate: 'https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID={id}',
  },
];

const NOISE_ALTERNATIVES = [
  String.raw`view job|apply|easy apply|see (all|more) jobs|new|promoted|actively recruiting|fast growing|be an early applicant`,
  String.raw`\d+ (applicants?|connections?|school alumn?i?)`,
  String.raw`[$€£₪][\d.,]+k?(\s*[-–]\s*[$€£₪]?[\d.,]+k?)?(\s*\/\s*\w+)?`,
  String.raw`full[- ]time|part[- ]time`,
  // Hebrew buttons and badges (Drushim, AllJobs): "view the job", "send CV", "details", "hot job", "new"...
  String.raw`(ל)?צפי(י)?ה במשרה|צפה במשרה|הגש(\/י)? מועמדות|(ל)?הגשת מועמדות|למשרה( המלאה)?|לפרטים( נוספים)?( ושליחת קו["״]ח)?`,
  String.raw`(שלח|שלחו|שליחת)(\/י)? (קו["״]ח|קורות חיים)|משרה חמה|משרה דחופה|דחוף|חדש(ה)?|הסר(\/י)? מרשימת התפוצה`,
  // Job type and posting age, which aren't a location: "משרה מלאה", "סוג משרה: …", "פורסם לפני 3 ימים".
  String.raw`משרה (מלאה|חלקית)(\s*[,/]\s*משרה (מלאה|חלקית))*|משמרות|(סוג|היקף) (ה)?משרה\s*:.*|פורסמה?( לפני| ב|:).*|לפני \d+ (ימים|שעות|דקות)|היום|אתמול`,
];
const NOISE_LINE = new RegExp(`^(?:${NOISE_ALTERNATIVES.map((alt) => `(?:${alt})`).join('|')})$`, 'i');
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

const COMPANY_LABEL = /^(?:company|employer|חברה|החברה|שם החברה|מעסיק|שם המעסיק)\s*[:：]\s*(.*)$/i;
const LOCATION_LABEL = /^(?:location|city|region|מיקום(?: המשרה)?|אזור(?: המשרה)?|עיר|מקום (?:ה)?עבודה)\s*[:：]\s*(.*)$/i;

/** A labelled field ("חברה: Acme"), or a label on its own line with the value on the next one. */
function labelled(lines: string[], label: RegExp): string {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]!);
    if (m) return cleanLine(m[1]!) || lines[i + 1] || '';
  }
  return '';
}

/** Labelled fields, else the first "Company · Location" line, else the first two plain lines. */
function companyAndLocation(lines: string[]): { company: string; location: string } {
  const labelledCompany = labelled(lines, COMPANY_LABEL);
  const labelledLocation = labelled(lines, LOCATION_LABEL);
  if (labelledCompany || labelledLocation) {
    const rest = lines.filter((l) => !COMPANY_LABEL.test(l) && !LOCATION_LABEL.test(l) && l !== labelledCompany && l !== labelledLocation);
    return { company: labelledCompany || rest[0] || '', location: labelledLocation || (labelledCompany ? rest[0] : rest[1]) || '' };
  }
  const dotted = lines.find((l) => l.includes(' · '));
  if (dotted) {
    const at = dotted.lastIndexOf(' · ');
    return { company: cleanLine(dotted.slice(0, at)), location: cleanLine(dotted.slice(at + 3)) };
  }
  let company = '';
  let location = '';
  for (const line of lines) {
    const parts = line.split(SEPARATOR).map(cleanLine).filter((p) => p && !NOISE_LINE.test(p));
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
  // Hebrew mails are full of direction marks and embeddings (U+200E/F, U+202A–E, U+2066–9).
  return text.replace(/[\s\u00a0\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
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
      // A dropped connection also rejects the pending call (this source then fails on its own);
      // without a listener the 'error' event would kill the whole run.
      client.on('error', (err: Error) => opts.logger.debug(`email alerts IMAP: ${err.message}`));
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
