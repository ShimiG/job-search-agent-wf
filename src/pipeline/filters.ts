import type { Preferences } from '../config.ts';
import type { NormalizedJob } from '../types.ts';
import { containsKeyword, findKeyword, normalizeCompany } from '../util/text.ts';
import { detectLanguage, findRequiredLanguage } from './language.ts';

export type FilterCode =
  | 'company'
  | 'title_exclude'
  | 'seniority'
  | 'title_include'
  | 'employment_type'
  | 'too_old'
  | 'location'
  | 'posting_language'
  | 'required_language';

export type FilterResult = { pass: true } | { pass: false; code: FilterCode; reason: string };

const pass: FilterResult = { pass: true };
const fail = (code: FilterCode, reason: string): FilterResult => ({ pass: false, code, reason });

type Check = (job: NormalizedJob, prefs: Preferences, now: Date) => FilterResult;

const company: Check = (job, prefs) => {
  const norm = normalizeCompany(job.company);
  const hit = prefs.excludeCompanies.find((c) => {
    const n = normalizeCompany(c);
    return n && (norm === n || containsKeyword(norm, n));
  });
  return hit ? fail('company', `excluded company: ${hit}`) : pass;
};

const titleExclude: Check = (job, prefs) => {
  const hit = findKeyword(job.title, prefs.titleKeywords.exclude);
  return hit ? fail('title_exclude', `title contains "${hit}"`) : pass;
};

const seniority: Check = (job, prefs) => {
  const hit = findKeyword(job.title, prefs.seniority.exclude);
  return hit ? fail('seniority', `seniority: "${hit}"`) : pass;
};

const titleInclude: Check = (job, prefs) => {
  const include = prefs.titleKeywords.include;
  if (include.length === 0) return pass;
  return findKeyword(job.title, include) ? pass : fail('title_include', 'title matches none of titleKeywords.include');
};

const employmentType: Check = (job, prefs) => {
  const hit = findKeyword(`${job.employmentType ?? ''} ${job.title}`, prefs.employmentTypes.exclude);
  return hit ? fail('employment_type', `employment type: "${hit}"`) : pass;
};

const age: Check = (job, prefs, now) => {
  if (!prefs.maxAgeDays || !job.postedAt) return pass;
  const days = (now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000;
  return days > prefs.maxAgeDays ? fail('too_old', `posted ${Math.floor(days)} days ago (max ${prefs.maxAgeDays})`) : pass;
};

const location: Check = (job, prefs) => {
  const loc = prefs.locations;
  const text = job.location.trim();
  if (job.workplaceType === 'remote') {
    if (!loc.allowRemote) return fail('location', 'remote roles disabled');
    const excluded = findKeyword(text, loc.remoteExclude);
    if (excluded) return fail('location', `remote, but restricted to "${excluded}"`);
    return pass;
  }
  if (job.workplaceType === 'onsite' && !loc.allowOnsite) return fail('location', 'on-site role');
  if (!text) return loc.allowUnknown ? pass : fail('location', 'no location given');
  if (loc.allow.length === 0) return pass;
  return findKeyword(text, loc.allow) ? pass : fail('location', `location not allowed: ${text}`);
};

const postingLanguage: Check = (job, prefs) => {
  const lang = detectLanguage(`${job.title}\n${job.description}`);
  if (lang === 'unknown') return pass;
  return prefs.languages.postingLanguages.includes(lang) ? pass : fail('posting_language', `posting language: ${lang}`);
};

const requiredLanguage: Check = (job, prefs) => {
  const lang = findRequiredLanguage(`${job.title}\n${job.description}`, prefs.languages.blockRequired);
  return lang ? fail('required_language', `requires ${lang}`) : pass;
};

/** Ordered cheapest/most decisive first. The first failure wins and becomes the stored reason. */
const CHECKS: Check[] = [company, titleExclude, seniority, titleInclude, employmentType, age, location, postingLanguage, requiredLanguage];

export function applyHardFilters(job: NormalizedJob, prefs: Preferences, now = new Date()): FilterResult {
  for (const check of CHECKS) {
    const result = check(job, prefs, now);
    if (!result.pass) return result;
  }
  return pass;
}
