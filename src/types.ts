export const SOURCE_KINDS = ['greenhouse', 'lever', 'ashby', 'workable', 'comeet', 'email'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type WorkplaceType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

/** The one shape every source adapter must produce. */
export interface NormalizedJob {
  source: SourceKind;
  /** Unique within `source`. ATS adapters prefix it with the board token ("acme:12345"). */
  externalId: string;
  company: string;
  title: string;
  location: string;
  workplaceType: WorkplaceType;
  url: string;
  applyUrl?: string;
  /** Plain text, HTML already stripped. */
  description: string;
  /** True when the source only gave a summary (e.g. alert emails). */
  descriptionIsPartial: boolean;
  /** ISO timestamp. */
  postedAt?: string;
  employmentType?: string;
  department?: string;
}

/**
 * Job lifecycle shared by all three agents. Scout owns everything up to `shortlisted`;
 * the human gate moves jobs to `selected` / `dismissed`; Tailor and Submitter own the rest.
 */
export const JOB_STATUSES = [
  'discovered',
  'filtered_out',
  'duplicate',
  'queued',
  'score_error',
  'low_score',
  'shortlisted',
  'selected',
  'dismissed',
  'tailored',
  'tailor_error',
  'approved',
  'submitted',
  'needs_manual',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses Scout may freely change. Anything past these belongs to you or the other agents. */
export const SCOUT_OWNED_STATUSES: readonly JobStatus[] = [
  'discovered',
  'filtered_out',
  'duplicate',
  'queued',
  'score_error',
  'low_score',
  'shortlisted',
];

export function isScoutOwned(status: JobStatus): boolean {
  return SCOUT_OWNED_STATUSES.includes(status);
}

export interface ScoreResult {
  score: number;
  verdict: 'strong' | 'good' | 'stretch' | 'poor';
  seniorityFit: 'under' | 'fit' | 'over' | 'unclear';
  matchReasons: string[];
  gaps: string[];
  dealbreakers: string[];
  summary: string;
}

/** Statuses the Tailor agent picks up. */
export const TAILOR_INPUT_STATUSES: readonly JobStatus[] = ['selected', 'tailor_error'];

/** Statuses the Submitter picks up. needs_manual is included so assist mode can finish what auto couldn't. */
export const SUBMIT_INPUT_STATUSES: readonly JobStatus[] = ['approved', 'needs_manual'];

/** A job row as stored in the database. */
export interface JobRow extends NormalizedJob {
  id: number;
  status: JobStatus;
  statusReason: string | null;
  duplicateOf: number | null;
  normCompany: string;
  normTitle: string;
  contentHash: string;
  score: number | null;
  scoreDetails: ScoreResult | null;
  scoreAttempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  /** Your note for the next tailoring attempt ("lead with the integrations work"). */
  tailorFeedback: string | null;
  /** When Scout searched the web for the full posting of a summary-only job (null = not yet). */
  enrichedAt: string | null;
  /** Where a looked-up full description came from (the company's page, or a site copying it). */
  postingUrl: string | null;
}
