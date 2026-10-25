import { convert } from 'html-to-text';
import type { ImapCredentials, SourcesConfig } from '../config.ts';
import { normalizeForMatch } from '../util/text.ts';

/*
 * Applications you sent yourself (LinkedIn Easy Apply, Indeed, a company's careers page) each leave
 * a confirmation email. Reading them lets Scout mark those jobs as applied, so they never come back
 * on your shortlist and the Submitter's per-company limit counts them.
 */

export interface AppliedEmail {
  company: string;
  title: string;
  /** LinkedIn's job ID, when the email links to the job. Matches alert-email jobs exactly. */
  linkedinId?: string;
  via: 'linkedin' | 'indeed' | 'company';
  appliedAt: string;
  rejected: boolean;
  subject: string;
}

export interface RawEmail {
  fromName: string;
  fromAddress: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
}

/** Phrases that only appear in a confirmation, rejection or status update for an application you sent. */
const APPLIED =
  /thank(?:s| you)(?: so much| very much)? for (?:applying|your (?:job )?application|taking the time to apply)|your application (?:was sent|was viewed|has been (?:submitted|received)|is in)|received your application|indeed application:|we(?:'|’)ve got your cv|thanks for applying/i;
const REJECTED =
  /decided to (?:move forward|proceed|pursue|continue) with other|not (?:to )?(?:move|moving) forward with your|will not be (?:moving|proceeding)|other candidates whose/i;
/** Display names that are a platform, not the hiring company. */
const PLATFORM_NAME = /^(linkedin|indeed( apply)?|greenhouse|lever|ashby|workable|comeet|bamboohr|teamtailor|no[- ]?reply|notifications?|careers?|jobs|recruiting|talent( acquisition)?|hr)$/i;

const clean = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/[\s ​-‏]+/g, ' ').trim();
const tidy = (s: string) => clean(s).replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,!:;]+$/g, '');

export function emailBodyText(text: string, html: string): string {
  if (text.trim()) return text;
  if (!html) return '';
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  });
}

/** The hiring company from the sender's name: "Mize", "EY Talent Acquisition", "Anna Korzh - Online Doctor AG". */
function companyFromSender(name: string): string {
  const display = tidy(name.includes(' - ') ? name.split(' - ').pop()! : name).replace(
    /\s+(?:talent acquisition|people (?:&|and) talent|recruiting|recruitment|careers|hiring team|hr|jobs)(?: team)?$/i,
    '',
  );
  // A person's name ("Reut Levin") or a platform ("LinkedIn") is not the hiring company.
  if (!display || PLATFORM_NAME.test(display) || /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(display)) return '';
  return display;
}

/** Cuts trailing calls to action ("eTeacher Group- Please complete…") and unclosed brackets. */
function trimName(s: string): string {
  return tidy(
    s
      .replace(/(?:\s[-–—]|-)\s*(?:please|complete|next|your|we|thank)\b.*$/i, '')
      .replace(/\s*\([^)]*$/, ''),
  );
}

export function parseAppliedEmail(mail: RawEmail): AppliedEmail | null {
  const body = clean(emailBodyText(mail.text, mail.html));
  const head = `${mail.subject}\n${body.slice(0, 1500)}`;
  if (!APPLIED.test(head)) return null;
  const subject = clean(mail.subject);
  const base = { appliedAt: mail.date.toISOString(), rejected: REJECTED.test(body), subject };
  const lines = emailBodyText(mail.text, mail.html).split(/\r?\n/).map(clean).filter(Boolean);
  const linkedinId = /linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/.exec(`${mail.html}\n${mail.text}`)?.[1];

  // LinkedIn: "Dana, your application was sent to Acme" / body: title on the line after.
  if (/linkedin\.com$/i.test(mail.fromAddress)) {
    const m = /your application was (?:sent to|viewed by) (.+)$/i.exec(subject);
    if (!m) return null;
    const company = tidy(m[1]!);
    const at = lines.findIndex((l) => /^your application was sent to/i.test(l));
    const title = at >= 0 && lines[at + 1] && tidy(lines[at + 1]!) !== company ? tidy(lines[at + 1]!) : '';
    return { ...base, via: 'linkedin', company, title, linkedinId };
  }

  // Indeed: "Indeed Application: AI Solution Manager". The company isn't in the email.
  if (/indeed\.com$/i.test(mail.fromAddress)) {
    const m = /^indeed application:\s*(.+)$/i.exec(subject);
    return m ? { ...base, via: 'indeed', company: '', title: tidy(m[1]!) } : null;
  }

  // Company careers pages and their ATSs, in the wordings they use. Earlier patterns are more specific.
  let title = '';
  let company = '';
  const patterns: Array<{ re: RegExp; order: 'tc' | 'ct' | 'c' | 't'; subjectOnly?: boolean }> = [
    // "…for the AI Builder position at Grain", "applying AI Solution Manager position at WSC Sports"
    { re: /(?:for|to|applying)\s+(?:the |a |an )?(.+?) (?:position|role|job|opening) at ([^.!\n]+)/i, order: 'tc' },
    // "Thanks for applying for AI Engineer at yad2", "applying for a AI Solutions Architect to Cast AI"
    { re: /applying for (?:a |an |the )?(.+?) (?:to|at|with) ([^.!\n]+)$/im, order: 'tc' },
    // "Touchdown! LSports Received Your Application for AI Business Automation Engineer"
    { re: /(?:^|[!.:]\s*)([A-Z][^!.:\n]{1,40}?) received your application for (?:the )?(.+?)(?:\s+(?:position|role))?$/im, order: 'ct', subjectOnly: true },
    // "Thank you for applying to Canonical", "…applying with Qualitest", "…your interest in EY and the…"
    { re: /thank(?:s| you)(?: so much| very much)? for (?:applying|your application|your interest)\s+(?:to|at|with|in)\s+(?:joining\s+)?([^.!\n,]+?)(?:\s+and\b|[.!,]|$)/im, order: 'c' },
    // "your application for the Forward Deployed Engineer position", "…and the Junior Technology Consultant role"
    { re: /application for (?:the )?(.+?) (?:position|role)\b/i, order: 't' },
    { re: /\bthe ([^.!\n]{3,80}?) (?:role|position)\b/i, order: 't' },
    // "We Got It: Thanks for applying for AI Product Specialist", "review your application for X shortly"
    { re: /applying for (?:the )?(?!a position\b)(.+?)(?: (?:position|role))?(?:[.!(]|$)/im, order: 't' },
    { re: /(?:apply|application) for (?:the )?(.+?)(?: (?:position|role))?(?: shortly| and |[.!,(]|$)/im, order: 't' },
  ];
  for (const [i, text] of [subject, body.slice(0, 1500)].entries()) {
    for (const { re, order, subjectOnly } of patterns) {
      if (subjectOnly && i > 0) continue;
      const m = re.exec(text);
      if (!m) continue;
      if (order === 'tc') [title, company] = [title || m[1]!, company || m[2]!];
      else if (order === 'ct') [company, title] = [company || m[1]!, title || m[2]!];
      else if (order === 'c') company ||= m[1]!;
      else title ||= m[1]!;
    }
  }
  // Company names don't contain " – " or " | ": what follows is a tagline ("WSC Sports – Stay in the Game").
  company = trimName(company.replace(/\s[–—|]\s.*$/, ''));
  // "the following privacy policies" is a phrase, not a company.
  if (/^the\s/.test(company)) company = '';
  company ||= companyFromSender(mail.fromName);
  // Matches start at the first "for"/"to", so titles can carry the sentence in front of them.
  title = trimName(title)
    .replace(/^(?:.*?\b)?(?:applying|apply|application)\s+(?:(?:for|to)\s+)?(?:the |a |an )?/i, '')
    .replace(new RegExp(`\\s+at\\s+${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '');
  if (/^(?:a|an|the|this|that|our|your)$/i.test(title)) title = '';
  if (/^(?:a |an |the )?(?:position|role|job|opening)$/i.test(title) || title.length > 120 || normalizeForMatch(title) === normalizeForMatch(company)) {
    title = '';
  }
  if (!company && !title) return null;
  return { ...base, via: 'company', company, title };
}

/** What Scout calls each run, or undefined when email reading or application tracking is off. */
export function appliedEmailsSource(
  emailAlerts: SourcesConfig['emailAlerts'],
  credentials: ImapCredentials | null,
): (() => Promise<AppliedEmail[]>) | undefined {
  if (!emailAlerts.enabled || !emailAlerts.trackApplications || !credentials) return undefined;
  return () => fetchAppliedEmails(credentials, { mailbox: emailAlerts.mailbox, sinceDays: emailAlerts.applicationsSinceDays });
}

/** Confirmation emails from the last `sinceDays` days. Searches are narrow, so this stays cheap. */
export async function fetchAppliedEmails(credentials: ImapCredentials, opts: { mailbox: string; sinceDays: number }): Promise<AppliedEmail[]> {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: { user: credentials.user, pass: credentials.password },
    logger: false,
  });
  const since = new Date(Date.now() - opts.sinceDays * 86_400_000);
  const found: AppliedEmail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(opts.mailbox, { readOnly: true });
    try {
      const uids = new Set<number>();
      for (const query of [{ subject: 'application' }, { subject: 'applying' }, { body: 'received your application' }, { body: 'for applying' }]) {
        for (const uid of (await client.search({ since, ...query }, { uid: true })) || []) uids.add(uid);
      }
      if (uids.size === 0) return found;
      for await (const msg of client.fetch([...uids], { source: true, envelope: true, internalDate: true }, { uid: true })) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const from = msg.envelope?.from?.[0];
        const parsed = parseAppliedEmail({
          fromName: from?.name ?? '',
          fromAddress: from?.address ?? '',
          subject: mail.subject ?? '',
          text: mail.text ?? '',
          html: typeof mail.html === 'string' ? mail.html : '',
          date: mail.date ?? new Date(msg.internalDate ?? Date.now()),
        });
        if (parsed) found.push(parsed);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return found;
}
