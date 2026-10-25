import { z } from 'zod';
import type { BoardConfig } from '../config.ts';
import type { NormalizedJob } from '../types.ts';
import { htmlToText, tidyText } from '../util/text.ts';
import { detectWorkplaceType, formatError, joinLocations, toIso, type SourceAdapter } from './common.ts';
import type { Http } from './http.ts';

/*
 * Each adapter reads a public, unauthenticated job board endpoint and validates the
 * response with a lenient schema: fields we need are checked, everything else is ignored,
 * and anything optional is .nullish() because ATS vendors omit fields freely.
 */

const enc = encodeURIComponent;

// ---------------------------------------------------------------- Greenhouse
// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true

const GreenhouseResponse = z.object({
  jobs: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      title: z.string(),
      absolute_url: z.string(),
      location: z.object({ name: z.string().nullish() }).nullish(),
      content: z.string().nullish(),
      updated_at: z.string().nullish(),
      first_published: z.string().nullish(),
      company_name: z.string().nullish(),
      departments: z.array(z.object({ name: z.string() })).nullish(),
      offices: z.array(z.object({ name: z.string().nullish(), location: z.string().nullish() })).nullish(),
    }),
  ),
});

function greenhouse(board: Extract<BoardConfig, { ats: 'greenhouse' }>): SourceAdapter {
  const key = `greenhouse:${board.token}`;
  return {
    key,
    kind: 'greenhouse',
    snapshotPrefix: `${board.token}:`,
    async fetchJobs(http: Http) {
      const raw = await http.getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(board.token)}/jobs?content=true`);
      const parsed = GreenhouseResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      return parsed.data.jobs.map((j): NormalizedJob => {
        const location = joinLocations(j.location?.name, ...(j.offices ?? []).map((o) => o.location ?? o.name));
        return {
          source: 'greenhouse',
          externalId: `${board.token}:${j.id}`,
          company: board.company || j.company_name || board.token,
          title: j.title.trim(),
          location,
          workplaceType: detectWorkplaceType(null, location, j.title),
          url: j.absolute_url,
          description: htmlToText(j.content),
          descriptionIsPartial: false,
          postedAt: toIso(j.first_published ?? j.updated_at),
          department: j.departments?.map((d) => d.name).join(', ') || undefined,
        };
      });
    },
  };
}

// ---------------------------------------------------------------- Lever
// GET https://api.lever.co/v0/postings/{site}?mode=json   (EU: api.eu.lever.co)

const LeverResponse = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    applyUrl: z.string().nullish(),
    createdAt: z.number().nullish(),
    workplaceType: z.string().nullish(),
    country: z.string().nullish(),
    categories: z
      .object({
        location: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
        commitment: z.string().nullish(),
        team: z.string().nullish(),
        department: z.string().nullish(),
      })
      .nullish(),
    description: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
    lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
    additional: z.string().nullish(),
    additionalPlain: z.string().nullish(),
  }),
);

function lever(board: Extract<BoardConfig, { ats: 'lever' }>): SourceAdapter {
  const key = `lever:${board.token}`;
  const host = board.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  return {
    key,
    kind: 'lever',
    snapshotPrefix: `${board.token}:`,
    async fetchJobs(http: Http) {
      const raw = await http.getJson(`https://${host}/v0/postings/${enc(board.token)}?mode=json`);
      const parsed = LeverResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      return parsed.data.map((j): NormalizedJob => {
        const c = j.categories ?? {};
        const location = joinLocations(c.location, ...(c.allLocations ?? []));
        const sections = [
          j.descriptionPlain ?? htmlToText(j.description),
          ...(j.lists ?? []).map((l) => `${l.text ?? ''}\n${htmlToText(l.content)}`),
          j.additionalPlain ?? htmlToText(j.additional),
        ];
        return {
          source: 'lever',
          externalId: `${board.token}:${j.id}`,
          company: board.company,
          title: j.text.trim(),
          location,
          workplaceType: detectWorkplaceType(j.workplaceType, location, j.text),
          url: j.hostedUrl,
          applyUrl: j.applyUrl ?? undefined,
          description: tidyText(sections.filter(Boolean).join('\n\n')),
          descriptionIsPartial: false,
          postedAt: toIso(j.createdAt),
          employmentType: c.commitment ?? undefined,
          department: c.department ?? c.team ?? undefined,
        };
      });
    },
  };
}

// ---------------------------------------------------------------- Ashby
// GET https://api.ashbyhq.com/posting-api/job-board/{board}

const AshbyResponse = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      jobUrl: z.string(),
      applyUrl: z.string().nullish(),
      location: z.string().nullish(),
      secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
      department: z.string().nullish(),
      team: z.string().nullish(),
      isListed: z.boolean().nullish(),
      isRemote: z.boolean().nullish(),
      workplaceType: z.string().nullish(),
      employmentType: z.string().nullish(),
      descriptionPlain: z.string().nullish(),
      descriptionHtml: z.string().nullish(),
      publishedAt: z.string().nullish(),
    }),
  ),
});

function ashby(board: Extract<BoardConfig, { ats: 'ashby' }>): SourceAdapter {
  const key = `ashby:${board.token}`;
  return {
    key,
    kind: 'ashby',
    snapshotPrefix: `${board.token}:`,
    async fetchJobs(http: Http) {
      const raw = await http.getJson(`https://api.ashbyhq.com/posting-api/job-board/${enc(board.token)}`);
      const parsed = AshbyResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      return parsed.data.jobs
        .filter((j) => j.isListed !== false)
        .map((j): NormalizedJob => {
          const location = joinLocations(j.location, ...(j.secondaryLocations ?? []).map((s) => s.location));
          const explicit = j.workplaceType ?? (j.isRemote ? 'remote' : null);
          return {
            source: 'ashby',
            externalId: `${board.token}:${j.id}`,
            company: board.company,
            title: j.title.trim(),
            location,
            workplaceType: detectWorkplaceType(explicit, location, j.title),
            url: j.jobUrl,
            applyUrl: j.applyUrl ?? undefined,
            description: j.descriptionPlain ? tidyText(j.descriptionPlain) : htmlToText(j.descriptionHtml),
            descriptionIsPartial: false,
            postedAt: toIso(j.publishedAt),
            employmentType: j.employmentType ?? undefined,
            department: j.department ?? j.team ?? undefined,
          };
        });
    },
  };
}

// ---------------------------------------------------------------- Workable
// GET https://apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true

const WorkableResponse = z.object({
  name: z.string().nullish(),
  jobs: z.array(
    z.object({
      title: z.string(),
      shortcode: z.string(),
      url: z.string(),
      application_url: z.string().nullish(),
      shortlink: z.string().nullish(),
      employment_type: z.string().nullish(),
      telecommuting: z.boolean().nullish(),
      department: z.string().nullish(),
      published_on: z.string().nullish(),
      created_at: z.string().nullish(),
      city: z.string().nullish(),
      state: z.string().nullish(),
      country: z.string().nullish(),
      locations: z
        .array(z.object({ city: z.string().nullish(), country: z.string().nullish(), hidden: z.boolean().nullish() }))
        .nullish(),
      description: z.string().nullish(),
    }),
  ),
});

function workable(board: Extract<BoardConfig, { ats: 'workable' }>): SourceAdapter {
  const key = `workable:${board.token}`;
  return {
    key,
    kind: 'workable',
    snapshotPrefix: `${board.token}:`,
    async fetchJobs(http: Http) {
      const raw = await http.getJson(`https://apply.workable.com/api/v1/widget/accounts/${enc(board.token)}?details=true`);
      const parsed = WorkableResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      return parsed.data.jobs.map((j): NormalizedJob => {
        const listed = (j.locations ?? []).filter((l) => !l.hidden).map((l) => [l.city, l.country].filter(Boolean).join(', '));
        const location = listed.length ? joinLocations(...listed) : [j.city, j.state, j.country].filter(Boolean).join(', ');
        return {
          source: 'workable',
          externalId: `${board.token}:${j.shortcode}`,
          company: board.company || parsed.data.name || board.token,
          title: j.title.trim(),
          location,
          workplaceType: j.telecommuting ? 'remote' : detectWorkplaceType(null, location, j.title),
          url: j.shortlink ?? j.url,
          applyUrl: j.application_url ?? undefined,
          description: htmlToText(j.description),
          descriptionIsPartial: !j.description,
          postedAt: toIso(j.published_on ?? j.created_at),
          employmentType: j.employment_type ?? undefined,
          department: j.department ?? undefined,
        };
      });
    },
  };
}

// ---------------------------------------------------------------- Comeet
// GET https://www.comeet.co/careers-api/2.0/company/{uid}/positions?token={token}&details=true

const ComeetResponse = z.array(
  z.object({
    uid: z.string(),
    name: z.string(),
    department: z.string().nullish(),
    employment_type: z.string().nullish(),
    experience_level: z.string().nullish(),
    workplace_type: z.string().nullish(),
    time_updated: z.string().nullish(),
    url_comeet_hosted_page: z.string().nullish(),
    url_active_page: z.string().nullish(),
    location: z
      .object({
        name: z.string().nullish(),
        city: z.string().nullish(),
        country: z.string().nullish(),
        is_remote: z.boolean().nullish(),
      })
      .nullish(),
    details: z
      .array(z.object({ name: z.string().nullish(), value: z.string().nullish(), order: z.number().nullish() }))
      .nullish(),
  }),
);

function comeet(board: Extract<BoardConfig, { ats: 'comeet' }>): SourceAdapter {
  const key = `comeet:${board.uid}`;
  return {
    key,
    kind: 'comeet',
    snapshotPrefix: `${board.uid}:`,
    async fetchJobs(http: Http) {
      const raw = await http.getJson(
        `https://www.comeet.co/careers-api/2.0/company/${enc(board.uid)}/positions?token=${enc(board.token)}&details=true`,
      );
      const parsed = ComeetResponse.safeParse(raw);
      if (!parsed.success) throw formatError(key, parsed.error.issues);
      return parsed.data.flatMap((j): NormalizedJob[] => {
        const url = j.url_active_page ?? j.url_comeet_hosted_page;
        if (!url) return [];
        const loc = j.location;
        const country = loc?.country?.toUpperCase() === 'IL' ? 'Israel' : loc?.country;
        const location = joinLocations(loc?.name, loc?.city, country);
        const details = [...(j.details ?? [])]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((d) => `${d.name ?? ''}\n${htmlToText(d.value)}`);
        return [
          {
            source: 'comeet',
            externalId: `${board.uid}:${j.uid}`,
            company: board.company,
            title: j.name.trim(),
            location,
            workplaceType: detectWorkplaceType(j.workplace_type ?? (loc?.is_remote ? 'remote' : null), location, j.name),
            url,
            description: tidyText(details.join('\n\n')),
            descriptionIsPartial: details.length === 0,
            postedAt: toIso(j.time_updated),
            employmentType: j.employment_type ?? undefined,
            department: j.department ?? undefined,
          },
        ];
      });
    },
  };
}

export function createBoardAdapter(board: BoardConfig): SourceAdapter {
  switch (board.ats) {
    case 'greenhouse':
      return greenhouse(board);
    case 'lever':
      return lever(board);
    case 'ashby':
      return ashby(board);
    case 'workable':
      return workable(board);
    case 'comeet':
      return comeet(board);
  }
}
