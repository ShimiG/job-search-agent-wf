import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, imapCredentialsFromEnv, loadJsonFile, SourcesSchema, type ImapCredentials, type Paths } from '../config.ts';
import { JobStore } from '../db/store.ts';
import { ollamaHasModel, ollamaModel } from '../llm/ollama.ts';
import { emailBodyText, type RawEmail } from '../sources/applications.ts';
import type { Logger } from '../util/logger.ts';
import { normalizeCompany } from '../util/text.ts';
import { JOB_BOARDS } from '../sources/job-boards.ts';
import { classifyEmail, worthReading } from './classify.ts';
import { fileReply } from './record.ts';
import { buildReport, formatReport, groupApplications } from './report.ts';

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
}

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
  now?: () => Date;
}

/** One Archiver run with your settings: the command line, the hourly schedule and LangGraph all call this. */
export async function archive(paths: Paths, logger: Logger): Promise<ArchiverStats> {
  const credentials = imapCredentialsFromEnv();
  if (!credentials) throw new ConfigError('The Archiver reads your email: set IMAP_USER and IMAP_PASSWORD in .env');
  // Your email is only ever read by a local model, never sent to Claude.
  const model = ollamaModel(process.env.ARCHIVER_MODEL ?? 'ollama:gemma3:12b');
  if (!model) throw new ConfigError('ARCHIVER_MODEL must be a local model, e.g. ollama:gemma3:12b: your email stays on this Mac');
  if (!(await ollamaHasModel(model))) throw new ConfigError(`Ollama isn't running or doesn't have ${model}. Start it with "brew services start ollama", then "ollama pull ${model}"`);
  const { mailbox } = loadJsonFile(paths.sources, SourcesSchema).emailAlerts;
  const store = new JobStore(paths.db);
  try {
    return await runArchiver({ store, credentials, mailbox, model, logger, reportFile: path.join(path.dirname(paths.db), 'applications-report.md') });
  } finally {
    store.close();
  }
}

export async function runArchiver(deps: ArchiverDeps): Promise<ArchiverStats> {
  const { store, credentials, mailbox, model, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const stats: ArchiverStats = { checked: 0, read: 0, replies: 0, matched: 0, recorded: 0, failed: 0 };
  const runId = store.startRun('archiver', now().toISOString());
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
      for await (const msg of earlier.size ? client.fetch([...earlier].sort((a, b) => a - b), { envelope: true }, { uid: true }) : []) {
        const from = msg.envelope?.from?.[0];
        const env = { fromName: from?.name ?? '', fromAddress: from?.address ?? '', subject: msg.envelope?.subject ?? '' };
        const messageId = msg.envelope?.messageId || `${uidValidity}:${msg.uid}`;
        if (worthReading(env, companies, credentials.user) && !store.hasResponse(messageId)) backlog.push({ uid: msg.uid, messageId });
      }

      const advance = (upTo: number) => store.setKv(key, JSON.stringify({ uidValidity, lastUid: upTo }));
      // Emails the model couldn't answer in time last run, tried again (three tries in all).
      const retryKey = `${key}:retry`;
      const retries = (JSON.parse(store.getKv(retryKey) ?? '[]') as Array<{ uid: number; messageId: string; tries: number }>).filter(
        (r) => !store.hasResponse(r.messageId),
      );
      const later: typeof retries = [];
      const handled = new Set<number>();
      const read = async (item: { uid: number; messageId: string }): Promise<'done' | 'retry' | 'stop'> => {
        const msg = await client.fetchOne(String(item.uid), { source: true, envelope: true, internalDate: true }, { uid: true });
        if (!msg || !msg.source) return 'done';
        const parsed = await simpleParser(msg.source);
        const from = msg.envelope?.from?.[0];
        const mail: RawEmail = {
          fromName: from?.name ?? '',
          fromAddress: from?.address ?? '',
          subject: parsed.subject ?? '',
          text: parsed.text ?? '',
          html: typeof parsed.html === 'string' ? parsed.html : '',
          date: parsed.date ?? new Date(msg.internalDate ?? Date.now()),
        };
        let c;
        try {
          c = await classifyEmail(mail, emailBodyText(mail.text, mail.html), model);
        } catch (err) {
          stats.failed++;
          const message = (err as Error).message;
          logger.warn(`Archiver: couldn't read "${mail.subject}": ${message}`);
          // Ollama down: stop, and carry on from this email next run. A slow or odd answer: skip it for now.
          return /isn't reachable/.test(message) ? 'stop' : 'retry';
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

      try {
        for (const r of retries) {
          const outcome = await read(r);
          if (outcome === 'stop') return;
          handled.add(r.uid);
          if (outcome === 'retry' && r.tries + 1 < 3) later.push({ ...r, tries: r.tries + 1 });
        }
        for (const item of backlog) {
          const outcome = await read(item);
          if (outcome === 'stop') return;
          if (outcome === 'retry') later.push({ ...item, tries: 1 });
        }
        // Every board's earlier mail has been gone over: not again.
        store.setKv(boardsKey, JSON.stringify(JOB_BOARDS.map((b) => b.id)));
        for (const uid of uids) {
          const item = wanted.find((w) => w.uid === uid);
          if (item) {
            const outcome = await read(item);
            if (outcome === 'stop') return;
            if (outcome === 'retry') later.push({ ...item, tries: 1 });
          }
          advance(uid);
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
