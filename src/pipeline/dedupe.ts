import type { JobRow, JobStatus } from '../types.ts';
import { isScoutOwned } from '../types.ts';
import { diceSimilarity, normalizeForMatch } from '../util/text.ts';

export const TITLE_SIMILARITY_THRESHOLD = 0.9;

type DedupeFields = Pick<JobRow, 'id' | 'source' | 'normTitle' | 'location' | 'descriptionIsPartial' | 'firstSeenAt' | 'status'>;

/**
 * Two rows are the same job when they belong to the same company (rows passed in are
 * pre-filtered by normCompany) and their titles are near-identical, and either:
 *  - they come from different sources (an ATS posting vs. a LinkedIn alert for it), or
 *  - they come from the same source with the same location (a re-posted requisition).
 * Same title + same board + different location is usually a genuinely separate opening.
 */
export function isSameJob(a: DedupeFields, b: DedupeFields): boolean {
  if (diceSimilarity(a.normTitle, b.normTitle) < TITLE_SIMILARITY_THRESHOLD) return false;
  // "Software Engineer II" vs "III" is a near-perfect string match but a different job.
  if (levelTokens(a.normTitle) !== levelTokens(b.normTitle)) return false;
  if (a.source !== b.source) return true;
  return normalizeForMatch(a.location) === normalizeForMatch(b.location);
}

const LEVEL_TOKENS = new Set([
  'i', 'ii', 'iii', 'iv', 'v', 'jr', 'junior', 'sr', 'senior', 'mid', 'lead', 'staff', 'principal',
  'ג׳וניור', 'גוניור', 'סניור', 'בכיר', 'בכירה', 'זוטר', 'זוטרה',
]);

/** Level words and numbers in a normalized title, as a sorted signature. */
function levelTokens(normTitle: string): string {
  return normTitle
    .split(' ')
    .filter((t) => LEVEL_TOKENS.has(t) || /^\d+$/.test(t))
    .sort()
    .join(' ');
}

/** Higher is better: full descriptions beat alert-email summaries, then older wins (stable IDs for you). */
function richness(job: DedupeFields): [number, number] {
  return [job.descriptionIsPartial ? 0 : 1, -new Date(job.firstSeenAt).getTime()];
}

export type DedupeDecision =
  | { kind: 'unique' }
  | { kind: 'duplicate'; canonicalId: number }
  /** The new job is richer: it becomes canonical and the existing one is demoted. */
  | { kind: 'replace'; demoteId: number };

/**
 * Not valid canonicals: duplicates and filtered jobs are out of play, and `discovered` rows
 * haven't been evaluated yet (they'll compare against this job when their turn comes).
 */
const IGNORED: readonly JobStatus[] = ['duplicate', 'filtered_out', 'discovered'];

export function decideDuplicate(job: DedupeFields, candidates: readonly DedupeFields[]): DedupeDecision {
  const match = candidates.find((c) => c.id !== job.id && !IGNORED.includes(c.status) && isSameJob(job, c));
  if (!match) return { kind: 'unique' };

  const [jobRich, jobAge] = richness(job);
  const [matchRich, matchAge] = richness(match);
  const jobIsBetter = jobRich > matchRich || (jobRich === matchRich && jobAge > matchAge);

  // Never pull a job out from under you or the other agents once it has left Scout's hands.
  if (jobIsBetter && isScoutOwned(match.status)) return { kind: 'replace', demoteId: match.id };
  return { kind: 'duplicate', canonicalId: match.id };
}
