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

/** A LinkedIn job's public page, the kind an alert email links to: linkedin.com/jobs/view/<id>. */
export function isLinkedInJob(url: string): boolean {
  const u = URL.parse(url);
  return Boolean(u && /(^|\.)linkedin\.com$/i.test(u.hostname) && /^\/jobs\/view\//.test(u.pathname));
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/**
 * Re-opens a LinkedIn job's public page, the one anyone sees without signing in, to read whether it
 * still takes applications: one plain request, no search, no sign-in, nothing submitted. LinkedIn
 * marks a closed job with a "No longer accepting applications" banner. A page we can't read (a sign-in
 * wall, a rate limit, a layout without the job's title) is "unknown", never "closed".
 */
export async function checkLinkedInJob(url: string, fetcher: typeof fetch = fetch): Promise<PageCheck> {
  try {
    const res = await fetcher(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' },
    });
    if (res.status === 404 || res.status === 410) return 'closed';
    if (!res.ok) return 'unknown';
    if (/authwall|\/login|\/checkpoint|\/uas\//.test(res.url)) return 'unknown';
    const html = (await res.text()).slice(0, 600_000);
    if (/closed-job__flavor--closed|No longer accepting applications/i.test(html)) return 'closed';
    return /topcard__title|top-card-layout__title/.test(html) ? 'open' : 'unknown';
  } catch {
    return 'unknown';
  }
}

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
