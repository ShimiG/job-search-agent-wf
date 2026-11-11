import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { PreferencesSchema, type Preferences } from './config.ts';

/*
 * Settings changed on the review page are written back into your config files, so Scout's scheduled
 * runs, the CLI and the page all use the same values.
 */

export const SCORE_MIN = 0;
export const SCORE_MAX = 100;
export const DEFAULT_THRESHOLD = 65;

const Score = z.number().int('a whole number').min(SCORE_MIN).max(SCORE_MAX);
export const ShortlistCutoffSchema = z.object({
  /** Minimum score for a job with its full posting. */
  threshold: Score,
  /** Minimum for a job known only from an alert email's title. null: the same as threshold. */
  partialThreshold: Score.nullable().default(null),
});
export type ShortlistCutoff = z.infer<typeof ShortlistCutoffSchema>;

export function shortlistCutoff(prefs: Preferences): ShortlistCutoff {
  return { threshold: prefs.scoring.threshold, partialThreshold: prefs.scoring.partialThreshold ?? null };
}

/** Saves the cutoffs into config/preferences.json, leaving everything else in the file as it was. */
export function saveShortlistCutoff(file: string, input: unknown): Preferences {
  const parsed = ShortlistCutoffSchema.safeParse(input);
  // A plain Error, so the page shows this rather than a generic "invalid request".
  if (!parsed.success) throw new Error(`The minimum score must be a whole number from ${SCORE_MIN} to ${SCORE_MAX}`);
  const { threshold, partialThreshold } = parsed.data;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.scoring = { ...raw.scoring, threshold };
  if (partialThreshold === null) delete raw.scoring.partialThreshold;
  else raw.scoring.partialThreshold = partialThreshold;
  const prefs = PreferencesSchema.parse(raw);
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return prefs;
}
