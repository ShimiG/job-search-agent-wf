import { z } from 'zod';
import type { BoardConfig } from '../config.ts';
import type { NormalizedJob } from '../types.ts';
import { mapWithConcurrency } from '../util/limiter.ts';
import { htmlToText } from '../util/text.ts';
import { detectWorkplaceType, formatError, joinLocations, toIso, type SourceAdapter } from './common.ts';
import type { Http } from './http.ts';

/*
 * Workday careers sites (<tenant>.wd<N>.myworkdayjobs.com/<site>) read their jobs from a public JSON
 * API, the same one the site's own search page calls: no login, read-only.
 *   POST /wday/cxs/<tenant>/<site>/jobs   {limit, offset, searchText, appliedFacets}  → a page of 20
 *   GET  /wday/cxs/<tenant>/<site><externalPath>                                    → one full posting
 * Big employers list thousands of jobs, each needing its own request for the description, so a board
 * can name search terms and a per-run cap. A capped run is reported as incomplete, so jobs it didn't
 * reach are never closed. Applying on Workday needs an account per company: the Submitter hands these
 * to you.
 */

type WorkdayBoard = Extract<BoardConfig, { ats: 'workday' }>;

/** Workday's page size; larger requests are rejected. */
export const WORKDAY_PAGE = 20;

const ListResponse = z.object({
  total: z.number().nullish(),
  jobPostings: z
    .array(
      z.object({
        title: z.string(),
        externalPath: z.string(),
        locationsText: z.string().nullish(),
        postedOn: z.string().nullish(),
        bulletFields: z.array(z.string()).nullish(),
      }),
    )
    .nullish(),
});
type Listing = NonNullable<z.infer<typeof ListResponse>['jobPostings']>[number];

const DetailResponse = z.object({
  jobPostingInfo: z.object({
    title: z.string(),
    jobDescription: z.string().nullish(),
    location: z.string().nullish(),
    additionalLocations: z.array(z.string()).nullish(),
    timeType: z.string().nullish(),
    startDate: z.string().nullish(),
    postedOn: z.string().nullish(),
    jobReqId: z.string().nullish(),
    externalUrl: z.string().nullish(),
    remoteType: z.string().nullish(),
  }),
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
});

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago" → a date. */
export function parsePostedOn(text: string | null | undefined, now: Date): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  const day = 86_400_000;
  if (/\btoday\b/.test(t)) return new Date(now).toISOString();
  if (/\byesterday\b/.test(t)) return new Date(now.getTime() - day).toISOString();
  const m = /(\d+)\+?\s*days?\s+ago/.exec(t);
  return m ? new Date(now.getTime() - Number(m[1]) * day).toISOString() : undefined;
}

/** "/job/Tel-Aviv/Integration-Engineer_JR1993" → "JR1993": the requisition ID, stable across retitles. */
export function workdayJobId(externalPath: string): string {
  return /_([A-Za-z0-9-]+)$/.exec(externalPath)?.[1] ?? externalPath.replace(/^\/+/, '');
}

export function workday(board: WorkdayBoard, clock: () => Date = () => new Date()): SourceAdapter {
  const prefix = `${board.tenant}/${board.site}`;
  const key = `workday:${prefix}`;
  const api = `https://${board.host}/wday/cxs/${encodeURIComponent(board.tenant)}/${encodeURIComponent(board.site)}`;
  let complete = true;

  async function list(http: Http, searchText: string, want: number): Promise<{ jobs: Listing[]; more: boolean }> {
    if (!http.postJson) throw new Error(`${key}: this HTTP client can't send POST requests`);
    const jobs: Listing[] = [];
    let total: number | null = null;
    for (let offset = 0; jobs.length < want; offset += WORKDAY_PAGE) {
      const raw = await http.postJson(`${api}/jobs`, { appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText });
      const parsed = ListResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      // Some tenants only send the total on the first page.
      if (offset === 0) total = parsed.data.total ?? null;
      const page = parsed.data.jobPostings ?? [];
      jobs.push(...page);
      const reachedEnd = page.length < WORKDAY_PAGE || (total !== null && offset + page.length >= total);
      if (reachedEnd) return { jobs: jobs.slice(0, want), more: jobs.length > want };
    }
    return { jobs: jobs.slice(0, want), more: true };
  }

  return {
    key,
    kind: 'workday',
    snapshotPrefix: `${prefix}:`,
    lastFetchComplete: () => complete,
    async fetchJobs(http: Http) {
      const now = clock();
      const byPath = new Map<string, Listing>();
      complete = true;
      for (const term of board.search.length ? board.search : ['']) {
        const room = board.maxJobs - byPath.size;
        if (room <= 0) {
          complete = false;
          break;
        }
        const { jobs, more } = await list(http, term, room);
        if (more) complete = false;
        for (const j of jobs) if (!byPath.has(j.externalPath)) byPath.set(j.externalPath, j);
      }

      let loaded = 0;
      let formatIssues: z.ZodIssue[] | null = null;
      const jobs = await mapWithConcurrency([...byPath.values()], 4, async (listing): Promise<NormalizedJob> => {
        const id = workdayJobId(listing.externalPath);
        const base = {
          source: 'workday' as const,
          externalId: `${prefix}:${id}`,
          company: board.company,
          url: `https://${board.host}/${board.site}${listing.externalPath}`,
        };
        let info: z.infer<typeof DetailResponse>['jobPostingInfo'] | undefined;
        let org = '';
        try {
          const parsed = DetailResponse.safeParse(await http.getJson(`${api}${listing.externalPath}`));
          if (parsed.success) {
            info = parsed.data.jobPostingInfo;
            org = parsed.data.hiringOrganization?.name ?? '';
            loaded++;
          } else formatIssues ??= parsed.error.issues;
        } catch {
          // One posting failing to load shouldn't drop the board: keep the summary.
        }
        if (!info) {
          const location = listing.locationsText ?? '';
          return {
            ...base,
            title: listing.title.trim(),
            location,
            workplaceType: detectWorkplaceType(null, location, listing.title),
            description: `${listing.title}\n${board.company}\n${location}`,
            descriptionIsPartial: true,
            postedAt: parsePostedOn(listing.postedOn, now),
          };
        }
        const location = joinLocations(info.location ?? listing.locationsText, ...(info.additionalLocations ?? []));
        const description = htmlToText(info.jobDescription);
        return {
          ...base,
          company: board.company || org || board.tenant,
          title: info.title.trim(),
          location,
          workplaceType: detectWorkplaceType(info.remoteType, location, info.title),
          url: info.externalUrl ?? base.url,
          description,
          descriptionIsPartial: description.length === 0,
          postedAt: toIso(info.startDate) ?? parsePostedOn(info.postedOn ?? listing.postedOn, now),
          employmentType: info.timeType ?? undefined,
        };
      });
      // Not one posting matched the expected format: the API changed, so say so instead of
      // quietly returning title-only jobs.
      if (jobs.length && loaded === 0 && formatIssues) throw formatError(`${key} (job details)`, formatIssues);
      return jobs;
    },
  };
}
