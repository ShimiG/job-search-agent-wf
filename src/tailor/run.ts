import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MasterCv } from '../config.ts';
import type { ApplicationRecord, JobStore } from '../db/store.ts';
import { detectLanguage } from '../pipeline/language.ts';
import type { JobRow } from '../types.ts';
import { TAILOR_INPUT_STATUSES } from '../types.ts';
import type { Logger } from '../util/logger.ts';
import type { ClaimVerifier, DraftInput, TailorWriter } from './llm.ts';
import { documentNames, renderCvHtml, renderLetterHtml, writeText, type PdfEngine } from './render.ts';
import { SUPPORTED_LANGUAGES, type Issue, type OutputLanguage, type TailorConfig, type TailoredContent, type VerificationReport } from './schema.ts';
import { applyVerdicts, bulletChanges, claimsForReview, factCheck, normalizeDraft, type Claim, type ContentBody } from './verify.ts';

export interface TailorDeps {
  store: JobStore;
  cv: MasterCv;
  cfg: TailorConfig;
  writer: TailorWriter;
  verifier: ClaimVerifier;
  /** null = PDF disabled; HTML is always written. */
  pdf: PdfEngine | null;
  outDir: string;
  logger: Logger;
  model?: string;
  clock?: () => Date;
}

export function decideLanguages(job: JobRow, cfg: TailorConfig): { cvLanguage: OutputLanguage; letterLanguage: OutputLanguage } {
  const detected = detectLanguage(`${job.title}\n${job.description}`);
  const posting: OutputLanguage = (SUPPORTED_LANGUAGES as readonly string[]).includes(detected) ? (detected as OutputLanguage) : 'en';
  return {
    cvLanguage: cfg.languages.cv === 'match' ? posting : 'en',
    letterLanguage: cfg.languages.coverLetter === 'match' ? posting : 'en',
  };
}

const postingText = (job: JobRow) => `${job.title}\n${job.company}\n${job.location}\n${job.description}`;

/** Any claim the fact-checker skipped is reported rather than silently trusted. */
function missingVerdicts(claims: Claim[], returned: Set<string>): Issue[] {
  return claims
    .filter((c) => !returned.has(c.id))
    .map((c) => ({ severity: 'warning' as const, where: c.id, message: 'the fact-checker did not return a verdict for this; read it yourself' }));
}

/** Draft → deterministic checks → LLM fact-check → one letter revision if needed. */
export async function produceContent(job: JobRow, deps: TailorDeps): Promise<{ content: TailoredContent; report: VerificationReport }> {
  const { cv, cfg, writer, verifier } = deps;
  const now = (deps.clock ?? (() => new Date()))();
  const langs = decideLanguages(job, cfg);
  const input: DraftInput = { job, cv, cfg, ...langs, feedback: job.tailorFeedback };
  const postText = postingText(job);

  const draft = await writer.draft(input);
  const { body, issues } = normalizeDraft(draft, cv, cfg, langs.letterLanguage);
  const first = factCheck(body, cv, postText, langs.cvLanguage, cfg);
  issues.push(...first.issues);

  const claims = claimsForReview(body, cv, first.letterSuspects);
  const verdicts = await verifier.verify(cv, postText, claims);
  issues.push(...missingVerdicts(claims, new Set(verdicts.claims.map((c) => c.id))));
  const applied = applyVerdicts(body, cv, verdicts, langs.cvLanguage);
  issues.push(...applied.issues);

  let revised = false;
  if (applied.letterProblems.size > 0) {
    revised = true;
    const problems = [...applied.letterProblems].map(([paragraph, problem]) => ({ paragraph, problem }));
    deps.logger.info(`#${job.id}: revising ${problems.length} cover-letter paragraph(s) flagged by the fact-check`);
    const paragraphs = await writer.reviseLetter(input, body.coverLetter.paragraphs, problems);
    if (paragraphs.length) body.coverLetter.paragraphs = paragraphs;

    // The letter changed: replace every letter finding with a fresh check of the new text.
    const kept = issues.filter((i) => !i.where.startsWith('letter'));
    issues.length = 0;
    issues.push(...kept);
    const second = factCheck(body, cv, postText, langs.cvLanguage, cfg);
    issues.push(...second.issues.filter((i) => i.where.startsWith('letter')));
    const letterClaims = claimsForReview(body, cv, second.letterSuspects).filter((c) => c.id.startsWith('letter:'));
    const recheck = await verifier.verify(cv, postText, letterClaims);
    issues.push(...missingVerdicts(letterClaims, new Set(recheck.claims.map((c) => c.id))));
    const after = applyVerdicts(body, cv, recheck, langs.cvLanguage);
    for (const [i, problem] of after.letterProblems) {
      issues.push({ severity: 'unresolved', where: `letter:${i}`, message: `fact-check (after revision): ${problem}` });
    }
  }

  const content: TailoredContent = {
    jobId: job.id,
    company: job.company,
    jobTitle: job.title,
    ...langs,
    ...body,
    generatedAt: now.toISOString(),
  };
  const report: VerificationReport = {
    ok: !issues.some((i) => i.severity === 'unresolved'),
    issues,
    bulletChanges: bulletChanges(body, cv),
    llmChecked: true,
    revised,
  };
  return { content, report };
}

export function applicationDir(outDir: string, job: Pick<JobRow, 'id' | 'company'>, version: number): string {
  const slug = job.company.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company';
  return path.join(outDir, `${job.id}-${slug}`, `v${version}`);
}

type Shrink = { what: string; apply?: (c: TailoredContent) => TailoredContent | null; compact?: true };

const capBullets = (c: TailoredContent, max: number, which: 'recent' | 'older'): TailoredContent | null => {
  let changed = false;
  const experience = c.experience.map((x, i) => {
    if ((which === 'recent') !== (i === 0) || x.bullets.length <= max) return x;
    changed = true;
    return { ...x, bullets: x.bullets.slice(0, max) };
  });
  return changed ? { ...c, experience } : null;
};

/**
 * Ways to shorten a CV, least valuable first. Each keeps the writer's own choices and order (strongest
 * bullet first), so trimming never adds or rewords anything: it only leaves out the weakest parts. A
 * project goes last: it's often the best evidence for the kind of role you're applying to.
 */
const SHRINK: Shrink[] = [
  { what: 'skills cut to 10', apply: (c) => (c.skills.length > 10 ? { ...c, skills: c.skills.slice(0, 10) } : null) },
  { what: 'one project instead of two', apply: (c) => (c.projects.length > 1 ? { ...c, projects: c.projects.slice(0, 1) } : null) },
  { what: 'older roles cut to 2 bullets', apply: (c) => capBullets(c, 2, 'older') },
  {
    what: 'summary cut to its first two sentences',
    apply: (c) => {
      const sentences = c.summary.split(/(?<=[.!?])\s+/);
      return sentences.length > 2 ? { ...c, summary: sentences.slice(0, 2).join(' ') } : null;
    },
  },
  {
    what: 'project cut to 1 bullet',
    apply: (c) => (c.projects.some((p) => p.bullets.length > 1) ? { ...c, projects: c.projects.map((p) => ({ ...p, bullets: p.bullets.slice(0, 1) })) } : null),
  },
  { what: 'most recent role cut to 4 bullets', apply: (c) => capBullets(c, 4, 'recent') },
  { what: 'older roles cut to 1 bullet', apply: (c) => capBullets(c, 1, 'older') },
  { what: 'most recent role cut to 3 bullets', apply: (c) => capBullets(c, 3, 'recent') },
  { what: 'smaller type and margins', compact: true },
  { what: 'projects left out', apply: (c) => (c.projects.length ? { ...c, projects: [] } : null) },
];

/**
 * Writes HTML (always), PDF (if enabled), content.json and report.md into `dir`. With `fit`, a CV over
 * cv.targetPages is trimmed (see SHRINK) and finally set in compact type until it fits. Returns the
 * content as written, which may be the trimmed version.
 */
export async function writeArtifacts(
  dir: string,
  content: TailoredContent,
  report: VerificationReport,
  deps: Pick<TailorDeps, 'cv' | 'cfg' | 'pdf'>,
  today: Date,
  opts: { fit?: boolean } = {},
): Promise<{ files: string[]; content: TailoredContent }> {
  mkdirSync(dir, { recursive: true });
  const names = documentNames(deps.cv.name);
  const letterHtml = renderLetterHtml(content, deps.cv, deps.cfg, today);
  const target = deps.cfg.cv.targetPages;
  let fitted = content;
  let compact = false;
  let cvHtml = renderCvHtml(fitted, deps.cv, deps.cfg);
  const files = [writeText(dir, `${names.letter}.html`, letterHtml)];
  report.issues = report.issues.filter((i) => i.where !== 'layout');
  if (deps.pdf) {
    const cvPdf = path.join(dir, `${names.cv}.pdf`);
    const letterPdf = path.join(dir, `${names.letter}.pdf`);
    let { pages } = await deps.pdf.render(cvHtml, cvPdf);
    const trimmed: string[] = [];
    if (opts.fit) {
      for (const step of SHRINK) {
        if (pages <= target) break;
        if (step.compact) compact = true;
        else {
          const next = step.apply!(fitted);
          if (!next) continue;
          fitted = next;
        }
        trimmed.push(step.what);
        cvHtml = renderCvHtml(fitted, deps.cv, deps.cfg, { compact });
        ({ pages } = await deps.pdf.render(cvHtml, cvPdf));
      }
    }
    await deps.pdf.render(letterHtml, letterPdf);
    files.unshift(cvPdf, letterPdf);
    report.cvPages = pages;
    if (trimmed.length) {
      report.issues.push({ severity: 'warning', where: 'layout', message: `trimmed to fit ${target} page(s): ${trimmed.join(', ')}` });
    }
    if (pages > target) {
      report.issues.push({
        severity: 'warning',
        where: 'layout',
        message: `CV is ${pages} pages (target ${target}); lower cv.maxBulletsPerRole or cv.maxProjects, or redo with a note`,
      });
    }
  }
  files.splice(files.length - 1, 0, writeText(dir, `${names.cv}.html`, cvHtml));
  writeText(dir, 'content.json', JSON.stringify(fitted, null, 2) + '\n');
  writeText(dir, 'report.md', formatReport(fitted, report, files));
  return { files, content: fitted };
}

export async function tailorJob(job: JobRow, deps: TailorDeps): Promise<{ app: ApplicationRecord; report: VerificationReport; files: string[] }> {
  const now = (deps.clock ?? (() => new Date()))();
  const { content, report } = await produceContent(job, deps);
  const version = (deps.store.latestApplication(job.id)?.version ?? 0) + 1;
  const dir = applicationDir(deps.outDir, job, version);
  const written = await writeArtifacts(dir, content, report, deps, now, { fit: true });
  const files = written.files;

  const app = deps.store.saveApplication({
    jobId: job.id,
    dir,
    cvLanguage: content.cvLanguage,
    letterLanguage: content.letterLanguage,
    content: written.content,
    verification: report,
    feedback: job.tailorFeedback,
    model: deps.model ?? null,
    createdAt: now.toISOString(),
  });
  deps.store.setTailorFeedback(job.id, null);
  const unresolved = report.issues.filter((i) => i.severity === 'unresolved').length;
  deps.store.setStatus(job.id, 'tailored', unresolved ? `v${app.version}: ${unresolved} item(s) need your review` : `v${app.version} ready`, 'tailor', now.toISOString());
  return { app, report, files };
}

export interface TailorRunStats {
  attempted: number;
  tailored: number;
  needsReview: number;
  errors: Array<{ jobId: number; error: string }>;
}

export async function runTailor(deps: TailorDeps, opts: { jobIds?: number[] } = {}): Promise<TailorRunStats> {
  const { store, logger } = deps;
  const stats: TailorRunStats = { attempted: 0, tailored: 0, needsReview: 0, errors: [] };
  const jobs = opts.jobIds?.length
    ? opts.jobIds.map((id) => store.get(id)).filter((j): j is JobRow => Boolean(j && TAILOR_INPUT_STATUSES.includes(j.status)))
    : store.listByStatus(TAILOR_INPUT_STATUSES).slice(0, deps.cfg.maxJobsPerRun);
  if (jobs.length === 0) {
    logger.info('Nothing to tailor. Pick jobs first: npm run scout -- pick <id>');
    return stats;
  }

  const runId = store.startRun('tailor', new Date().toISOString());
  for (const job of jobs) {
    stats.attempted++;
    logger.info(`#${job.id}: tailoring for ${job.company} — ${job.title}`);
    try {
      const { report, app } = await tailorJob(job, deps);
      stats.tailored++;
      if (!report.ok) stats.needsReview++;
      logger.info(`#${job.id}: v${app.version} written to ${app.dir}${report.ok ? '' : ' (needs review)'}`);
    } catch (err) {
      const message = (err as Error).message;
      store.setStatus(job.id, 'tailor_error', message.slice(0, 500), 'tailor', new Date().toISOString());
      stats.errors.push({ jobId: job.id, error: message });
      logger.warn(`#${job.id}: tailoring failed: ${message}`);
    }
  }
  store.finishRun(runId, stats, new Date().toISOString());
  return stats;
}

/**
 * After you edit content.json by hand: re-run the deterministic checks as warnings (your edits
 * are yours, nothing is reverted), re-render, and record the edit on the same version.
 */
export async function rerender(jobId: number, deps: Pick<TailorDeps, 'store' | 'cv' | 'cfg' | 'pdf'>, today = new Date()) {
  const app = deps.store.latestApplication(jobId);
  if (!app) throw new Error(`#${jobId} has no tailored version yet`);
  const content = JSON.parse(readFileSync(path.join(app.dir, 'content.json'), 'utf8')) as TailoredContent;
  const job = deps.store.get(jobId)!;

  const probe = structuredClone(content) as ContentBody;
  const { issues } = factCheck(probe, deps.cv, postingText(job), content.cvLanguage, deps.cfg);
  const report: VerificationReport = {
    ok: true,
    issues: [
      { severity: 'warning', where: 'content', message: 'edited by hand; re-checked with rules only (no LLM fact-check)' },
      ...issues.map((i) => ({ ...i, severity: 'warning' as const, message: i.message.replace(/; reverted.*$/, '') })),
    ],
    bulletChanges: bulletChanges(content, deps.cv),
    llmChecked: false,
    revised: false,
  };
  // Your hand edits are kept as written: no trimming to fit.
  const { files } = await writeArtifacts(app.dir, content, report, deps, today);
  deps.store.updateApplicationContent(app.id, content, report);
  return { app, report, files };
}

export function formatReport(content: TailoredContent, report: VerificationReport, files: string[]): string {
  const bySeverity = (s: Issue['severity']) => report.issues.filter((i) => i.severity === s);
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none');
  const issueList = (items: Issue[]) => list(items.map((i) => `**${i.where}**: ${i.message}`));
  const lines = [
    `# ${content.company} — ${content.jobTitle} (job #${content.jobId})`,
    '',
    report.ok ? '**Ready to approve.**' : `**Needs your review:** ${bySeverity('unresolved').length} item(s) below could not be verified against your CV.`,
    '',
    `CV in ${content.cvLanguage}, cover letter in ${content.letterLanguage}${report.cvPages ? `, CV is ${report.cvPages} page(s)` : ''}.` +
      `${report.revised ? ' The cover letter was revised once after the fact-check.' : ''}${report.llmChecked ? '' : ' Not LLM-checked (hand edit).'}`,
    '',
    '## Files',
    list(files.map((f) => path.basename(f))),
    '',
    '## Needs your review',
    issueList(bySeverity('unresolved')),
    '',
    '## Posting requirements your CV does not show',
    list(content.notes.requirementsNotMet),
    '',
    '## What was emphasized',
    list(content.notes.emphasized),
    '',
    '## Reworded bullets',
    report.bulletChanges.length
      ? report.bulletChanges.map((c) => `- ~~${c.original}~~\n  → ${c.final}`).join('\n')
      : '- none (all bullets use your exact wording)',
    '',
    '## Automatic fixes',
    issueList(bySeverity('fixed')),
    '',
    '## Warnings',
    issueList(bySeverity('warning')),
    '',
  ];
  return lines.join('\n');
}
