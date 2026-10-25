import type { BoardConfig } from '../config.ts';
import { titleCase } from '../util/text.ts';

export type DetectedBoard =
  | { ok: true; board: BoardConfig }
  | { ok: false; reason: string; partial?: Partial<BoardConfig> };

/**
 * Recognizes careers-page URLs for the supported ATSs, e.g.
 *   https://job-boards.greenhouse.io/acme/jobs/123
 *   https://jobs.lever.co/acme
 *   https://jobs.ashbyhq.com/acme
 *   https://apply.workable.com/acme/
 *   https://www.comeet.com/jobs/acme/A1.B2C   (also needs the API token)
 */
export function detectBoard(input: string, opts: { company?: string; token?: string } = {}): DetectedBoard {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: `Not a valid URL: ${input}` };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];
  const company = (token: string) => opts.company ?? titleCase(token);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const token =
      url.searchParams.get('for') ??
      (host.startsWith('boards-api.') ? segments[2] : first !== 'embed' ? first : undefined);
    if (!token) return { ok: false, reason: 'Could not find the Greenhouse board token in that URL' };
    return { ok: true, board: { ats: 'greenhouse', token, company: company(token), enabled: true } };
  }

  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (!first) return { ok: false, reason: 'Could not find the Lever site name in that URL' };
    return {
      ok: true,
      board: { ats: 'lever', token: first, region: host.includes('.eu.') ? 'eu' : 'global', company: company(first), enabled: true },
    };
  }

  if (host === 'jobs.ashbyhq.com') {
    if (!first) return { ok: false, reason: 'Could not find the Ashby board name in that URL' };
    return { ok: true, board: { ats: 'ashby', token: first, company: company(first), enabled: true } };
  }

  if (host === 'apply.workable.com' || /\.workable\.com$/.test(host)) {
    const token = host === 'apply.workable.com' ? first : host.split('.')[0];
    if (!token || token === 'j') return { ok: false, reason: 'Use the company careers URL (apply.workable.com/<company>), not a job link' };
    return { ok: true, board: { ats: 'workable', token, company: company(token), enabled: true } };
  }

  if (host === 'comeet.com' || host === 'comeet.co') {
    // /jobs/{slug}/{companyUid}[/...]
    const [jobs, slug, uid] = segments;
    if (jobs !== 'jobs' || !slug || !uid) return { ok: false, reason: 'Expected a Comeet URL like comeet.com/jobs/<company>/<UID>' };
    const partial = { ats: 'comeet' as const, uid, company: opts.company ?? titleCase(slug), enabled: true };
    if (!opts.token) {
      return {
        ok: false,
        reason:
          'Comeet also needs the careers API token. Open the careers page, view source, search for "token", and rerun with --token <value>.',
        partial,
      };
    }
    return { ok: true, board: { ...partial, token: opts.token } };
  }

  return {
    ok: false,
    reason: `Unrecognized careers site (${host}). Supported: Greenhouse, Lever, Ashby, Workable, Comeet.`,
  };
}
