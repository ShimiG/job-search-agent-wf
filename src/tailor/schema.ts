import { z } from 'zod';

export const SUPPORTED_LANGUAGES = ['en', 'he', 'ru'] as const;
export type OutputLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const TailorConfigSchema = z.object({
  /** Shown in the CV header. The master CV holds name, location and links. */
  contact: z.object({
    email: z.string().min(3),
    phone: z.string().default(''),
  }),
  languages: z
    .object({
      /**
       * "en" keeps the CV in English (safest: bullets can fall back to your exact wording).
       * "match" writes it in the posting's language (he/ru/en), which means translating your CV.
       */
      cv: z.enum(['en', 'match']).default('en'),
      coverLetter: z.enum(['en', 'match']).default('match'),
    })
    .default({ cv: 'en', coverLetter: 'match' }),
  cv: z
    .object({
      maxBulletsPerRole: z.number().int().min(1).max(10).default(5),
      maxProjects: z.number().int().min(0).max(6).default(2),
      maxSkills: z.number().int().min(3).max(40).default(14),
      /** Warn when the rendered CV PDF is longer than this. */
      targetPages: z.number().int().min(1).max(4).default(1),
    })
    .default({ maxBulletsPerRole: 5, maxProjects: 2, maxSkills: 14, targetPages: 1 }),
  coverLetter: z
    .object({
      maxWords: z.number().int().min(80).max(600).default(280),
      /** Per letter language. */
      signOff: z
        .object({ en: z.string().default('Best regards'), he: z.string().default('בברכה'), ru: z.string().default('С уважением') })
        .default({ en: 'Best regards', he: 'בברכה', ru: 'С уважением' }),
      style: z.string().default('Direct and specific. Short sentences. Confident without hype.'),
      /** Phrases the letter must not use. */
      avoid: z.array(z.string()).default([]),
    })
    .default({ maxWords: 280, signOff: { en: 'Best regards', he: 'בברכה', ru: 'С уважением' }, style: 'Direct and specific. Short sentences. Confident without hype.', avoid: [] }),
  pdf: z
    .object({
      enabled: z.boolean().default(true),
      /** Full path to Chrome/Edge/Chromium. Leave empty to auto-detect installed Chrome, then Edge. */
      browserPath: z.string().default(''),
    })
    .default({ enabled: true, browserPath: '' }),
  /** Cost guard: max jobs tailored per run. */
  maxJobsPerRun: z.number().int().min(1).default(5),
});
export type TailorConfig = z.infer<typeof TailorConfigSchema>;

/*
 * What the writer model returns. Plain types only (the SDK doesn't enforce enums or ranges);
 * every rule is enforced afterwards in verify.ts.
 */
const sourced = z.object({ text: z.string(), sources: z.array(z.string()) });
const bullet = z.object({
  source: z.string().describe('The highlight id this bullet is based on'),
  text: z.string().describe('The bullet, reworded for this job. Same facts as the source.'),
});

export const DraftSchema = z.object({
  headline: z.string().describe('CV headline for this application, grounded in the candidate\'s real roles'),
  summary: sourced.describe('2-3 sentence profile; sources = highlight ids it relies on'),
  skills: z.array(z.string()).describe('Exact skill strings copied from the CV, most relevant first'),
  experience: z
    .array(z.object({ id: z.string(), bullets: z.array(bullet) }))
    .describe('Every experience entry from the CV, by id, with its most relevant highlights'),
  projects: z.array(z.object({ id: z.string(), bullets: z.array(bullet) })).describe('Most relevant projects only'),
  coverLetter: z.object({
    greeting: z.string(),
    paragraphs: z.array(sourced),
    closing: z.string().describe('Closing line before the sign-off'),
  }),
  notes: z.object({
    emphasized: z.array(z.string()).describe('What you chose to emphasize and why, briefly'),
    requirementsNotMet: z.array(z.string()).describe('Posting requirements the CV does not support'),
  }),
});
export type Draft = z.infer<typeof DraftSchema>;

export const VerdictSchema = z.object({
  claims: z.array(
    z.object({
      id: z.string(),
      supported: z.boolean(),
      problem: z.string().describe('Empty when supported; otherwise what is not backed by the CV'),
    }),
  ),
});
export type Verdicts = z.infer<typeof VerdictSchema>;

export type IssueSeverity = 'fixed' | 'warning' | 'unresolved';

export interface Issue {
  severity: IssueSeverity;
  /** Where: "bullet:acme-llm-agents", "letter:1", "skills", "summary"... */
  where: string;
  message: string;
}

export interface BulletChange {
  source: string;
  original: string;
  final: string;
}

/** The final, verified content. This file is the source of truth for rendering and can be edited by hand. */
export interface TailoredContent {
  jobId: number;
  company: string;
  jobTitle: string;
  cvLanguage: OutputLanguage;
  letterLanguage: OutputLanguage;
  headline: string;
  summary: string;
  skills: string[];
  experience: Array<{ id: string; bullets: Array<{ source: string; text: string }> }>;
  projects: Array<{ id: string; bullets: Array<{ source: string; text: string }> }>;
  coverLetter: { greeting: string; paragraphs: string[]; closing: string; signOff: string };
  notes: { emphasized: string[]; requirementsNotMet: string[] };
  generatedAt: string;
}

export interface VerificationReport {
  ok: boolean;
  issues: Issue[];
  bulletChanges: BulletChange[];
  llmChecked: boolean;
  revised: boolean;
  cvPages?: number;
}
