import { z } from 'zod';
import type { BoardConfig } from '../config.ts';
import type { NormalizedJob } from '../types.ts';
import { mapWithConcurrency } from '../util/limiter.ts';
import { htmlToText, tidyText } from '../util/text.ts';
import { detectWorkplaceType, formatError, toIso, type SourceAdapter } from './common.ts';
import type { Http } from './http.ts';

/*
 * SmartRecruiters' public Posting API (no login, read-only):
 *   GET https://api.smartrecruiters.com/v1/companies/<id>/postings?limit=100&offset=0[&q=…]  → summaries
 *   GET https://api.smartrecruiters.com/v1/companies/<id>/postings/<postingId>              → full ad
 * The list has no descriptions, so each posting is one more request: like Workday, a board can set
 * search terms and a per-run cap, and a capped run never closes jobs it didn't reach.
 */

type SmartBoard = Extract<BoardConfig, { ats: 'smartrecruiters' }>;

export const SMART_PAGE = 100;

const Location = z
  .object({
    city: z.string().nullish(),
    region: z.string().nullish(),
    country: z.string().nullish(),
    fullLocation: z.string().nullish(),
    remote: z.boolean().nullish(),
    hybrid: z.boolean().nullish(),
  })
  .nullish();
const Label = z.object({ label: z.string().nullish() }).nullish();

const ListResponse = z.object({
  totalFound: z.number().nullish(),
  content: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string(),
      releasedDate: z.string().nullish(),
      location: Location,
      typeOfEmployment: Label,
      department: Label,
      company: z.object({ name: z.string().nullish() }).nullish(),
    }),
  ),
});
type Summary = z.infer<typeof ListResponse>['content'][number];

const Section = z.object({ title: z.string().nullish(), text: z.string().nullish() }).nullish();
const DetailResponse = z.object({
  name: z.string().nullish(),
  postingUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  releasedDate: z.string().nullish(),
  location: Location,
  jobAd: z
    .object({
      sections: z
        .object({
          companyDescription: Section,
          jobDescription: Section,
          qualifications: Section,
          additionalInformation: Section,
        })
        .nullish(),
    })
    .nullish(),
});

const COUNTRIES: Record<string, string> = { il: 'Israel', us: 'United States', gb: 'United Kingdom', de: 'Germany' };

function place(loc: z.infer<typeof Location>): string {
  if (!loc) return '';
  const country = loc.country ? (COUNTRIES[loc.country.toLowerCase()] ?? loc.country.toUpperCase()) : '';
  // City, region and country are parts of one place, not several locations.
  return loc.fullLocation?.trim() || [loc.city, loc.region, country].filter((p) => p?.trim()).join(', ');
}

const workplace = (loc: z.infer<typeof Location>) => (loc?.remote ? 'remote' : loc?.hybrid ? 'hybrid' : null);

export function smartRecruiters(board: SmartBoard): SourceAdapter {
  const key = `smartrecruiters:${board.token}`;
  const api = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.token)}/postings`;
  let complete = true;

  async function list(http: Http, q: string, want: number): Promise<{ jobs: Summary[]; more: boolean }> {
    const jobs: Summary[] = [];
    for (let offset = 0; jobs.length < want; offset += SMART_PAGE) {
      const raw = await http.getJson(`${api}?limit=${SMART_PAGE}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      const parsed = ListResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      const page = parsed.data.content;
      jobs.push(...page);
      const total = parsed.data.totalFound;
      if (page.length < SMART_PAGE || (total != null && offset + page.length >= total)) return { jobs: jobs.slice(0, want), more: jobs.length > want };
    }
    return { jobs: jobs.slice(0, want), more: true };
  }

  return {
    key,
    kind: 'smartrecruiters',
    snapshotPrefix: `${board.token}:`,
    lastFetchComplete: () => complete,
    async fetchJobs(http: Http) {
      const byId = new Map<string, Summary>();
      complete = true;
      for (const term of board.search.length ? board.search : ['']) {
        const room = board.maxJobs - byId.size;
        if (room <= 0) {
          complete = false;
          break;
        }
        const { jobs, more } = await list(http, term, room);
        if (more) complete = false;
        for (const j of jobs) if (!byId.has(j.id)) byId.set(j.id, j);
      }

      let loaded = 0;
      let formatIssues: z.ZodIssue[] | null = null;
      const jobs = await mapWithConcurrency([...byId.values()], 4, async (s): Promise<NormalizedJob> => {
        let detail: z.infer<typeof DetailResponse> | undefined;
        try {
          const parsed = DetailResponse.safeParse(await http.getJson(`${api}/${encodeURIComponent(s.id)}`));
          if (parsed.success) {
            detail = parsed.data;
            loaded++;
          } else formatIssues ??= parsed.error.issues;
        } catch {
          // Keep the summary when one posting fails to load.
        }
        const loc = detail?.location ?? s.location;
        const location = place(loc);
        const title = (detail?.name ?? s.name).trim();
        const sections = detail?.jobAd?.sections;
        const description = tidyText(
          [sections?.jobDescription, sections?.qualifications, sections?.additionalInformation, sections?.companyDescription]
            .filter((x) => x?.text)
            .map((x) => `${x!.title ?? ''}\n${htmlToText(x!.text)}`.trim())
            .join('\n\n'),
        );
        return {
          source: 'smartrecruiters',
          externalId: `${board.token}:${s.id}`,
          company: board.company || s.company?.name || board.token,
          title,
          location,
          workplaceType: detectWorkplaceType(workplace(loc), location, title),
          url: detail?.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(board.token)}/${encodeURIComponent(s.id)}`,
          ...(detail?.applyUrl ? { applyUrl: detail.applyUrl } : {}),
          description: description || `${title}\n${board.company}\n${location}`,
          descriptionIsPartial: description.length === 0,
          postedAt: toIso(detail?.releasedDate ?? s.releasedDate),
          employmentType: s.typeOfEmployment?.label ?? undefined,
          department: s.department?.label ?? undefined,
        };
      });
      if (jobs.length && loaded === 0 && formatIssues) throw formatError(`${key} (job details)`, formatIssues);
      return jobs;
    },
  };
}
