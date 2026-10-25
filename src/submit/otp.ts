import { convert } from 'html-to-text';
import type { ImapCredentials } from '../config.ts';
import { sleep } from '../util/limiter.ts';
import type { Logger } from '../util/logger.ts';

/*
 * Some ATSs (Greenhouse most often) email a one-time security code after you click Submit and only
 * accept the application once it's typed back in. The code goes to the email on the form, which is
 * the inbox Scout already reads for job alerts, so the Submitter can fetch it from there.
 */

export interface CodeSource {
  /** The newest code from a message received after `since`, or null when none arrives in time. */
  waitForCode(opts: { since: Date; timeoutMs: number }): Promise<string | null>;
}

/** Senders whose code emails we trust. Only applied to mail that arrives after the Submit click. */
export const CODE_SENDERS = ['greenhouse', 'ashbyhq', 'lever.co', 'workable'];

const NOT_A_CODE = /^(security|verification|application|password|please|submit|enter|below|field|your|code|this|that)$/i;

/** Pulls a one-time code out of an email's text, or null. A code has a digit or is 6+ capitals. */
export function extractCode(text: string): string | null {
  const looksLikeCode = (s: string) => !NOT_A_CODE.test(s) && (/\d/.test(s) || /^[A-Z]{6,}$/.test(s));
  const candidates: string[] = [];
  // "…code field on your application: X7kP2mQa", "Your verification code is 482913"
  for (const m of text.matchAll(/code\b[^\n]{0,80}?(?:\bis\b|:)\s*([A-Za-z0-9]{4,12})\b/gi)) candidates.push(m[1]!);
  // The code alone on a line, just after a line that mentions a code.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  lines.forEach((line, i) => {
    if (/^[A-Za-z0-9]{4,12}$/.test(line) && lines.slice(Math.max(0, i - 3), i).some((l) => /\bcode\b/i.test(l))) candidates.push(line);
  });
  return candidates.find(looksLikeCode) ?? null;
}

/** Greenhouse's code emails are HTML only. Images are skipped: their base64 data would read as text. */
function emailText(mail: { text?: string; html?: string | false }): string {
  if (mail.text?.trim()) return mail.text;
  if (!mail.html) return '';
  return convert(mail.html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  });
}

export function createImapCodeSource(credentials: ImapCredentials, logger: Logger, opts: { mailbox?: string; pollMs?: number } = {}): CodeSource {
  const mailbox = opts.mailbox ?? 'INBOX';
  const pollMs = opts.pollMs ?? 5000;

  async function newestCode(since: Date): Promise<string | null> {
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');
    const client = new ImapFlow({
      host: credentials.host,
      port: credentials.port,
      secure: true,
      auth: { user: credentials.user, pass: credentials.password },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        // IMAP "since" is day-granular; the exact cutoff is checked per message below.
        const uids = (await client.search({ since: new Date(since.getTime() - 86_400_000) }, { uid: true })) || [];
        let best: { at: number; code: string } | null = null;
        for await (const msg of client.fetch(uids.slice(-50), { source: true, envelope: true, internalDate: true }, { uid: true })) {
          const at = new Date(msg.internalDate ?? 0).getTime();
          const from = msg.envelope?.from?.map((a) => a.address ?? '').join(' ') ?? '';
          if (at < since.getTime() || !msg.source || !CODE_SENDERS.some((s) => from.toLowerCase().includes(s))) continue;
          const mail = await simpleParser(msg.source);
          const code = extractCode(`${mail.subject ?? ''}\n${emailText(mail)}`);
          if (code && (!best || at > best.at)) best = { at, code };
        }
        return best?.code ?? null;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  return {
    async waitForCode({ since, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const code = await newestCode(since);
          if (code) return code;
        } catch (err) {
          logger.warn(`could not read the inbox for a security code: ${(err as Error).message}`);
        }
        await sleep(pollMs);
      }
      return null;
    },
  };
}
