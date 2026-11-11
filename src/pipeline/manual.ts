import type { Preferences } from '../config.ts';
import type { JobStore } from '../db/store.ts';
import type { LinkResult, PagePosting } from '../llm/posting.ts';
import type { Scorer } from '../llm/scorer.ts';
import type { JobRow, JobStatus } from '../types.ts';
import { normalizeCompany, normalizeTitle } from '../util/text.ts';
import { isSameJob } from './dedupe.ts';
import { placeByScore } from './run.ts';

/*
 * A job you add yourself on the review page, from its link. Without a description, the posting is read
 * off that page: Scout's whole process minus searching the job sites. With one, your text is the
 * posting, and the link is only where the Submitter applies. Either way you choose what happens next:
 * score it onto your shortlist, or skip scoring and send it straight to the Tailor. The hard filters
 * are skipped (you chose it), and it stays on your shortlist whatever it scores.
 */

export type ManualNext = 'score' | 'tailor';

export type ManualResult =
  | { ok: true; id: number; title: string; company: string; next: ManualNext; score: number | null; scoreError?: string; cost: number }
  | { ok: false; reason: string; closed?: boolean; existing?: { id: number; status: JobStatus }; cost: number };

export interface ManualDeps {
  store: JobStore;
  prefs: Preferences;
  /** Omitted: the job waits in the queue for Scout's next run to score it. */
  scorer?: Scorer;
  /** Reads the posting off a page (postingFromLink). */
  readPage: (url: string) => Promise<LinkResult>;
  /** Reads which job a pasted description is (pastedPosting). */
  readPasted: (text: string, url: string) => Promise<{ ok: true; posting: PagePosting; cost: number } | { ok: false; reason: string; cost: number }>;
  now?: () => Date;
}

/** Already in your hands: adding it again would apply twice. Scout's leftovers (below cutoff, filtered) aren't. */
const IN_PLAY: readonly JobStatus[] = ['shortlisted', 'selected', 'tailored', 'tailor_error', 'approved', 'needs_manual', 'failed', 'submitted'];

function inPlay(store: JobStore, url: string, posting?: PagePosting): JobRow | undefined {
  const byUrl = store.findByUrl(url);
  if (byUrl && IN_PLAY.includes(byUrl.status)) return byUrl;
  if (!posting) return undefined;
  // The same job found by Scout under another link: same company, near-identical title.
  const probe = { id: -1, source: 'manual' as const, normTitle: normalizeTitle(posting.title), location: posting.location ?? '', descriptionIsPartial: false, firstSeenAt: '', status: 'queued' as const };
  return store
    .dedupeCandidates(normalizeCompany(posting.company), -1)
    .find((c) => IN_PLAY.includes(c.status) && isSameJob(probe, c));
}

export async function addManualJob(
  input: { url: string; description?: string; next?: ManualNext },
  deps: ManualDeps,
): Promise<ManualResult> {
  const { store, prefs } = deps;
  const iso = () => (deps.now ?? (() => new Date()))().toISOString();
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return { ok: false, reason: 'That is not a valid link', cost: 0 };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: 'Paste a web link (https://…)', cost: 0 };
  const pasted = (input.description ?? '').trim();
  // Straight to the Tailor skips scoring: from your description, or from the posting read off the page.
  const next: ManualNext = input.next ?? 'score';

  const before = inPlay(store, url.href);
  if (before) return { ok: false, reason: `already here as #${before.id}`, existing: { id: before.id, status: before.status }, cost: 0 };

  // A page read follows redirects: the address it landed on is where to apply.
  const read = pasted ? { ...(await deps.readPasted(pasted, url.href)), finalUrl: url.href } : await deps.readPage(url.href);
  if (!read.ok) return { ok: false, reason: read.reason, closed: 'closed' in read ? read.closed : undefined, cost: read.cost };
  const { posting, finalUrl: link } = read;
  const same = inPlay(store, link, posting);
  if (same) return { ok: false, reason: `already here as #${same.id}`, existing: { id: same.id, status: same.status }, cost: read.cost };

  const id = store.db.transaction(() => {
    const { id } = store.upsert(
      {
        source: 'manual',
        externalId: link,
        company: posting.company,
        title: posting.title,
        location: posting.location ?? '',
        workplaceType: posting.workplaceType ?? 'unknown',
        url: link,
        description: posting.description,
        descriptionIsPartial: false,
        postedAt: posting.postedAt,
      },
      iso(),
    );
    const how = `${pasted ? 'added by you, with its description' : `added by you, posting read from ${new URL(link).hostname}`}${next === 'tailor' ? ', straight to the Tailor' : ''}`;
    store.setStatus(id, next === 'tailor' ? 'selected' : 'queued', how, 'user', iso(), { resetScore: true });
    return id;
  })();

  const base = { ok: true as const, id, title: posting.title, company: posting.company, next, cost: read.cost };
  if (next === 'tailor' || !deps.scorer) return { ...base, score: null };
  const job = store.get(id)!;
  try {
    const result = await deps.scorer.score(job);
    store.saveScore(id, result, placeByScore(job, result.score, prefs), iso(), deps.scorer.model ?? null);
    return { ...base, score: result.score };
  } catch (err) {
    // Left in the queue: Scout's next run scores it.
    store.recordScoreError(id, (err as Error).message, iso());
    return { ...base, score: null, scoreError: (err as Error).message };
  }
}
