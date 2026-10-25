import type { Http } from './http.ts';
import type { NormalizedJob, SourceKind, WorkplaceType } from '../types.ts';

export interface SourceAdapter {
  /** Stable key for logs and source health, e.g. "greenhouse:acme". */
  readonly key: string;
  readonly kind: SourceKind;
  /**
   * When set, a successful fetch is a complete snapshot of the board, so jobs with this
   * external-ID prefix that weren't returned can be marked closed.
   */
  readonly snapshotPrefix?: string;
  fetchJobs(http: Http): Promise<NormalizedJob[]>;
}

export class SourceFormatError extends Error {}

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere)\b|מרחוק|עבודה מהבית/i;
const HYBRID_RE = /\bhybrid\b|היברידי/i;
const ONSITE_RE = /\b(on[- ]?site|in[- ]office)\b/i;

/**
 * Maps whatever the source says to our enum. Explicit source fields win;
 * otherwise only location and title are checked, not the description,
 * because descriptions mention "remote" in benefits sections all the time.
 */
export function detectWorkplaceType(explicit: string | null | undefined, ...texts: Array<string | undefined>): WorkplaceType {
  const e = (explicit ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (e === 'remote') return 'remote';
  if (e === 'hybrid') return 'hybrid';
  if (e === 'onsite' || e === 'inoffice' || e === 'office') return 'onsite';
  const joined = texts.filter(Boolean).join(' | ');
  if (HYBRID_RE.test(joined)) return 'hybrid';
  if (REMOTE_RE.test(joined)) return 'remote';
  if (ONSITE_RE.test(joined)) return 'onsite';
  return 'unknown';
}

export function toIso(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Joins location fragments, skipping any already covered ("Israel" after "Tel Aviv, Israel"). */
export function joinLocations(...parts: Array<string | null | undefined>): string {
  const out: string[] = [];
  for (const p of parts) {
    const v = p?.trim();
    if (!v) continue;
    const lower = v.toLowerCase();
    if (out.some((o) => o.toLowerCase().includes(lower))) continue;
    out.push(v);
  }
  return out.join(' / ');
}

/** Turns a schema failure into a readable error that names the source. */
export function formatError(key: string, issues: Array<{ path: PropertyKey[]; message: string }>): SourceFormatError {
  const first = issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return new SourceFormatError(`${key}: unexpected response format (${first})`);
}
