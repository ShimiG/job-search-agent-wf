import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const keywordList = z.array(z.string().min(1)).default([]);

export const PreferencesSchema = z.object({
  /** Free-form roles you're after. Only the LLM sees these. */
  targetRoles: z.array(z.string()).min(1),
  /** What you want and want to avoid, in your own words. Only the LLM sees this. */
  notes: z.string().default(''),
  titleKeywords: z
    .object({
      /** A title must contain at least one of these. Empty = no include filter. */
      include: keywordList,
      exclude: keywordList,
    })
    .default({ include: [], exclude: [] }),
  seniority: z
    .object({
      /** Title keywords for roles that are too senior or too junior. */
      exclude: keywordList,
    })
    .default({ exclude: [] }),
  locations: z.object({
    /** Location text must contain one of these (case-insensitive, any language). */
    allow: keywordList,
    allowRemote: z.boolean().default(true),
    /** false = only hybrid or remote in allowed locations. Jobs that don't say are kept. */
    allowOnsite: z.boolean().default(true),
    /** Remote roles whose location contains one of these are dropped (e.g. "US only"). */
    remoteExclude: keywordList,
    /** Keep jobs that don't state a location at all. */
    allowUnknown: z.boolean().default(true),
  }),
  languages: z
    .object({
      /** Detected posting languages to keep. Use ISO codes: en, he, ru, de, fr, nl, es. */
      postingLanguages: z.array(z.string()).default(['en']),
      /** Drop postings that require fluency in one of these languages. */
      blockRequired: keywordList,
    })
    .default({ postingLanguages: ['en'], blockRequired: [] }),
  excludeCompanies: keywordList,
  employmentTypes: z.object({ exclude: keywordList }).default({ exclude: [] }),
  /** Drop postings older than this. 0 disables the check. */
  maxAgeDays: z.number().int().min(0).default(30),
  scoring: z
    .object({
      /** Minimum score (0-100) to be shortlisted. */
      threshold: z.number().min(0).max(100).default(65),
      /**
       * Cutoff for postings Scout only has a summary of (job alert emails). They're scored conservatively,
       * so the full-posting threshold would hide them all. Unset = same as threshold.
       */
      partialThreshold: z.number().min(0).max(100).optional(),
      /** Cost guard: max LLM calls per run. The rest wait for the next run. */
      maxJobsPerRun: z.number().int().min(1).default(40),
      concurrency: z.number().int().min(1).max(10).default(3),
      maxAttempts: z.number().int().min(1).default(3),
    })
    .default({ threshold: 65, maxJobsPerRun: 40, concurrency: 3, maxAttempts: 3 }),
  /**
   * For shortlisted alert-email jobs (title, company and location only): search the web for the full
   * posting on the company's own site, then score it again. About 6-8 cents per lookup.
   */
  enrich: z
    .object({
      enabled: z.boolean().default(true),
      maxPerRun: z.number().int().min(0).default(5),
    })
    .default({ enabled: true, maxPerRun: 5 }),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

const boardBase = { company: z.string().min(1), enabled: z.boolean().default(true) };

export const BoardSchema = z.discriminatedUnion('ats', [
  z.object({ ats: z.literal('greenhouse'), token: z.string().min(1), ...boardBase }),
  z.object({
    ats: z.literal('lever'),
    token: z.string().min(1),
    region: z.enum(['global', 'eu']).default('global'),
    ...boardBase,
  }),
  z.object({ ats: z.literal('ashby'), token: z.string().min(1), ...boardBase }),
  z.object({ ats: z.literal('workable'), token: z.string().min(1), ...boardBase }),
  z.object({
    ats: z.literal('comeet'),
    /** The company UID from the Comeet careers URL. */
    uid: z.string().min(1),
    /** The careers API token (found in the careers page source). */
    token: z.string().min(1),
    ...boardBase,
  }),
]);
export type BoardConfig = z.infer<typeof BoardSchema>;

export const EmailFeedSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/i, 'feed names are used in IDs: letters, digits, _ and - only'),
  /** Sender address to search for. */
  from: z.string().min(1),
  /** Regex for job links. Capture group 1 must be the job ID. */
  linkPattern: z.string().min(1),
  /** Canonical job URL. {id} is replaced with the captured ID. */
  urlTemplate: z.string().includes('{id}'),
});
export type EmailFeed = z.infer<typeof EmailFeedSchema>;

export const SourcesSchema = z.object({
  boards: z.array(BoardSchema).default([]),
  emailAlerts: z
    .object({
      enabled: z.boolean().default(false),
      mailbox: z.string().default('INBOX'),
      /** How many days of alert emails to read on each run. */
      sinceDays: z.number().int().min(1).default(3),
      /** Read application confirmation emails and mark those jobs as applied. */
      trackApplications: z.boolean().default(true),
      /** How far back to look for confirmation emails. */
      applicationsSinceDays: z.number().int().min(1).default(365),
      feeds: z.array(EmailFeedSchema).default([]),
    })
    .default({ enabled: false, mailbox: 'INBOX', sinceDays: 3, trackApplications: true, applicationsSinceDays: 365, feeds: [] }),
});
export type SourcesConfig = z.infer<typeof SourcesSchema>;

const highlight = z.object({ id: z.string(), text: z.string(), tags: z.array(z.string()).optional() });

/**
 * Structured master CV. Highlight IDs matter: the Tailor agent will cite them
 * to prove every claim in a tailored CV comes from here.
 */
export const MasterCvSchema = z.object({
  name: z.string(),
  headline: z.string(),
  location: z.string().optional(),
  summary: z.string(),
  skills: z.array(z.object({ category: z.string(), items: z.array(z.string()) })),
  experience: z.array(
    z.object({
      id: z.string(),
      company: z.string(),
      role: z.string(),
      start: z.string(),
      end: z.string().optional(),
      highlights: z.array(highlight),
    }),
  ),
  projects: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        stack: z.array(z.string()).default([]),
        highlights: z.array(highlight),
      }),
    )
    .default([]),
  education: z
    .array(z.object({ institution: z.string(), degree: z.string(), year: z.string().optional() }))
    .default([]),
  languages: z.array(z.object({ language: z.string(), level: z.string() })).default([]),
  links: z.record(z.string(), z.string()).default({}),
});
export type MasterCv = z.infer<typeof MasterCvSchema>;

export interface Paths {
  configDir: string;
  dataDir: string;
  preferences: string;
  sources: string;
  masterCv: string;
  tailor: string;
  submit: string;
  applicationsDir: string;
  browserProfile: string;
  db: string;
}

export function resolvePaths(root = process.cwd()): Paths {
  const configDir = path.resolve(root, process.env.SCOUT_CONFIG_DIR ?? 'config');
  const dataDir = path.resolve(root, process.env.SCOUT_DATA_DIR ?? 'data');
  return {
    configDir,
    dataDir,
    preferences: path.join(configDir, 'preferences.json'),
    sources: path.join(configDir, 'sources.json'),
    masterCv: path.join(dataDir, 'master-cv.json'),
    tailor: path.join(configDir, 'tailor.json'),
    submit: path.join(configDir, 'submit.json'),
    applicationsDir: path.join(dataDir, 'applications'),
    browserProfile: path.join(dataDir, 'browser-profile'),
    db: process.env.SCOUT_DB_PATH ? path.resolve(root, process.env.SCOUT_DB_PATH) : path.join(dataDir, 'scout.db'),
  };
}

export class ConfigError extends Error {}

export function loadJsonFile<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  if (!existsSync(file)) {
    throw new ConfigError(`Missing ${file}. Run "npm run scout -- init" to create it from the example.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`${file} is invalid:\n${issues}`);
  }
  return parsed.data;
}

export function saveSources(file: string, sources: SourcesConfig): void {
  writeFileSync(file, JSON.stringify(sources, null, 2) + '\n', 'utf8');
}

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

export function imapCredentialsFromEnv(env = process.env): ImapCredentials | null {
  const { IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD } = env;
  if (!IMAP_USER || !IMAP_PASSWORD) return null;
  return {
    host: IMAP_HOST ?? 'imap.gmail.com',
    port: IMAP_PORT ? Number(IMAP_PORT) : 993,
    user: IMAP_USER,
    password: IMAP_PASSWORD,
  };
}
