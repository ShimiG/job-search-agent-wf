import type { MasterCv } from '../config.ts';
import type { TailorConfig } from '../tailor/schema.ts';
import type { JobRow } from '../types.ts';
import { containsKeyword } from '../util/text.ts';
import type { AnswersConfig, FieldKind, FormField, PlannedAnswer } from './schema.ts';

// ---------------------------------------------------------------- platforms

export interface Platform {
  name: string;
  /** Sites where the Submitter must not act: accounts, CAPTCHAs on every form, or terms that forbid automation. */
  manualOnly?: string;
}

const MANUAL_ONLY: Array<[RegExp, string, string]> = [
  [/(^|\.)linkedin\.com$/, 'LinkedIn', 'LinkedIn forbids automated applications; apply on the site'],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)workday\.com$/, 'Workday', 'Workday requires an account per company'],
  [/(^|\.)icims\.com$/, 'iCIMS', 'iCIMS usually requires an account'],
  [/(^|\.)taleo\.net$/, 'Taleo', 'Taleo requires an account'],
  [/successfactors\.(com|eu)$/, 'SuccessFactors', 'SuccessFactors requires an account'],
  [/(^|\.)indeed\.com$/, 'Indeed', 'Indeed forbids automated applications'],
  [/(^|\.)drushim\.co\.il$|(^|\.)alljobs\.co\.il$/, 'Israeli job board', 'apply on the job board itself'],
];

export function detectPlatform(url: string): Platform {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { name: 'unknown', manualOnly: `not a valid URL: ${url}` };
  }
  for (const [re, name, reason] of MANUAL_ONLY) if (re.test(host)) return { name, manualOnly: reason };
  if (/greenhouse\.io$/.test(host)) return { name: 'Greenhouse' };
  if (/lever\.co$/.test(host)) return { name: 'Lever' };
  if (/ashbyhq\.com$/.test(host)) return { name: 'Ashby' };
  if (/workable\.com$/.test(host)) return { name: 'Workable' };
  if (/comeet\.(com|co)$/.test(host) || /comeet_pos=/.test(url)) return { name: 'Comeet' };
  return { name: 'company site' };
}

/** Where the form lives. Lever and Ashby put it on a sub-page; most others embed it in the job page. */
export function resolveApplyUrl(job: Pick<JobRow, 'url' | 'applyUrl' | 'source'>): string {
  if (job.applyUrl) return job.applyUrl;
  const url = job.url.replace(/\/+$/, '');
  if (job.source === 'lever' && !/\/apply$/.test(url)) return `${url}/apply`;
  if (job.source === 'ashby' && !/\/application$/.test(url)) return `${url}/application`;
  return job.url;
}

// ---------------------------------------------------------------- profile

export interface Profile {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  linkedin: string;
  github: string;
  website: string;
  currentCompany: string;
  currentTitle: string;
}

const real = (s: string | undefined) => (s && !/^todo\b/i.test(s.trim()) ? s.trim() : '');

export function buildProfile(cv: MasterCv, answers: AnswersConfig, contact: TailorConfig['contact']): Profile {
  const p = answers.profile;
  const [first = '', ...rest] = real(cv.name).split(/\s+/);
  const locParts = (cv.location ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const current = cv.experience.find((e) => !e.end) ?? cv.experience[0];
  const links = Object.fromEntries(Object.entries(cv.links).map(([k, v]) => [k.toLowerCase(), real(v)]));
  const firstName = p.firstName || first;
  const lastName = p.lastName || rest.filter((w) => !/todo/i.test(w)).join(' ');
  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    email: p.email || real(contact.email),
    phone: p.phone || real(contact.phone),
    city: p.city || locParts[0] || '',
    country: p.country || (locParts.length > 1 ? locParts[locParts.length - 1]! : ''),
    linkedin: p.linkedin || links.linkedin || '',
    github: p.github || links.github || '',
    website: p.website || links.website || links.portfolio || '',
    currentCompany: real(current?.company),
    currentTitle: real(current?.role),
  };
}

// ---------------------------------------------------------------- planning

const TEXTUAL: readonly FieldKind[] = ['text', 'email', 'tel', 'url', 'textarea', 'combobox'];

const PROFILE_RULES: Array<[RegExp, keyof Profile]> = [
  [/\bfirst\s*name\b|given name|שם פרטי|^имя$/i, 'firstName'],
  [/\blast\s*name\b|surname|family name|שם משפחה|фамилия/i, 'lastName'],
  [/^(full\s*)?name$|^your (full )?name$|שם מלא|^שם$|^ф\.?\s*и\.?\s*о/i, 'fullName'],
  [/e-?mail|דוא"?ל|דואר אלקטרוני|אימייל|почта/i, 'email'],
  [/phone|mobile|טלפון|נייד|телефон/i, 'phone'],
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/portfolio|website|personal site|blog/i, 'website'],
  [/current (company|employer|organi[sz]ation)|^company$|^organi[sz]ation$/i, 'currentCompany'],
  [/current (job )?(title|role|position)|^job title$/i, 'currentTitle'],
  [/^(city|location|current location|location \(city\))$|where are you (currently )?(located|based)|city of residence|עיר מגורים|מקום מגורים|^עיר$/i, 'city'],
  [/^country( of residence)?$/i, 'country'],
];

const DEMOGRAPHIC = /gender|sex\b|pronoun|race|ethnic|hispanic|latin[oax]|veteran|disabilit|sexual orientation|transgender|מגדר|מין/i;
const DECLINE_OPTION = /decline|prefer not|don'?t wish|do not wish|not to (say|answer|disclose)|rather not|i don'?t want/i;
const CONSENT = /privacy|consent|agree|terms|gdpr|data processing|acknowledge|מדיניות|הסכמה|מסכים|מסכימה/i;
const RESUME = /resume|r[ée]sum[ée]|\bcv\b|curriculum|קורות חיים|קו"ח|резюме/i;
const COVER = /cover\s*letter|motivation letter|מכתב מקדים|сопроводительн/i;

export interface Documents {
  cvPdf: string | null;
  letterPdf: string | null;
  letterText: string;
}

export interface PlanContext {
  job: Pick<JobRow, 'location' | 'title' | 'company'>;
  profile: Profile;
  answers: AnswersConfig;
  documents: Documents;
}

const answer = (f: FormField, value: string, source: PlannedAnswer['source'], detail?: string): PlannedAnswer => ({
  key: f.key,
  label: f.label,
  kind: f.kind,
  required: f.required,
  value,
  source: value ? source : 'none',
  detail,
});

/** Answer-bank entries whose phrases match the question and whose location filter fits the job. */
export function matchAnswerBank(label: string, ctx: PlanContext) {
  return ctx.answers.answers.find(
    (a) =>
      a.match.some((m) => containsKeyword(label, m)) &&
      (a.locations.length === 0 || a.locations.some((l) => containsKeyword(ctx.job.location, l))),
  );
}

/**
 * Everything answerable without a model, in priority order:
 * files → your answer bank → demographics policy → consent policy → profile fields → cover letter text.
 * Fields left with source "none" go to the model (unless detail says "ask-me" or "policy").
 */
export function planDeterministic(fields: FormField[], ctx: PlanContext): PlannedAnswer[] {
  return fields.map((f) => {
    const label = f.label;

    if (f.kind === 'file') {
      if (COVER.test(label)) return answer(f, ctx.documents.letterPdf ?? '', 'document', 'cover letter PDF');
      if (RESUME.test(label) || /attach/i.test(label) || f.name === 'resume') return answer(f, ctx.documents.cvPdf ?? '', 'document', 'CV PDF');
      return answer(f, '', 'none', 'policy: unknown file upload');
    }

    const bank = matchAnswerBank(label, ctx);
    if (bank) {
      return bank.answer.trim()
        ? answer(f, bank.answer.trim(), 'answer_bank', bank.id)
        : answer(f, '', 'none', `ask-me: answer bank "${bank.id}" says to ask you`);
    }

    if (DEMOGRAPHIC.test(label)) {
      if (ctx.answers.demographics === 'decline' && f.options.length) {
        const i = f.options.findIndex((o) => DECLINE_OPTION.test(o));
        if (i >= 0) return answer(f, f.options[i]!, 'demographics', 'declined to self-identify');
      }
      return answer(f, '', 'none', 'policy: demographic question left blank');
    }

    if (f.kind === 'checkbox' && f.options.length === 0 && CONSENT.test(label)) {
      return ctx.answers.consentToPrivacyPolicies
        ? answer(f, 'true', 'consent', 'consentToPrivacyPolicies')
        : answer(f, '', 'none', 'policy: consent is yours to give (consentToPrivacyPolicies is off)');
    }

    if (TEXTUAL.includes(f.kind) || f.kind === 'number') {
      for (const [re, key] of PROFILE_RULES) {
        if (re.test(label)) {
          let value = ctx.profile[key];
          // A city autocomplete lists namesakes worldwide; the country picks the right one.
          if (key === 'city' && f.kind === 'combobox' && value && ctx.profile.country && !containsKeyword(value, ctx.profile.country)) {
            value = `${value}, ${ctx.profile.country}`;
          }
          return value ? answer(f, value, 'profile', key) : answer(f, '', 'none', `profile.${key} is empty`);
        }
      }
      if (f.kind === 'textarea' && COVER.test(label)) return answer(f, ctx.documents.letterText, 'document', 'cover letter text');
    }

    return answer(f, '', 'none');
  });
}

/** Unanswered fields the model may try. Policy decisions and "ask me" answers are never sent. */
export function forModel(plan: PlannedAnswer[]): PlannedAnswer[] {
  return plan.filter((p) => p.source === 'none' && !/^(ask-me|policy)/.test(p.detail ?? '') && p.kind !== 'file');
}
