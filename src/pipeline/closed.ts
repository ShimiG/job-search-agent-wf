/*
 * Postings that stopped taking applications. Boards drop closed jobs from their API (and Scout closes
 * them), but a job found on a company page or a mirror only says so in its text, or by disappearing.
 */

/** Wording a closed posting uses. Specific phrases only: "closed-loop" or "closed beta" don't count. */
const CLOSED =
  /no longer (?:accepting|taking|open|available|active)|(?:not|stopped) accepting (?:new )?applications|(?:position|role|job|vacancy|posting) (?:has been|is|was) (?:filled|closed|removed)|(?:this )?(?:job|position|posting|vacancy) (?:has|is) (?:expired|closed)|applications? (?:are |is )?(?:now )?closed|job (?:posting )?(?:is )?(?:no longer|not) available|המשרה (?:אינה|לא|כבר לא) (?:רלוונטית|פעילה|זמינה)|המשרה (?:נסגרה|אוישה)|вакансия (?:закрыта|в архиве)/i;

export function looksClosed(text: string): boolean {
  return CLOSED.test(text);
}

export type PageCheck = 'open' | 'closed' | 'unknown';

/**
 * Re-opens a posting page without the model. Closed means gone (404/410), redirected to the board's
 * error page (Greenhouse does that), or saying so. Anything else, including errors, is "unknown".
 */
export async function checkPostingPage(url: string, fetcher: typeof fetch = fetch): Promise<PageCheck> {
  try {
    const res = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0 job-agents' } });
    if (res.status === 404 || res.status === 410) return 'closed';
    if (!res.ok) return 'unknown';
    if (/[?&]error=true\b/.test(res.url)) return 'closed';
    const text = (await res.text()).slice(0, 400_000).replace(/<[^>]+>/g, ' ');
    return looksClosed(text) ? 'closed' : 'open';
  } catch {
    return 'unknown';
  }
}
