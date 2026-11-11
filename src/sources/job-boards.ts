/*
 * Job boards you apply through. They write to you from their own address: "your CV was sent",
 * "the employer viewed your CV", and job alerts. The hiring company is only named in the text.
 * The Archiver reads their mail about applications; an application recorded from it is marked as sent
 * on that board. (LinkedIn, Indeed and Greenhouse have their own rules: see archiver/classify.ts.)
 */
export const JOB_BOARDS = [
  { id: 'drushim', label: 'Drushim', search: 'drushim.co.il', domain: /(^|\.)drushim\.co\.il$/i, name: /\bdrushim\b|דרושים IL/i },
  { id: 'jobmaster', label: 'JobMaster', search: 'jobmaster.co.il', domain: /(^|\.)jobmaster\.co\.il$/i, name: /job ?master|ג['׳]?וב ?מאסטר/i },
  { id: 'alljobs', label: 'AllJobs', search: 'alljobs.co.il', domain: /(^|\.)alljobs\.co\.il$/i, name: /\ball ?jobs\b|אול ?ג['׳]?ובס/i },
  { id: 'ziprecruiter', label: 'ZipRecruiter', search: 'ziprecruiter.com', domain: /(^|\.)ziprecruiter\.com$/i, name: /zip ?recruiter/i },
] as const;
export type JobBoardId = (typeof JOB_BOARDS)[number]['id'];

/** The job board an email came from, by its address or, when sent through a mailing service, its name. */
export function jobBoardOf(sender: { fromName: string; fromAddress: string }): JobBoardId | null {
  const domain = sender.fromAddress.split('@')[1] ?? '';
  return JOB_BOARDS.find((b) => b.domain.test(domain) || b.name.test(sender.fromName))?.id ?? null;
}

/** "on Drushim": how an application sent through a board is described, and read back. */
export const boardPhrase = (id: JobBoardId) => `on ${JOB_BOARDS.find((b) => b.id === id)!.label}`;
