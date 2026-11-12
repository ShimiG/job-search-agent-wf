import type { MasterCv } from '../config.ts';

/*
 * The links in your CV (LinkedIn, GitHub, portfolio...). They're printed in the CV header, and the
 * Submitter types them into the matching form fields: "linkedin" and "github" into theirs, and
 * "website" or "portfolio" into any field that asks for a portfolio, website, personal site or blog.
 */

/** The form field each link name fills, for the ones the Submitter knows. */
export const FORM_FIELD: Record<string, 'linkedin' | 'github' | 'website'> = { linkedin: 'linkedin', github: 'github', website: 'website', portfolio: 'website' };

export class LinkError extends Error {}

const keyOf = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A full web address, as a form's URL field accepts it. */
export function checkUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LinkError(`"${text}" isn't a web address. Write it in full, starting with https://`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkError(`"${text}" isn't a web address: it has to start with https://`);
  if (!url.hostname.includes('.')) throw new LinkError(`"${text}" has no site name in it (like example.com).`);
  return text;
}

export interface LinkChange {
  cv: MasterCv;
  /** The name the link is stored under. */
  key: string;
  /** What was there before, if anything. */
  previous: string | null;
}

/** Sets a link in the CV, or removes it when `url` is null. The CV passed in is not changed. */
export function setCvLink(cv: MasterCv, name: string, url: string | null): LinkChange {
  const key = keyOf(name);
  if (!key) throw new LinkError('Give the link a name: linkedin, github, portfolio, website...');
  // An existing link is matched whatever its capitals ("GitHub"), and keeps its place in the header.
  const existing = Object.keys(cv.links).find((k) => keyOf(k) === key);
  const previous = existing ? cv.links[existing]! : null;
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(cv.links)) {
    if (k !== existing) links[k] = v;
    else if (url !== null) links[k] = checkUrl(url);
  }
  if (!existing) {
    if (url === null) throw new LinkError(`Your CV has no "${key}" link. It has: ${Object.keys(cv.links).join(', ') || 'none'}.`);
    links[key] = checkUrl(url);
  }
  return { cv: { ...cv, links }, key: existing ?? key, previous };
}

/**
 * What stands between a CV link and the form field it should fill: the Submitter takes its own
 * profile setting first, and "website" before "portfolio". Empty when the link is what forms will get.
 */
export function overriddenBy(cv: MasterCv, key: string, profile: Partial<Record<'linkedin' | 'github' | 'website', string>> = {}): string | null {
  const field = FORM_FIELD[keyOf(key)];
  const mine = Object.entries(cv.links).find(([k]) => keyOf(k) === keyOf(key))?.[1];
  if (!field || !mine) return null;
  const set = profile[field]?.trim();
  if (set && set !== mine) return `config/submit.json has profile.${field} set to ${set}, and the Submitter uses that first. Change it there too, or clear it.`;
  if (keyOf(key) === 'portfolio' && !set) {
    const website = Object.entries(cv.links).find(([k]) => keyOf(k) === 'website')?.[1]?.trim();
    if (website && website !== mine) return `Your CV also has a "website" link (${website}), and forms get that one first. Remove it with: npm run scout -- cv-link website --remove`;
  }
  return null;
}
