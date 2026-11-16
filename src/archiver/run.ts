import { CostMeter } from '../llm/cost.ts';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, imapCredentialsFromEnv, loadJsonFile, SourcesSchema, type ImapCredentials, type Paths } from '../config.ts';
import { JobStore, type ResponseRecord } from '../db/store.ts';
import { ollamaHasModel, ollamaModel } from '../llm/ollama.ts';
import { companyFromSender, emailBodyText, parseAppliedEmail, type RawEmail } from '../sources/applications.ts';
import type { Logger } from '../util/logger.ts';
import { normalizeCompany } from '../util/text.ts';
import { JOB_BOARDS } from '../sources/job-boards.ts';
import { classifyEmail, worthReading } from './classify.ts';
import { fileReply } from './record.ts';
import { buildReport, formatReport, groupApplications, matchApplication } from './report.ts';

/*
 * The Archiver: reads new email since its last run, has a local model sort replies about your
 * applications (rejection, assessment, interview, offer...), files each under its application, and
 * rewrites the report. Run it every hour; each run only reads mail that arrived since the last one.
 */

export interface ArchiverStats {
  checked: number;
  read: number;
  replies: number;
  matched: number;
  /** Applications you sent yourself, recorded from a reply because nothing else had recorded them. */
  recorded: number;
  failed: number;
  /** With --recheck: confirmations read again by today's rules, and how many turned out to be something else. */
  rechecked?: number;
  corrected?: number;
  /** With --recheck: emails the model didn't answer in time this run; another recheck tries them again. */
  notRead?: number;
  /** Emails given up on after several tries, filed as unread for you to open. */
  unread?: number;
}

/** An odd answer comes out the same every time, so three tries is plenty. */
export const MAX_TRIES = 3;
/** A timeout may be the machine's doing rather than the email's: it gets two more runs before the email is given up on. */
export const MAX_TIMEOUT_TRIES = 5;
/** Recorded as the reader of an email that was given up on: nobody read it. */
export const UNREAD = 'unread';

/**
 * What a failed read means. Ollama gone: stop, the email hasn't been tried. A timeout or an answer
 * that can't be used: this email is tried again on a later run, and the run goes on to the next one
 * (see TimeoutWatch for when it doesn't).
 */
export function afterFailure(message: string): 'stop' | 'timeout' | 'retry' {
  if (/isn't reachable/.test(message)) return 'stop';
  return /took longer than/.test(message) ? 'timeout' : 'retry';
}

/**
 * Tells one slow email from a stuck Ollama. Some emails make the model run on until the time limit,
 * every time: stopping the run for one of those would hold up all the mail behind it. Two timeouts in
 * a row, though, and the next email would only wait as long: the run stops there.
 */
export class TimeoutWatch {
  private inARow = 0;
  /** Call with each email's outcome; true when the run should stop. */
  stuck(outcome: 'done' | 'retry' | 'timeout' | 'stop'): boolean {
    this.inARow = outcome === 'timeout' ? this.inARow + 1 : 0;
    return this.inARow >= 2;
  }
}

/**
 * What is recorded for an email the model couldn't read after several tries: an update with a to-do,
 * so it shows under its application instead of vanishing. The company is the sender's, to file it by.
 */
export function unreadRecord(messageId: string, mail: RawEmail): Omit<ResponseRecord, 'id' | 'jobId'> {
  const applied = parseAppliedEmail(mail);
  return {
    messageId,
    receivedAt: mail.date.toISOString(),
    fromName: mail.fromName,
    fromAddress: mail.fromAddress,
    subject: mail.subject,
    kind: 'update',
    company: applied?.company || companyFromSender(mail.fromName),
    title: applied?.title ?? '',
    summary: "The local model couldn't read this email.",
    action: 'Open it in your inbox and read it yourself',
    model: UNREAD,
  };
}

/** Whether an email that failed again gets another run, after `tries` earlier ones. */
export const triesLeft = (outcome: 'timeout' | 'retry', tries: number) => tries + 1 < (outcome === 'timeout' ? MAX_TIMEOUT_TRIES : MAX_TRIES);

export interface ArchiverDeps {
  store: JobStore;
  credentials: ImapCredentials;
  mailbox: string;
  /** The Ollama model that reads the emails, e.g. "gemma3:12b". */
  model: string;
  logger: Logger;
  reportFile: string;
  /** How far back the first run reads, at most. */
  firstRunDays?: number;
  /** Go back over this many days of mail: read what was never recorded, and read rule-sorted confirmations again. */
  recheckDays?: number;
  /** Records the local model's calls (tokens and time; they cost nothing) with this run. */
  meter?: CostMeter;
  now?: () => Date;
}

/** One Archiver run with your settings: the command line, the hourly schedule and LangGraph all call this. */
export async function archive(paths: Paths, logger: Logger, opts: { recheckDays?: number } = {}): Promise<ArchiverStats> {
  const credentials = imapCredentialsFromEnv();
  if (!credentials) throw new ConfigError('The Archiver reads your email: set IMAP_USER and IMAP_PASSWORD in .env');
  // Your email is only ever read by a local model, never sent to Claude.
  const model = ollamaModel(process.env.ARCHIVER_MODEL ?? 'ollama:gemma3:12b');
  if (!model) throw new ConfigError('ARCHIVER_MODEL must be a local model, e.g. ollama:gemma3:12b: your email stays on this Mac');
  if (!(await ollamaHasModel(model))) throw new ConfigError(`Ollama isn't running or doesn't have ${model}. Start it with "brew services start ollama", then "ollama pull ${model}"`);
  const { mailbox } = loadJsonFile(paths.sources, SourcesSchema).emailAlerts;
  const store = new JobStore(paths.db);
  try {
    return await runArchiver({ store, credentials, mailbox, model, logger, reportFile: path.join(path.dirname(paths.db), 'applications-report.md'), meter: new CostMeter('archiver'), recheckDays: opts.recheckDays });
  } finally {
    store.close();
  }
}

export async function runArchiver(deps: ArchiverDeps): Promise<ArchiverStats> {
  const { store, credentials, mailbox, model, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const stats: ArchiverStats = { checked: 0, read: 0, replies: 0, matched: 0, recorded: 0, failed: 0 };
  const runId = store.startRun('archiver', now().toISOString());
  deps.meter?.attach(store, runId);
  try {
    for (const job of store.archiveStale(14, now())) logger.info(`Archiver: #${job.id} ${job.company} — ${job.title} wasn't sent and hasn't changed in 14 days: moved to the archive`);
    await readNewMail(deps, stats);
    // Applications recorded after a reply arrived (Scout reads confirmations on its own schedule)
    // get their earlier replies now; a reply still without one records the application itself.
    let rows = groupApplications(store.sentApplications());
    for (const r of store.responses().filter((x) => x.jobId === null)) {
      const { jobId, created } = fileReply(store, r, rows, now().toISOString());
      if (created) {
        rows = groupApplications(store.sentApplications());
        stats.recorded++;
      }
      if (jobId !== null) store.setResponseJob(r.id, jobId);
    }
    const report = buildReport(store.sentApplications(), store.responses(), now());
    writeFileSync(deps.reportFile, formatReport(report, now()));
    const s = report.stats;
    logger.info(
      `Archiver: ${stats.checked} new emails, ${stats.read} read, ${stats.replies} about your applications (${stats.matched} matched, ${stats.recorded} applications recorded from email)` +
        ` · ${s.applied} applied, ${s.interview} interview, ${s.assessment} assessment, ${s.offer} offer, ${s.rejected} rejected, ${s.awaiting + s.viewed} waiting`,
    );
    return stats;
  } finally {
    deps.meter?.detach();
    store.finishRun(runId, stats, now().toISOString());
  }
}

async function readNewMail(deps: ArchiverDeps, stats: ArchiverStats): Promise<void> {
  const { store, credentials, mailbox, model, logger } = deps;
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const key = `archiver:${credentials.user}:${mailbox}`;
  const mark = JSON.parse(store.getKv(key) ?? 'null') as { uidValidity: string; lastUid: number } | null;
  const apps = store.sentApplications();
  let rows = groupApplications(apps);
  const companies = [...new Set(apps.map((a) => normalizeCompany(a.job.company)).filter((c) => c.length >= 3))];

  const client = new ImapFlow({ host: credentials.host, port: credentials.port, secure: true, auth: { user: credentials.user, pass: credentials.password }, logger: false });
  // A dropped connection also rejects the pending call; without a listener the 'error' event kills the process.
  client.on('error', (err: Error) => logger.debug(`Archiver IMAP: ${err.message}`));
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const box = client.mailbox;
      const uidValidity = String(box && typeof box === 'object' ? box.uidValidity : '');
      let uids: number[];
      if (mark && mark.uidValidity === uidValidity) {
        uids = ((await client.search({ uid: `${mark.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > mark.lastUid);
      } else {
        // First run: back to your earliest application, at most `firstRunDays`.
        const earliest = apps.map((a) => Date.parse(a.appliedAt)).sort((a, b) => a - b)[0] ?? Date.now();
        const since = new Date(Math.max(earliest - 2 * 86_400_000, Date.now() - (deps.firstRunDays ?? 90) * 86_400_000));
        uids = (await client.search({ since }, { uid: true })) || [];
        logger.info(`Archiver: first run, reading mail since ${since.toISOString().slice(0, 10)}`);
      }
      uids.sort((a, b) => a - b);

      // A job board the Archiver has learned to read since its last run: its earlier mail was passed
      // over then, so go back for it once. (A first run reads everything anyway.)
      const boardsKey = `${key}:boards`;
      const boardsRead = new Set(JSON.parse(store.getKv(boardsKey) ?? '[]') as string[]);
      const earlier = new Set<number>();
      if (mark && mark.uidValidity === uidValidity) {
        const since = new Date(Date.now() - (deps.firstRunDays ?? 90) * 86_400_000);
        for (const board of JOB_BOARDS.filter((b) => !boardsRead.has(b.id))) {
          const found = ((await client.search({ since, from: board.search }, { uid: true })) || []).filter((u) => u <= mark.lastUid);
          found.forEach((u) => earlier.add(u));
          if (found.length) logger.info(`Archiver: going back over ${found.length} earlier email(s) from ${board.label}`);
        }
      }
      // Asked to go back over recent mail: everything in the window is looked at again below.
      if (deps.recheckDays && mark && mark.uidValidity === uidValidity) {
        const since = new Date(Date.now() - deps.recheckDays * 86_400_000);
        const found = ((await client.search({ since }, { uid: true })) || []).filter((u) => u <= mark.lastUid);
        found.forEach((u) => earlier.add(u));
        logger.info(`Archiver: going back over ${found.length} email(s) from the last ${deps.recheckDays} days`);
      }
      stats.checked = uids.length + earlier.size;

      // Sender and subject first (cheap), then the full email only for likely ones.
      const wanted: Array<{ uid: number; messageId: string }> = [];
      for await (const msg of uids.length ? client.fetch(uids, { envelope: true }, { uid: true }) : []) {
        const from = msg.envelope?.from?.[0];
        const env = { fromName: from?.name ?? '', fromAddress: from?.address ?? '', subject: msg.envelope?.subject ?? '' };
        const messageId = msg.envelope?.messageId || `${uidValidity}:${msg.uid}`;
        if (worthReading(env, companies, credentials.user) && !store.hasResponse(messageId)) wanted.push({ uid: msg.uid, messageId });
      }
      if (uids.length) logger.info(`Archiver: ${uids.length} new emails, ${wanted.length} look like replies about applications`);
      // The earlier job-board emails, by the same test; read after any retries, without moving the bookmark.
      const backlog: Array<{ uid: number; messageId: string }> = [];
      // Confirmations the rules filed without the model reading them: read again when asked to recheck.
      const recheck: Array<{ uid: number; responseId: number; was: string }> = [];
      for await (const msg of earlier.size ? client.fetch([...earlier].sort((a, b) => a - b), { envelope: true }, { uid: true }) : []) {
        const from = msg.envelope?.from?.[0];
        const env = { fromName: from?.name ?? '', fromAddress: from?.address ?? '', subject: msg.envelope?.subject ?? '' };
        const messageId = msg.envelope?.messageId || `${uidValidity}:${msg.uid}`;
        const before = store.responseReading(messageId);
        if (!before && worthReading(env, companies, credentials.user)) backlog.push({ uid: msg.uid, messageId });
        else if (deps.recheckDays && before && ((before.model === 'rules' && before.kind === 'confirmation') || before.model === UNREAD)) recheck.push({ uid: msg.uid, responseId: before.id, was: before.model });
      }

      const advance = (upTo: number) => store.setKv(key, JSON.stringify({ uidValidity, lastUid: upTo }));
      // Emails the model couldn't answer last run, tried again (see MAX_TRIES and MAX_TIMEOUT_TRIES).
      const retryKey = `${key}:retry`;
      const retries = (JSON.parse(store.getKv(retryKey) ?? '[]') as Array<{ uid: number; messageId: string; tries: number }>).filter(
        (r) => !store.hasResponse(r.messageId),
      );
      const later: typeof retries = [];
      const handled = new Set<number>();
      const fetchMail = async (uid: number): Promise<RawEmail | null> => {
        const msg = await client.fetchOne(String(uid), { source: true, envelope: true, internalDate: true }, { uid: true });
        if (!msg || !msg.source) return null;
        const parsed = await simpleParser(msg.source);
        const from = msg.envelope?.from?.[0];
        return {
          fromName: from?.name ?? '',
          fromAddress: from?.address ?? '',
          subject: parsed.subject ?? '',
          text: parsed.text ?? '',
          html: typeof parsed.html === 'string' ? parsed.html : '',
          date: parsed.date ?? new Date(msg.internalDate ?? Date.now()),
        };
      };
      const read = async (item: { uid: number; messageId: string }): Promise<'done' | 'retry' | 'timeout' | 'stop'> => {
        const mail = await fetchMail(item.uid);
        if (!mail) return 'done';
        let c;
        try {
          c = await classifyEmail(mail, emailBodyText(mail.text, mail.html), model, deps.meter);
        } catch (err) {
          stats.failed++;
          const message = (err as Error).message;
          logger.warn(`Archiver: couldn't read "${mail.subject}": ${message}`);
          // Ollama down: stop, and carry on from this email next run. A slow or odd answer: skip it for now.
          return afterFailure(message);
        }
        stats.read++;
        const record = {
          messageId: item.messageId,
          receivedAt: mail.date.toISOString(),
          fromName: mail.fromName,
          fromAddress: mail.fromAddress,
          subject: mail.subject,
          kind: c.kind,
          company: c.company,
          title: c.title,
          summary: c.summary,
          action: c.action,
          model: c.model,
        };
        const { jobId, created } = fileReply(store, record, rows, new Date().toISOString());
        if (created) {
          rows = groupApplications(store.sentApplications());
          stats.recorded++;
        }
        store.saveResponse({ ...record, jobId }, new Date().toISOString());
        if (c.kind !== 'not_related') {
          stats.replies++;
          if (jobId !== null) stats.matched++;
          const where = jobId === null ? ' (no matching application)' : created ? ` → #${jobId}, recorded from this email` : ` → #${jobId}`;
          logger.info(`Archiver: ${c.kind} · ${c.company || mail.fromName} — ${c.title || mail.subject}${where}`);
        }
        return 'done';
      };

      // Two timeouts in a row mean Ollama is stuck; one means that email is slow, and the rest go on.
      const watch = new TimeoutWatch();
      // An email that keeps failing is not dropped: it is filed as unread, for you to open.
      const giveUp = async (item: { uid: number; messageId: string }, tries: number) => {
        const mail = await fetchMail(item.uid);
        if (!mail || store.hasResponse(item.messageId)) return;
        const record = unreadRecord(item.messageId, mail);
        // Only under an application that exists: an email nobody read is no ground for recording a new one.
        const jobId = matchApplication(record, rows);
        store.saveResponse({ ...record, jobId }, new Date().toISOString());
        stats.unread = (stats.unread ?? 0) + 1;
        logger.warn(`Archiver: couldn't read "${mail.subject}" in ${tries} tries. It is filed as unread${jobId === null ? '' : ` under #${jobId}`}: open it in your inbox.`);
      };

      try {
        for (const r of retries) {
          const outcome = await read(r);
          if (outcome === 'stop') return;
          handled.add(r.uid);
          if (outcome !== 'done') {
            if (triesLeft(outcome, r.tries)) later.push({ ...r, tries: r.tries + 1 });
            else await giveUp(r, r.tries + 1);
          }
          if (watch.stuck(outcome)) return;
        }
        for (const item of backlog) {
          const outcome = await read(item);
          if (outcome === 'stop') return;
          if (outcome !== 'done') later.push({ ...item, tries: 1 });
          if (watch.stuck(outcome)) return;
        }
        // Every board's earlier mail has been gone over: not again.
        store.setKv(boardsKey, JSON.stringify(JOB_BOARDS.map((b) => b.id)));
        for (const uid of uids) {
          const item = wanted.find((w) => w.uid === uid);
          let stuck = false;
          if (item) {
            const outcome = await read(item);
            if (outcome === 'stop') return;
            if (outcome !== 'done') later.push({ ...item, tries: 1 });
            stuck = watch.stuck(outcome);
          }
          // An email that failed is on the retry list: move past it, so newer mail isn't held up behind it.
          advance(uid);
          if (stuck) return;
        }
        for (const item of recheck) {
          const mail = await fetchMail(item.uid);
          if (!mail) continue;
          stats.rechecked = (stats.rechecked ?? 0) + 1;
          let c;
          try {
            c = await classifyEmail(mail, emailBodyText(mail.text, mail.html), model, deps.meter);
          } catch (err) {
            const message = (err as Error).message;
            logger.warn(`Archiver: couldn't read "${mail.subject}" again: ${message}`);
            const outcome = afterFailure(message);
            // Ollama gone or stuck: the rest can be read again another time. One slow email: on to the next.
            if (outcome === 'stop' || watch.stuck(outcome)) return;
            stats.notRead = (stats.notRead ?? 0) + 1;
            continue;
          }
          watch.stuck('done');
          const wasUnread = item.was === UNREAD;
          // Still a receipt by the rules, and it was one before: nothing was read, nothing to note.
          if (c.model === 'rules' && !wasUnread) continue;
          if (wasUnread || (c.kind !== 'confirmation' && c.kind !== 'not_related')) {
            store.updateResponseReading(item.responseId, c);
            stats.corrected = (stats.corrected ?? 0) + 1;
            logger.info(`Archiver: read again, was ${wasUnread ? 'unread' : 'filed as a confirmation'}: ${c.kind} · ${c.company || mail.fromName} — ${c.title || mail.subject}`);
          } else {
            // The model read it and it is a receipt: note who read it, so it isn't read a third time.
            store.setResponseModel(item.responseId, c.model);
          }
        }
      } finally {
        // Retries not reached this run stay on the list.
        store.setKv(retryKey, JSON.stringify([...later, ...retries.filter((r) => !handled.has(r.uid))]));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
