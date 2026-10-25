import { z } from 'zod';

/**
 * config/answers.json: everything the Submitter may say on your behalf.
 * If a required question isn't covered here or by your CV, the Submitter stops and asks you.
 */
export const AnswersConfigSchema = z.object({
  profile: z
    .object({
      /** Defaults: split from the CV name. */
      firstName: z.string().default(''),
      lastName: z.string().default(''),
      /** Defaults: config/tailor.json contact and the CV. */
      email: z.string().default(''),
      phone: z.string().default(''),
      city: z.string().default(''),
      country: z.string().default(''),
      linkedin: z.string().default(''),
      github: z.string().default(''),
      website: z.string().default(''),
    })
    .default({ firstName: '', lastName: '', email: '', phone: '', city: '', country: '', linkedin: '', github: '', website: '' }),
  /**
   * Screening answers. The first entry whose `match` phrases appear in the question label wins.
   * `locations` limits an entry to jobs whose location contains one of those words, so you can
   * answer work-authorization questions differently for Israel and Germany.
   * An empty answer means "always ask me".
   */
  answers: z
    .array(
      z.object({
        id: z.string().min(1),
        match: z.array(z.string().min(1)).min(1),
        answer: z.string(),
        locations: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** Voluntary demographic questions (gender, ethnicity, veteran, disability). Never answered by the model. */
  demographics: z.enum(['decline', 'leave_blank']).default('decline'),
  /** Tick required privacy/consent checkboxes. Off by default: you decide this. */
  consentToPrivacyPolicies: z.boolean().default(false),
});
export type AnswersConfig = z.infer<typeof AnswersConfigSchema>;

export const SubmitConfigSchema = z.object({
  /** Off by default. When on, `run --mode auto` submits by itself, within autoSubmitModelAnswers. */
  autoSubmit: z.boolean().default(false),
  /**
   * Which answers Claude wrote may auto mode send without you seeing them first:
   * "none" (every answer must be yours), "facts" (taken from your CV: years, website...; written
   * answers like "Why us?" stop it), or "all". They're always listed afterwards in the record.
   */
  autoSubmitModelAnswers: z.enum(['none', 'facts', 'all']).default('none'),
  /**
   * Review each tailored application before it's sent (the default). When off, applications go to the
   * Submitter as soon as they're tailored; ones with claims the fact-check couldn't verify still wait.
   */
  requireApproval: z.boolean().default(true),
  /** Never apply to the same company more than this many times in 30 days. */
  maxPerCompanyPer30Days: z.number().int().min(1).default(2),
  maxPerRun: z.number().int().min(1).default(5),
  /** Minutes to wait for you to click Submit in assist mode. */
  assistTimeoutMinutes: z.number().int().min(1).default(20),
  browserPath: z.string().default(''),
});
export type SubmitConfig = z.infer<typeof SubmitConfigSchema>;

export type FieldKind =
  | 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'textarea'
  | 'select' | 'radio' | 'checkbox' | 'file' | 'combobox';

/** One question on the form, as extracted from the page. */
export interface FormField {
  /** Stable handle: the data-ja-key attribute written onto the element(s). */
  key: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  options: string[];
  name: string;
  maxLength?: number;
  accept?: string;
}

export type AnswerSource =
  | 'profile'
  | 'answer_bank'
  | 'document'
  | 'demographics'
  | 'consent'
  | 'model_fact'
  | 'model_draft'
  | 'none';

export interface PlannedAnswer {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Text to type, option to choose, "true" to tick, or a file path. Empty = leave alone. */
  value: string;
  source: AnswerSource;
  /** Answer-bank id, document name, or the model's reasoning. */
  detail?: string;
  /** Set after filling: whether the page accepted it. */
  filled?: boolean;
  error?: string;
}

export type SubmitMode = 'prepare' | 'assist' | 'auto';

export const MODEL_SOURCES: readonly AnswerSource[] = ['model_fact', 'model_draft'];

/** config/submit.json: Submitter behavior plus your answer bank, in one file. */
export const SubmitFileSchema = z.object({ ...SubmitConfigSchema.shape, ...AnswersConfigSchema.shape });
export type SubmitFile = z.infer<typeof SubmitFileSchema>;
