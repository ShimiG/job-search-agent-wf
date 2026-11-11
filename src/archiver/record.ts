import type { JobStore, ResponseRecord } from '../db/store.ts';
import { recordApplications } from '../pipeline/applied.ts';
import { jobBoardOf } from '../sources/job-boards.ts';
import { groupApplications, matchApplication } from './report.ts';

type Reply = Pick<ResponseRecord, 'company' | 'title' | 'kind' | 'receivedAt' | 'subject' | 'fromName' | 'fromAddress'>;
type Rows = Parameters<typeof matchApplication>[1];

/**
 * Where a reply belongs: under the application it matches, or, when nothing recorded that application
 * (you applied yourself and no confirmation reached Scout), under a new one made from the email. A
 * confirmation, a rejection, an assessment, an interview or an offer all mean you applied, so the
 * application is recorded as sent "from your email", dated by it, and counts like any other. It needs
 * a company or a role to go by; a reply naming neither stays unmatched.
 */
export function fileReply(store: JobStore, r: Reply, rows: Rows, now: string): { jobId: number | null; created: boolean } {
  if (r.kind === 'not_related') return { jobId: null, created: false };
  const matched = matchApplication(r, rows);
  if (matched !== null) return { jobId: matched, created: false };
  const company = r.company.trim();
  const title = r.title.trim();
  if (!company && !title) return { jobId: null, created: false };
  const { matched: known, added } = recordApplications(
    store,
    // A reply from a job board says where you applied; any other only that you did.
    [{ company, title, via: jobBoardOf(r) ?? 'email', appliedAt: r.receivedAt, rejected: r.kind === 'rejection', subject: r.subject }],
    now,
    { repliesToo: true },
  );
  if (!known && !added) return { jobId: null, created: false };
  return { jobId: matchApplication(r, groupApplications(store.sentApplications())), created: true };
}
