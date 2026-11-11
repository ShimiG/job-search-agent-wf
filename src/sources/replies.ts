import { createHash } from 'node:crypto';
import { emailBodyText, type RawEmail } from './applications.ts';

/*
 * Replies to applications you sent: interview invitations, take-home assignments, offers and
 * rejections, in English and Hebrew. Read from the same inbox as the confirmations, so the review
 * page can show which applications got a callback, and from which sources, score bands and methods.
 *
 * Deliberately conservative: a sentence only counts when it states the outcome. "If you're selected,
 * we'll schedule an interview" in a confirmation is a promise, not an invitation, so conditional
 * sentences are skipped.
 */

export type ReplyKind = 'interview' | 'assessment' | 'offer' | 'rejection';

export interface ReplyEmail {
  kind: ReplyKind;
  fromName: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  /** Message-ID, or a hash of sender, subject and date: recording the same email twice is a no-op. */
  messageKey: string;
  /** Only when the email names them in a fixed format (LinkedIn's "Your application to X at Y"). */
  company?: string;
  title?: string;
  /** The start of the body, for matching the company when the sender is an ATS. */
  excerpt: string;
}

const REJECTION = [
  /decided to (?:move forward|proceed|pursue|continue|go forward) with (?:other|another|a different)/i,
  /(?:decided|chosen|chose) not to (?:move|proceed|continue|go) (?:forward|further|ahead)/i,
  /not (?:to )?(?:move|moving|proceed|proceeding) (?:forward|further) with (?:your|you)/i,
  /will not be (?:moving|proceeding|taking)/i,
  /other candidates whose/i,
  /(?:position|role) has (?:already )?been (?:filled|closed)/i,
  /regret to inform/i,
  /won['’]t be (?:moving|proceeding) (?:forward|further|ahead)/i,
  /(?:unable|not able) to (?:offer you|move forward with|proceed with) (?:the|your|you)/i,
  /unfortunately,? (?:after careful|at this (?:time|stage),? we (?:have|will|are not|won)|your (?:application|profile) (?:was|has|is) not)/i,
  // "לצערנו" alone also opens "we can't reply to every candidate": it needs an outcome with it.
  /לצערנו.*(?:החלטנו|לא (?:נוכל להתקדם|נוכל להמשיך|נמשיך|נתקדם)|מועמד(?:ים|ות)? (?:אחר|אחרים|אחרות)|לא נמצאה התאמה|(?:אינך|אינו|אינה) מתאימ|המשרה (?:אוישה|נסגרה))/,
  /לא נמצאה התאמה/,
  /החלטנו (?:שלא )?להתקדם עם (?:מועמד|מועמדים|מועמדות) (?:אחר|אחרים|אחרות)/,
  /(?:לא נוכל|החלטנו שלא|הוחלט שלא) (?:להתקדם|להמשיך)/,
  /המשרה (?:אוישה|נסגרה)/,
];

const OFFER = [
  /(?:pleased|happy|delighted|excited|thrilled) to (?:extend|offer you)/i,
  /\boffer letter\b/i,
  /(?:formal|official|our) (?:job )?offer (?:for|to join)/i,
  /הצעת (?:עבודה|שכר)/,
  /(?:שמחים|שמחה) להציע לך/,
];

const ASSESSMENT = [
  /home[- ]?(?:assignment|assessment|task|exercise)|take[- ]home/i,
  /(?:coding|technical|online) (?:challenge|assessment|test|exercise)/i,
  /\b(?:hackerrank|codility|codesignal|testgorilla|coderbyte|hirevue)\b/i,
  /מטלת בית|מטלה (?:מקצועית|ביתית)|מבחן (?:בית|מקוון|טכני)/,
];

const INTERVIEW = [
  /(?:schedule|book|arrange|set up|coordinate) (?:a |an |the )?(?:call|interview|time|meeting|chat|conversation|phone screen)/i,
  /invit(?:e|ing) you (?:to|for) (?:a |an |our )?(?:\w+ )?(?:interview|call|conversation|meeting|chat)/i,
  /(?:would|'d) (?:like|love) to (?:invite you|schedule|set up|speak|talk|meet|chat|get to know)/i,
  /(?:share|send|let (?:me|us) know) your availability|what (?:times|days) (?:work|suit)/i,
  /\b(?:calendly\.com|cal\.com\/|goodtime\.io)/i,
  /next (?:step|stage|round) (?:is|will be|would be) (?:a |an )?(?:\w+ )?(?:interview|call|conversation)/i,
  /זימון לראיון|הזמנה לראיון/,
  /(?:נשמח|אשמח) (?:לקבוע|לתאם|להזמין|לדבר|לשוחח|להכיר)/,
  /לתאם (?:ראיון|שיחה|פגישה)|שיחת (?:היכרות|טלפון)|ראיון (?:טלפוני|ראשון|טכני|עבודה)/,
];

/** A sentence that only says what might happen ("if selected, we'll contact you") isn't an outcome. */
const CONDITIONAL = /\b(?:if|should|once|whether|in case|may|might|unless)\b|(?:^|\s)(?:אם|במידה|ככל ש|באם|בהמשך ייתכן)/i;

/** Senders that send job alerts and marketing, not replies about your application. */
const NOT_A_REPLY = /(^|\.)(indeed\.com|drushim\.co\.il|alljobs\.co\.il|glassdoor\.com|ziprecruiter\.com)$/i;

const clean = (s: string) => s.replace(/[\s ​-‏]+/g, ' ').trim();

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(clean)
    .filter((s) => s.length > 3);
}

const stated = (all: string[], patterns: RegExp[]) => all.some((s) => !CONDITIONAL.test(s) && patterns.some((p) => p.test(s)));

/** The outcome an email states, most decisive first: a rejection that mentions "interviews" is still a rejection. */
export function classifyReply(subject: string, body: string): ReplyKind | null {
  const all = sentences(`${subject}\n${body.slice(0, 4000)}`);
  // Rejections are often phrased conditionally-adjacent ("we have decided..."): only "if" disqualifies them.
  if (all.some((s) => !/\bif\b|(?:^|\s)אם\s/i.test(s) && REJECTION.some((p) => p.test(s)))) return 'rejection';
  if (stated(all, OFFER)) return 'offer';
  if (stated(all, ASSESSMENT)) return 'assessment';
  if (stated(all, INTERVIEW)) return 'interview';
  return null;
}

export function messageKey(mail: Pick<RawEmail, 'fromAddress' | 'subject' | 'date'> & { messageId?: string }): string {
  if (mail.messageId) return mail.messageId.trim();
  return createHash('sha256').update(`${mail.fromAddress}\u0000${mail.subject}\u0000${mail.date.toISOString()}`).digest('hex').slice(0, 24);
}

export function parseReplyEmail(mail: RawEmail & { messageId?: string }): ReplyEmail | null {
  if (NOT_A_REPLY.test(mail.fromAddress.split('@')[1] ?? '')) return null;
  const subject = clean(mail.subject);
  let company: string | undefined;
  let title: string | undefined;
  // LinkedIn only sends status updates about your application in this one format; the rest is alerts and messages.
  if (/(^|\.)linkedin\.com$/i.test(mail.fromAddress.split('@')[1] ?? '')) {
    const m = /^your application to (.+?) at (.+)$/i.exec(subject);
    if (!m) return null;
    [title, company] = [clean(m[1]!), clean(m[2]!)];
  }
  const text = emailBodyText(mail.text, mail.html);
  const kind = classifyReply(subject, text);
  if (!kind) return null;
  return {
    kind,
    fromName: clean(mail.fromName),
    fromAddress: mail.fromAddress.toLowerCase(),
    subject,
    receivedAt: mail.date.toISOString(),
    messageKey: messageKey(mail),
    ...(company ? { company, title } : {}),
    excerpt: clean(text).slice(0, 1500),
  };
}
