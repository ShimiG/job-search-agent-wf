import { existsSync, readFileSync } from 'node:fs';
import { MasterCvSchema, resolvePaths } from '../config.ts';

/**
 * Whether there's a CV to work from: scoring, tailoring and applying all depend on it. The starter
 * file `init` copies is blank on purpose, so a new install asks for a CV before spending anything.
 */
export function cvStatus(file = resolvePaths().masterCv): { ready: boolean; reason?: string } {
  if (!existsSync(file)) return { ready: false, reason: 'No CV yet' };
  let cv;
  try {
    cv = MasterCvSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ready: false, reason: `${file} isn't a valid CV file` };
  }
  if (!cv.name.trim() || /\btodo\b/i.test(cv.name)) return { ready: false, reason: 'The CV has no name yet' };
  if (!cv.experience.some((e) => e.highlights.length)) return { ready: false, reason: 'The CV has no work experience yet' };
  return { ready: true };
}

export const UPLOAD_CV_FIRST = 'Please upload a CV first: the Your CV tab on the review page (npm run review).';
