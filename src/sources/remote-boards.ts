import { z } from 'zod';
import type { BoardConfig } from '../config.ts';
import type { NormalizedJob } from '../types.ts';
import { htmlToText } from '../util/text.ts';
import { formatError, toIso, type SourceAdapter } from './common.ts';
import type { Http } from './http.ts';

/*
 * Public remote-job boards that publish their listings through a documented, free API for others
 * to reuse. Unlike a company's board, each lists jobs from many employers, and everything on them is
 * remote: a job's "location" is where the candidate may live ("Worldwide", "Europe", "USA Only"), which
 * Scout's location rules (locations.remoteExclude) filter on.
 *
 * Both boards set conditions, and the adapters keep to them:
 *  - Remotive (github.com/remotive-com/remote-jobs-api): link back to the Remotive URL and name
 *    Remotive as the source; at most 4 fetches a day; never more than 2 requests a minute.
 *  - Jobicy (github.com/Jobicy/remote-jobs-api): keep Jobicy as the source and its canonical URL;
 *    no new synchronization pass more often than once an hour.
 * Every job keeps the board's own URL and is shown with the board's name, and each adapter says how
 * long to wait between fetches, which the run honours.
 */

type RemotiveBoard = Extract<BoardConfig, { ats: 'remotive' }>;
type JobicyBoard = Extract<BoardConfig, { ats: 'jobicy' }>;

const text = z.string().nullish();

// ---------------------------------------------------------------- Remotive
// GET https://remotive.com/api/remote-jobs[?category=<slug>][&search=<words>]  → every active job

const RemotiveResponse = z.object({
  jobs: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      url: z.string(),
      title: z.string(),
      company_name: z.string(),
      category: text,
      job_type: text,
      publication_date: text,
      candidate_required_location: text,
      description: text,
    }),
  ),
});

export function remotive(board: RemotiveBoard): SourceAdapter {
  const key = 'remotive';
  return {
    key,
    kind: 'remotive',
    // The answer is every active job (for this category and search), so one that's gone has closed.
    snapshotPrefix: 'remotive:',
    // "We advise max. 4 times a day."
    minHoursBetweenFetches: 6,
    async fetchJobs(http: Http) {
      // One request per run: more than two a minute are blocked.
      const params = new URLSearchParams();
      if (board.category) params.set('category', board.category);
      if (board.search) params.set('search', board.search);
      const raw = await http.getJson(`https://remotive.com/api/remote-jobs${params.size ? `?${params}` : ''}`);
      const parsed = RemotiveResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      return parsed.data.jobs.map((j): NormalizedJob => ({
        source: 'remotive',
        externalId: `remotive:${j.id}`,
        company: j.company_name.trim() || 'Unknown company',
        title: j.title.trim(),
        location: j.candidate_required_location?.trim() || 'Worldwide',
        workplaceType: 'remote',
        url: j.url,
        description: htmlToText(j.description),
        descriptionIsPartial: !j.description?.trim(),
        postedAt: toIso(j.publication_date),
        employmentType: j.job_type?.replace(/_/g, ' ') || undefined,
        department: j.category ?? undefined,
      }));
    },
  };
}

// ---------------------------------------------------------------- Jobicy
// GET https://jobicy.com/api/jobs?count=200[&geo=][&industry=][&tag=][&cursor=]  → the last 7 days, paged

const JobicyResponse = z.object({
  success: z.boolean().nullish(),
  error: text,
  jobs: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]),
        url: z.string(),
        jobTitle: z.string(),
        companyName: z.string(),
        jobIndustry: z.array(z.string()).nullish(),
        jobType: z.array(z.string()).nullish(),
        jobGeo: text,
        jobDescription: text,
        jobExcerpt: text,
        pubDate: text,
      }),
    )
    .nullish(),
  nextCursor: text,
});

export const JOBICY_PAGE = 200;

export function jobicy(board: JobicyBoard): SourceAdapter {
  const key = 'jobicy';
  return {
    key,
    kind: 'jobicy',
    // No snapshotPrefix: the feed only goes back 7 days, and a job leaving it may still be open.
    // "Do not start new automated … synchronization passes more frequently than once per hour."
    minHoursBetweenFetches: 1,
    async fetchJobs(http: Http) {
      const byId = new Map<string, NormalizedJob>();
      // One pass per region; with none, one pass over everything.
      for (const geo of board.geo.length ? board.geo : ['']) {
        let cursor: string | null = null;
        do {
          const params = new URLSearchParams({ count: String(JOBICY_PAGE) });
          if (geo) params.set('geo', geo);
          if (board.industry) params.set('industry', board.industry);
          if (board.tag) params.set('tag', board.tag);
          if (cursor) params.set('cursor', cursor);
          const parsed = JobicyResponse.safeParse(await http.getJson(`https://jobicy.com/api/jobs?${params}`));
          if (!parsed.success) throw formatError(key, parsed.error.issues);
          if (parsed.data.success === false) throw new Error(`${key}: ${parsed.data.error ?? 'the request was refused'}`);
          for (const j of parsed.data.jobs ?? []) {
            const description = htmlToText(j.jobDescription) || (j.jobExcerpt ?? '').trim();
            byId.set(String(j.id), {
              source: 'jobicy',
              externalId: `jobicy:${j.id}`,
              company: j.companyName.trim() || 'Unknown company',
              title: j.jobTitle.trim(),
              location: j.jobGeo?.trim() || 'Anywhere',
              workplaceType: 'remote',
              url: j.url,
              description,
              descriptionIsPartial: !j.jobDescription?.trim(),
              postedAt: toIso(j.pubDate),
              employmentType: j.jobType?.join(', ') || undefined,
              department: j.jobIndustry?.join(', ') || undefined,
            });
          }
          cursor = parsed.data.nextCursor || null;
        } while (cursor && byId.size < board.maxJobs);
        if (byId.size >= board.maxJobs) break;
      }
      return [...byId.values()].slice(0, board.maxJobs);
    },
  };
}
