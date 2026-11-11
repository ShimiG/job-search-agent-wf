import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { UsageEntry } from '../llm/cost.ts';
import { boardPhrase, JOB_BOARDS } from '../sources/job-boards.ts';
import type { JobRow, JobStatus, NormalizedJob, ScoreResult } from '../types.ts';
import { isScoutOwned } from '../types.ts';
import { normalizeCompany, normalizeTitle, sha256 } from '../util/text.ts';

/** Append-only. Each entry runs once, tracked with PRAGMA user_version. SQL, or a function for a step SQL can't express. */
const MIGRATIONS: Array<string | ((db: Database.Database) => void)> = [
  `
  CREATE TABLE jobs (
    id                      INTEGER PRIMARY KEY,
    source                  TEXT NOT NULL,
    external_id             TEXT NOT NULL,
    company                 TEXT NOT NULL,
    title                   TEXT NOT NULL,
    location                TEXT NOT NULL DEFAULT '',
    workplace_type          TEXT NOT NULL DEFAULT 'unknown',
    url                     TEXT NOT NULL,
    apply_url               TEXT,
    description             TEXT NOT NULL DEFAULT '',
    description_is_partial  INTEGER NOT NULL DEFAULT 0,
    posted_at               TEXT,
    employment_type         TEXT,
    department              TEXT,
    norm_company            TEXT NOT NULL,
    norm_title              TEXT NOT NULL,
    content_hash            TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'discovered',
    status_reason           TEXT,
    duplicate_of            INTEGER REFERENCES jobs(id),
    score                   INTEGER,
    score_json              TEXT,
    score_attempts          INTEGER NOT NULL DEFAULT 0,
    scored_at               TEXT,
    first_seen_at           TEXT NOT NULL,
    last_seen_at            TEXT NOT NULL,
    closed_at               TEXT,
    updated_at              TEXT NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE INDEX idx_jobs_status ON jobs(status);
  CREATE INDEX idx_jobs_norm_company ON jobs(norm_company);

  CREATE TABLE status_history (
    id          INTEGER PRIMARY KEY,
    job_id      INTEGER NOT NULL REFERENCES jobs(id),
    from_status TEXT,
    to_status   TEXT NOT NULL,
    reason      TEXT,
    actor       TEXT NOT NULL,
    at          TEXT NOT NULL
  );
  CREATE INDEX idx_history_job ON status_history(job_id);

  CREATE TABLE runs (
    id          INTEGER PRIMARY KEY,
    agent       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    stats_json  TEXT
  );

  CREATE TABLE source_health (
    source_key      TEXT PRIMARY KEY,
    last_success_at TEXT,
    last_job_count  INTEGER,
    last_error      TEXT,
    last_error_at   TEXT
  );
  `,
  // 2: Tailor agent. One row per generated version of a job's CV + cover letter.
  `
  ALTER TABLE jobs ADD COLUMN tailor_feedback TEXT;

  CREATE TABLE applications (
    id                INTEGER PRIMARY KEY,
    job_id            INTEGER NOT NULL REFERENCES jobs(id),
    version           INTEGER NOT NULL,
    dir               TEXT NOT NULL,
    cv_language       TEXT NOT NULL,
    letter_language   TEXT NOT NULL,
    content_json      TEXT NOT NULL,
    verification_json TEXT NOT NULL,
    feedback          TEXT,
    model             TEXT,
    created_at        TEXT NOT NULL,
    UNIQUE (job_id, version)
  );
  CREATE INDEX idx_applications_job ON applications(job_id);
  `,
  // 3: Submitter agent. One row per attempt: prepared, submitted, needs_manual or failed.
  `
  CREATE TABLE submissions (
    id               INTEGER PRIMARY KEY,
    job_id           INTEGER NOT NULL REFERENCES jobs(id),
    application_id   INTEGER REFERENCES applications(id),
    mode             TEXT NOT NULL,
    outcome          TEXT NOT NULL,
    apply_url        TEXT,
    reason           TEXT,
    fields_json      TEXT,
    screenshots_json TEXT,
    confirmation     TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX idx_submissions_job ON submissions(job_id);
  `,
  // 4: Web lookups for summary-only (alert email) jobs. Set once tried, found or not, so it isn't retried.
  `
  ALTER TABLE jobs ADD COLUMN enriched_at TEXT;
  `,
  // 5: Where a looked-up description came from, kept apart from apply_url (where you apply). Earlier
  // lookups stored the description's page as apply_url without checking it had a form: move it.
  `
  ALTER TABLE jobs ADD COLUMN posting_url TEXT;
  UPDATE jobs SET posting_url = apply_url, apply_url = NULL WHERE enriched_at IS NOT NULL AND description_is_partial = 0;
  `,
  // 6: Which model gave each score, so a local model can learn from Claude's scores. Everything
  // scored before this was scored by Claude.
  `
  ALTER TABLE jobs ADD COLUMN scored_by TEXT;
  UPDATE jobs SET scored_by = 'claude' WHERE score IS NOT NULL;
  `,
  // 7: Archiver. Every email it read about an application (or decided wasn't one), so none is read twice.
  `
  CREATE TABLE responses (
    id           INTEGER PRIMARY KEY,
    message_id   TEXT NOT NULL UNIQUE,
    job_id       INTEGER REFERENCES jobs(id),
    received_at  TEXT NOT NULL,
    from_name    TEXT NOT NULL,
    from_address TEXT NOT NULL,
    subject      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    company      TEXT NOT NULL,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL,
    action       TEXT NOT NULL,
    model        TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX idx_responses_job ON responses(job_id);

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 8: An application's stage set by hand (it wins until a newer reply arrives), and what an
  // auto-archived application was before, so it can be restored.
  `
  ALTER TABLE jobs ADD COLUMN outcome TEXT;
  ALTER TABLE jobs ADD COLUMN outcome_at TEXT;
  ALTER TABLE jobs ADD COLUMN archived_from TEXT;
  `,
  // 9: Your choice to send a sent application to the Archive ('archived') or keep it in Applied ('applied').
  `
  ALTER TABLE jobs ADD COLUMN archive_choice TEXT;
  `,
  // 10: One row per Claude call, with what it cost, for spending reports. Also repairs a database
  // that ran an earlier build whose versions 6 and 7 were a different replies table and this usage
  // table: it gets the columns and tables of 6 and 7 above (its old replies are read again by the Archiver).
  (db) => {
    const has = (table: string, column?: string) =>
      column
        ? (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((c) => c.name === column)
        : Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
    if (!has('jobs', 'scored_by')) db.exec(MIGRATIONS[5] as string);
    if (!has('responses', 'message_id')) {
      db.exec('DROP TABLE IF EXISTS responses');
      db.exec(MIGRATIONS[6] as string);
    }
    if (has('usage')) return;
    db.exec(`
  CREATE TABLE usage (
    id                 INTEGER PRIMARY KEY,
    at                 TEXT NOT NULL,
    agent              TEXT NOT NULL,
    purpose            TEXT NOT NULL,
    model              TEXT NOT NULL,
    job_id             INTEGER REFERENCES jobs(id),
    run_id             INTEGER REFERENCES runs(id),
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    web_searches       INTEGER NOT NULL,
    cost               REAL NOT NULL
  );
  CREATE INDEX idx_usage_at ON usage(at);
  CREATE INDEX idx_usage_job ON usage(job_id);
    `);
  },
];

export interface ResponseRecord {
  id: number;
  messageId: string;
  jobId: number | null;
  receivedAt: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  kind: string;
  company: string;
  title: string;
  summary: string;
  action: string;
  model: string;
}

/** A job you applied to: when, and how (this tool, LinkedIn, Indeed, the company's site, marked by you). */
export interface SentApplication {
  job: JobRow;
  appliedAt: string;
  via: string;
  /** A stage you set by hand, and when. */
  outcome: { stage: string; at: string } | null;
  /** You sent it to the Archive, or kept it in Applied. null: the rules decide. */
  archiveChoice: ArchiveChoice | null;
}

export type ArchiveChoice = 'archived' | 'applied';

/** Statuses of an application on its way to being sent. */
export const UNSENT_STATUSES: readonly JobStatus[] = ['selected', 'tailored', 'tailor_error', 'approved', 'needs_manual', 'failed'];

export interface SubmissionRecord {
  id: number;
  jobId: number;
  applicationId: number | null;
  mode: string;
  outcome: 'prepared' | 'submitted' | 'needs_manual' | 'failed';
  applyUrl: string | null;
  reason: string | null;
  fields: unknown;
  screenshots: string[];
  confirmation: string | null;
  createdAt: string;
}

export interface ApplicationRecord {
  id: number;
  jobId: number;
  version: number;
  dir: string;
  cvLanguage: string;
  letterLanguage: string;
  content: unknown;
  verification: unknown;
  feedback: string | null;
  model: string | null;
  createdAt: string;
}

interface DbApplicationRow {
  id: number;
  job_id: number;
  version: number;
  dir: string;
  cv_language: string;
  letter_language: string;
  content_json: string;
  verification_json: string;
  feedback: string | null;
  model: string | null;
  created_at: string;
}

const toApplication = (r: DbApplicationRow): ApplicationRecord => ({
  id: r.id,
  jobId: r.job_id,
  version: r.version,
  dir: r.dir,
  cvLanguage: r.cv_language,
  letterLanguage: r.letter_language,
  content: JSON.parse(r.content_json),
  verification: JSON.parse(r.verification_json),
  feedback: r.feedback,
  model: r.model,
  createdAt: r.created_at,
});

interface DbJobRow {
  id: number;
  source: string;
  external_id: string;
  company: string;
  title: string;
  location: string;
  workplace_type: string;
  url: string;
  apply_url: string | null;
  description: string;
  description_is_partial: number;
  posted_at: string | null;
  employment_type: string | null;
  department: string | null;
  norm_company: string;
  norm_title: string;
  content_hash: string;
  status: string;
  status_reason: string | null;
  duplicate_of: number | null;
  score: number | null;
  score_json: string | null;
  score_attempts: number;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  updated_at: string;
  tailor_feedback: string | null;
  enriched_at: string | null;
  posting_url: string | null;
}

function toJobRow(r: DbJobRow): JobRow {
  return {
    id: r.id,
    source: r.source as JobRow['source'],
    externalId: r.external_id,
    company: r.company,
    title: r.title,
    location: r.location,
    workplaceType: r.workplace_type as JobRow['workplaceType'],
    url: r.url,
    applyUrl: r.apply_url ?? undefined,
    description: r.description,
    descriptionIsPartial: r.description_is_partial === 1,
    postedAt: r.posted_at ?? undefined,
    employmentType: r.employment_type ?? undefined,
    department: r.department ?? undefined,
    normCompany: r.norm_company,
    normTitle: r.norm_title,
    contentHash: r.content_hash,
    status: r.status as JobStatus,
    statusReason: r.status_reason,
    duplicateOf: r.duplicate_of,
    score: r.score,
    scoreDetails: r.score_json ? (JSON.parse(r.score_json) as ScoreResult) : null,
    scoreAttempts: r.score_attempts,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    closedAt: r.closed_at,
    tailorFeedback: r.tailor_feedback ?? null,
    enrichedAt: r.enriched_at ?? null,
    postingUrl: r.posting_url ?? null,
  };
}

export type UpsertOutcome = 'inserted' | 'changed' | 'unchanged';

export type Actor = 'scout' | 'user' | 'tailor' | 'submitter' | 'archiver';

export class JobStore {
  readonly db: Database.Database;

  /** The data folder, for finding files whose saved path predates a move of the project folder. */
  private readonly dataDir: string | null;

  constructor(file: string) {
    this.dataDir = file === ':memory:' ? null : path.dirname(path.resolve(file));
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  /**
   * Paths are saved in full, so renaming or moving the project folder breaks them. A path into an
   * old data/applications folder is found again under the current one.
   */
  private relocate(saved: string): string {
    if (!this.dataDir || existsSync(saved)) return saved;
    const marker = `${path.sep}data${path.sep}applications${path.sep}`;
    const at = saved.lastIndexOf(marker);
    return at < 0 ? saved : path.join(this.dataDir, 'applications', saved.slice(at + marker.length));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        const step = MIGRATIONS[v]!;
        if (typeof step === 'string') this.db.exec(step);
        else step(this.db);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  /**
   * Insert a new job, or refresh an existing one. If the posting's content changed while
   * the job is still in Scout's hands, it goes back to `discovered` to be re-evaluated.
   */
  upsert(job: NormalizedJob, now: string): { id: number; outcome: UpsertOutcome } {
    const hash = sha256([job.title, job.company, job.location, job.workplaceType, job.description].join('\u0000'));
    const existing = this.db
      .prepare('SELECT id, content_hash, status, description_is_partial FROM jobs WHERE source = ? AND external_id = ?')
      .get(job.source, job.externalId) as { id: number; content_hash: string; status: JobStatus; description_is_partial: number } | undefined;

    const fields = {
      company: job.company,
      title: job.title,
      location: job.location,
      workplace_type: job.workplaceType,
      url: job.url,
      apply_url: job.applyUrl ?? null,
      description: job.description,
      description_is_partial: job.descriptionIsPartial ? 1 : 0,
      posted_at: job.postedAt ?? null,
      employment_type: job.employmentType ?? null,
      department: job.department ?? null,
      norm_company: normalizeCompany(job.company),
      norm_title: normalizeTitle(job.title),
      content_hash: hash,
    };

    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO jobs (source, external_id, company, title, location, workplace_type, url, apply_url, description,
             description_is_partial, posted_at, employment_type, department, norm_company, norm_title, content_hash,
             status, first_seen_at, last_seen_at, updated_at)
           VALUES (@source, @external_id, @company, @title, @location, @workplace_type, @url, @apply_url, @description,
             @description_is_partial, @posted_at, @employment_type, @department, @norm_company, @norm_title, @content_hash,
             'discovered', @now, @now, @now)`,
        )
        .run({ source: job.source, external_id: job.externalId, now, ...fields });
      const id = Number(info.lastInsertRowid);
      this.recordHistory(id, null, 'discovered', null, 'scout', now);
      return { id, outcome: 'inserted' };
    }

    // The same alert email arrives on later runs too; it must not replace a full posting found since.
    if (existing.content_hash === hash || (job.descriptionIsPartial && existing.description_is_partial === 0)) {
      this.db.prepare('UPDATE jobs SET last_seen_at = ?, closed_at = NULL WHERE id = ?').run(now, existing.id);
      return { id: existing.id, outcome: 'unchanged' };
    }

    this.db
      .prepare(
        `UPDATE jobs SET company=@company, title=@title, location=@location, workplace_type=@workplace_type, url=@url,
           apply_url=@apply_url, description=@description, description_is_partial=@description_is_partial,
           posted_at=@posted_at, employment_type=@employment_type, department=@department, norm_company=@norm_company,
           norm_title=@norm_title, content_hash=@content_hash, last_seen_at=@now, closed_at=NULL, updated_at=@now
         WHERE id=@id`,
      )
      .run({ id: existing.id, now, ...fields });
    if (isScoutOwned(existing.status) && existing.status !== 'discovered') {
      this.setStatus(existing.id, 'discovered', 'posting changed', 'scout', now, { resetScore: true });
    }
    return { id: existing.id, outcome: 'changed' };
  }

  /** After a full board snapshot, anything from that board we didn't see this run is closed. */
  markMissingAsClosed(source: string, prefix: string, runStartedAt: string, now: string): number {
    const info = this.db
      .prepare(
        `UPDATE jobs SET closed_at = ?, updated_at = ?
         WHERE source = ? AND substr(external_id, 1, ?) = ? AND last_seen_at < ? AND closed_at IS NULL`,
      )
      .run(now, now, source, prefix.length, prefix, runStartedAt);
    return info.changes;
  }

  setStatus(
    id: number,
    to: JobStatus,
    reason: string | null,
    actor: Actor,
    now: string,
    opts: { duplicateOf?: number | null; resetScore?: boolean } = {},
  ): void {
    const row = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: JobStatus } | undefined;
    if (!row) throw new Error(`Job ${id} not found`);
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, status_reason = ?, duplicate_of = ?, updated_at = ?
           ${opts.resetScore ? ', score = NULL, score_json = NULL, score_attempts = 0, scored_at = NULL' : ''}
         WHERE id = ?`,
      )
      .run(to, reason, opts.duplicateOf ?? null, now, id);
    this.recordHistory(id, row.status, to, reason, actor, now);
  }

  saveScore(id: number, result: ScoreResult, status: 'shortlisted' | 'low_score', now: string, scoredBy: string | null = null): void {
    this.db
      .prepare(
        `UPDATE jobs SET score = ?, score_json = ?, scored_at = ?, scored_by = ?, score_attempts = score_attempts + 1 WHERE id = ?`,
      )
      .run(result.score, JSON.stringify(result), now, scoredBy, id);
    this.setStatus(id, status, `score ${result.score}`, 'scout', now);
  }

  /** Jobs Claude scored, for teaching a local model its calibration and for comparing the two. */
  listClaudeScored(): Array<{ job: JobRow; result: ScoreResult }> {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE score_json IS NOT NULL AND scored_by LIKE 'claude%' AND duplicate_of IS NULL ORDER BY score, id`)
      .all() as DbJobRow[];
    return rows.map(toJobRow).map((job) => ({ job, result: job.scoreDetails! }));
  }

  recordScoreError(id: number, message: string, now: string): void {
    this.db.prepare('UPDATE jobs SET score_attempts = score_attempts + 1 WHERE id = ?').run(id);
    this.setStatus(id, 'score_error', message.slice(0, 500), 'scout', now);
  }

  get(id: number): JobRow | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as DbJobRow | undefined;
    return r ? toJobRow(r) : undefined;
  }

  listByStatus(statuses: readonly JobStatus[], opts: { includeClosed?: boolean } = {}): JobRow[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => '?').join(',');
    const closed = opts.includeClosed ? '' : 'AND closed_at IS NULL';
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${marks}) ${closed} ORDER BY score DESC NULLS LAST, posted_at DESC, id`)
      .all(...statuses) as DbJobRow[];
    return rows.map(toJobRow);
  }

  /** Jobs waiting for an LLM score, newest postings first, skipping ones that keep failing. */
  listScoringQueue(maxAttempts: number, limit: number): JobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('queued', 'score_error') AND closed_at IS NULL AND score_attempts < ?
         ORDER BY COALESCE(posted_at, first_seen_at) DESC, id
         LIMIT ?`,
      )
      .all(maxAttempts, limit) as DbJobRow[];
    return rows.map(toJobRow);
  }

  countScoringQueue(maxAttempts: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','score_error') AND closed_at IS NULL AND score_attempts < ?`,
      )
      .get(maxAttempts) as { n: number };
    return row.n;
  }

  /** Same-company rows a new job might duplicate. */
  dedupeCandidates(normCompany: string, excludeId: number): JobRow[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE norm_company = ? AND id != ? AND closed_at IS NULL')
      .all(normCompany, excludeId) as DbJobRow[];
    return rows.map(toJobRow);
  }

  findByExternalId(source: string, externalId: string): JobRow | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE source = ? AND external_id = ?').get(source, externalId) as DbJobRow | undefined;
    return row ? toJobRow(row) : undefined;
  }

  /** The newest LinkedIn job ID in each day's alert emails since `sinceIso`, for days with at least `minJobs` jobs. */
  linkedinAlertFrontier(sinceIso: string, minJobs = 5): Array<{ date: string; maxId: number }> {
    return this.db
      .prepare(
        `SELECT substr(posted_at, 1, 10) AS date, MAX(CAST(substr(external_id, 10) AS INTEGER)) AS maxId
         FROM jobs WHERE source = 'email' AND external_id LIKE 'linkedin:%' AND posted_at >= ?
         GROUP BY date HAVING COUNT(*) >= ? ORDER BY date`,
      )
      .all(sinceIso, minJobs) as Array<{ date: string; maxId: number }>;
  }

  /** Every job with this normalized title, at any company. */
  findByNormTitle(normTitle: string): JobRow[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE norm_title = ?').all(normTitle) as DbJobRow[];
    return rows.map(toJobRow);
  }

  /**
   * Records a web lookup for a summary-only job. When the full posting was found, it replaces the
   * summary and becomes where you apply, and the old score is cleared so the job is scored again.
   */
  saveEnrichment(
    id: number,
    found: { description: string; postingUrl: string; applyUrl?: string; location?: string; workplaceType?: JobRow['workplaceType']; postedAt?: string } | null,
    now: string,
  ): void {
    if (!found) {
      this.db.prepare('UPDATE jobs SET enriched_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      return;
    }
    const job = this.get(id);
    if (!job) return;
    const location = found.location || job.location;
    const workplaceType = found.workplaceType && found.workplaceType !== 'unknown' ? found.workplaceType : job.workplaceType;
    const hash = sha256([job.title, job.company, location, workplaceType, found.description].join('\u0000'));
    this.db
      .prepare(
        `UPDATE jobs SET description = ?, description_is_partial = 0, posting_url = ?, apply_url = COALESCE(?, apply_url),
           location = ?, workplace_type = ?, content_hash = ?, enriched_at = ?, score = NULL, score_json = NULL,
           scored_at = NULL, updated_at = ?, posted_at = COALESCE(?, posted_at) WHERE id = ?`,
      )
      .run(found.description, found.postingUrl, found.applyUrl ?? null, location, workplaceType, hash, now, now, found.postedAt ?? null, id);
  }

  /** The company's own application page for a job found through an alert: where the Submitter applies. */
  setApplyUrl(id: number, url: string, now: string): void {
    this.db.prepare('UPDATE jobs SET apply_url = ?, enriched_at = COALESCE(enriched_at, ?), updated_at = ? WHERE id = ?').run(url, now, now, id);
  }

  /** A posting that stopped taking applications leaves every list, with the reason in its history. */
  markClosed(id: number, reason: string, now: string): void {
    this.db.prepare('UPDATE jobs SET closed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    this.setStatus(id, 'filtered_out', reason, 'scout', now);
  }

  /**
   * Puts every Scout-owned job (except duplicates) back through filters and scoring. Jobs you added
   * yourself skip the filters: they're only scored again.
   */
  requeueForReevaluation(now: string): number {
    const rows = this.db
      .prepare(`SELECT id, source FROM jobs WHERE status IN ('filtered_out','queued','score_error','low_score','shortlisted')`)
      .all() as Array<{ id: number; source: string }>;
    this.db.transaction(() => {
      for (const { id, source } of rows) {
        this.setStatus(id, source === 'manual' ? 'queued' : 'discovered', 'manual re-evaluation', 'scout', now, { resetScore: true });
      }
    })();
    return rows.length;
  }

  /** A job whose link, application page or full posting is this URL. */
  findByUrl(url: string): JobRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE url = ? OR apply_url = ? OR posting_url = ? ORDER BY id DESC LIMIT 1')
      .get(url, url, url) as DbJobRow | undefined;
    return row ? toJobRow(row) : undefined;
  }

  statusCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM jobs WHERE closed_at IS NULL GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  history(id: number): Array<{ from_status: string | null; to_status: string; reason: string | null; actor: string; at: string }> {
    return this.db
      .prepare('SELECT from_status, to_status, reason, actor, at FROM status_history WHERE job_id = ? ORDER BY id')
      .all(id) as Array<{ from_status: string | null; to_status: string; reason: string | null; actor: string; at: string }>;
  }

  private recordHistory(id: number, from: JobStatus | null, to: JobStatus, reason: string | null, actor: Actor, at: string) {
    this.db
      .prepare('INSERT INTO status_history (job_id, from_status, to_status, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, from, to, reason, actor, at);
  }

  setTailorFeedback(id: number, feedback: string | null): void {
    this.db.prepare('UPDATE jobs SET tailor_feedback = ? WHERE id = ?').run(feedback, id);
  }

  saveApplication(app: Omit<ApplicationRecord, 'id' | 'version'>): ApplicationRecord {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM applications WHERE job_id = ?')
      .get(app.jobId) as { v: number };
    const info = this.db
      .prepare(
        `INSERT INTO applications (job_id, version, dir, cv_language, letter_language, content_json, verification_json,
           feedback, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        app.jobId, next.v, app.dir, app.cvLanguage, app.letterLanguage, JSON.stringify(app.content),
        JSON.stringify(app.verification), app.feedback, app.model, app.createdAt,
      );
    return { ...app, id: Number(info.lastInsertRowid), version: next.v };
  }

  /** Overwrites a version's content after you edit it by hand and re-render. */
  updateApplicationContent(id: number, content: unknown, verification: unknown): void {
    this.db
      .prepare('UPDATE applications SET content_json = ?, verification_json = ? WHERE id = ?')
      .run(JSON.stringify(content), JSON.stringify(verification), id);
  }

  latestApplication(jobId: number): ApplicationRecord | undefined {
    const r = this.db
      .prepare('SELECT * FROM applications WHERE job_id = ? ORDER BY version DESC LIMIT 1')
      .get(jobId) as DbApplicationRow | undefined;
    return r ? { ...toApplication(r), dir: this.relocate(r.dir) } : undefined;
  }

  /** The latest version of each other job's application since `sinceIso`, newest first. */
  recentApplications(excludeJobId: number, sinceIso: string, limit = 100): ApplicationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM applications a
         JOIN (SELECT job_id, MAX(version) AS v FROM applications GROUP BY job_id) latest
           ON latest.job_id = a.job_id AND latest.v = a.version
         WHERE a.job_id != ? AND a.created_at >= ?
         ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(excludeJobId, sinceIso, limit) as DbApplicationRow[];
    return rows.map(toApplication);
  }

  saveSubmission(sub: Omit<SubmissionRecord, 'id'>): SubmissionRecord {
    const info = this.db
      .prepare(
        `INSERT INTO submissions (job_id, application_id, mode, outcome, apply_url, reason, fields_json, screenshots_json,
           confirmation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sub.jobId, sub.applicationId, sub.mode, sub.outcome, sub.applyUrl, sub.reason, JSON.stringify(sub.fields ?? null),
        JSON.stringify(sub.screenshots), sub.confirmation, sub.createdAt,
      );
    return { ...sub, id: Number(info.lastInsertRowid) };
  }

  submissions(jobId: number): SubmissionRecord[] {
    const rows = this.db.prepare('SELECT * FROM submissions WHERE job_id = ? ORDER BY id').all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      jobId: r.job_id as number,
      applicationId: (r.application_id as number | null) ?? null,
      mode: r.mode as string,
      outcome: r.outcome as SubmissionRecord['outcome'],
      applyUrl: (r.apply_url as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      fields: JSON.parse((r.fields_json as string | null) ?? 'null'),
      screenshots: (JSON.parse((r.screenshots_json as string | null) ?? '[]') as string[]).map((f) => this.relocate(f)),
      confirmation: (r.confirmation as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  /** Submitted applications to the same company in the last `days` days. */
  recentSubmissionsToCompany(normCompany: string, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM submissions s JOIN jobs j ON j.id = s.job_id
         WHERE s.outcome = 'submitted' AND j.norm_company = ? AND s.created_at >= ?`,
      )
      .get(normCompany, sinceIso) as { n: number };
    return row.n;
  }

  sourceSucceeded(key: string, jobCount: number, now: string): void {
    this.db
      .prepare(
        `INSERT INTO source_health (source_key, last_success_at, last_job_count) VALUES (?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET last_success_at = excluded.last_success_at, last_job_count = excluded.last_job_count`,
      )
      .run(key, now, jobCount);
  }

  sourceFailed(key: string, error: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO source_health (source_key, last_error, last_error_at) VALUES (?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
      )
      .run(key, error.slice(0, 500), now);
  }

  sourceHealth(): Array<{ source_key: string; last_success_at: string | null; last_job_count: number | null; last_error: string | null; last_error_at: string | null }> {
    return this.db.prepare('SELECT * FROM source_health ORDER BY source_key').all() as never;
  }

  latestRun(agent: string): { id: number; startedAt: string; finishedAt: string | null } | undefined {
    const row = this.db
      .prepare('SELECT id, started_at, finished_at FROM runs WHERE agent = ? ORDER BY id DESC LIMIT 1')
      .get(agent) as { id: number; started_at: string; finished_at: string | null } | undefined;
    return row && { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at };
  }

  /** Jobs scored at or after `sinceIso`: a running Scout's progress. */
  countScoredSince(sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE scored_at >= ?').get(sinceIso) as { n: number }).n;
  }

  saveUsage(u: UsageEntry): void {
    this.db
      .prepare(
        `INSERT INTO usage (at, agent, purpose, model, job_id, run_id, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, web_searches, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.at, u.agent, u.purpose, u.model, u.jobId, u.runId, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.webSearches, u.cost);
  }

  /** Spending since `sinceIso` (all time when omitted), by what the calls were for. */
  usageByPurpose(sinceIso?: string): Array<{ purpose: string; calls: number; cost: number }> {
    return this.db
      .prepare('SELECT purpose, COUNT(*) AS calls, SUM(cost) AS cost FROM usage WHERE at >= ? GROUP BY purpose ORDER BY cost DESC')
      .all(sinceIso ?? '') as Array<{ purpose: string; calls: number; cost: number }>;
  }

  /** Dollars spent on one job: scoring, lookups, tailoring, form answers. */
  usageForJob(jobId: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE job_id = ?').get(jobId) as { cost: number }).cost;
  }

  /** When spending was first recorded, or undefined if never. */
  usageSince(): string | undefined {
    return (this.db.prepare('SELECT MIN(at) AS at FROM usage').get() as { at: string | null }).at ?? undefined;
  }

  startRun(agent: string, now: string): number {
    return Number(this.db.prepare('INSERT INTO runs (agent, started_at) VALUES (?, ?)').run(agent, now).lastInsertRowid);
  }

  finishRun(id: number, stats: unknown, now: string): void {
    this.db.prepare('UPDATE runs SET finished_at = ?, stats_json = ? WHERE id = ?').run(now, JSON.stringify(stats), id);
  }

  hasResponse(messageId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM responses WHERE message_id = ?').get(messageId));
  }

  saveResponse(r: Omit<ResponseRecord, 'id'>, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO responses (message_id, job_id, received_at, from_name, from_address, subject, kind, company, title, summary, action, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.messageId, r.jobId, r.receivedAt, r.fromName, r.fromAddress, r.subject, r.kind, r.company, r.title, r.summary, r.action, r.model, now);
  }

  /** Emails about your applications, oldest first. Ones that weren't about an application are left out. */
  responses(): ResponseRecord[] {
    const rows = this.db.prepare(`SELECT * FROM responses WHERE kind != 'not_related' ORDER BY received_at, id`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      messageId: r.message_id as string,
      jobId: (r.job_id as number | null) ?? null,
      receivedAt: r.received_at as string,
      fromName: r.from_name as string,
      fromAddress: r.from_address as string,
      subject: r.subject as string,
      kind: r.kind as string,
      company: r.company as string,
      title: r.title as string,
      summary: r.summary as string,
      action: r.action as string,
      model: r.model as string,
    }));
  }

  setResponseJob(id: number, jobId: number | null): void {
    this.db.prepare('UPDATE responses SET job_id = ? WHERE id = ?').run(jobId, id);
  }

  sentApplications(): SentApplication[] {
    const rows = this.db
      .prepare(
        `SELECT j.*, s.created_at AS applied_at, s.mode AS sub_mode, s.reason AS sub_reason
           FROM jobs j JOIN submissions s ON s.id = (SELECT MIN(id) FROM submissions WHERE job_id = j.id AND outcome = 'submitted')
          WHERE j.status = 'submitted'
          ORDER BY s.created_at DESC`,
      )
      .all() as Array<DbJobRow & { applied_at: string; sub_mode: string; sub_reason: string | null; outcome: string | null; outcome_at: string | null; archive_choice: ArchiveChoice | null }>;
    return rows.map((r) => {
      const reason = r.sub_reason ?? '';
      const via =
        r.sub_mode !== 'manual' ? 'this tool'
        : /on LinkedIn/.test(reason) ? 'LinkedIn'
        : /on Indeed/.test(reason) ? 'Indeed'
        : JOB_BOARDS.some((b) => reason.includes(boardPhrase(b.id))) ? JOB_BOARDS.find((b) => reason.includes(boardPhrase(b.id)))!.label
        : /on the company site/.test(reason) ? 'company site'
        : /per your email/.test(reason) ? 'from your email'
        : 'marked by you';
      return { job: toJobRow(r), appliedAt: r.applied_at, via, outcome: r.outcome && r.outcome_at ? { stage: r.outcome, at: r.outcome_at } : null, archiveChoice: r.archive_choice ?? null };
    });
  }

  /** Sends these job records' application to the Archive, keeps it in Applied, or (null) leaves it to the rules. */
  setArchiveChoice(ids: number[], choice: ArchiveChoice | null, now: string): void {
    const stmt = this.db.prepare('UPDATE jobs SET archive_choice = ?, updated_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(choice, now, id)))();
  }

  /** Sets (or with null clears) the stage you gave these applications by hand. */
  setOutcome(ids: number[], stage: string | null, now: string): void {
    const stmt = this.db.prepare('UPDATE jobs SET outcome = ?, outcome_at = ?, updated_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(stage, stage ? now : null, now, id)))();
  }

  /**
   * Applications not sent and untouched (no status change) for `days`: moved to the archive, keeping
   * what they were so they can be restored. Returns the archived jobs.
   */
  archiveStale(days: number, now: Date): JobRow[] {
    const cutoffIso = new Date(now.getTime() - days * 86_400_000).toISOString();
    const marks = UNSENT_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
          WHERE j.status IN (${marks})
            AND COALESCE((SELECT MAX(at) FROM status_history h WHERE h.job_id = j.id), j.updated_at) < ?`,
      )
      .all(...UNSENT_STATUSES, cutoffIso) as DbJobRow[];
    const iso = now.toISOString();
    for (const r of rows) {
      this.db.prepare('UPDATE jobs SET archived_from = ? WHERE id = ?').run(r.status, r.id);
      this.setStatus(r.id, 'archived', `not sent, no change for ${days} days`, 'archiver', iso);
    }
    return rows.map(toJobRow);
  }

  /** Puts an archived application back where it was. */
  restoreArchived(id: number, now: string): JobStatus {
    const row = this.db.prepare('SELECT status, archived_from FROM jobs WHERE id = ?').get(id) as { status: string; archived_from: string | null } | undefined;
    if (!row || row.status !== 'archived') throw new Error(`#${id} isn't archived`);
    const to = (row.archived_from ?? 'selected') as JobStatus;
    this.setStatus(id, to, 'restored from the archive', 'user', now);
    this.db.prepare('UPDATE jobs SET archived_from = NULL WHERE id = ?').run(id);
    return to;
  }

  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
