/*
 * Alert emails don't say when a job was posted, and LinkedIn keeps suggesting jobs that are months
 * old. LinkedIn job IDs are handed out in order, though, so an ID's distance below the newest IDs in
 * your recent alerts says roughly how old it is. The rate is fitted from your own alerts each run.
 */

export interface IdClock {
  /** Estimated days since the job with this ID was posted. */
  daysAgo(id: number): number;
  idsPerDay: number;
}

const DAY = 86_400_000;

/**
 * Fits newest-ID-per-day against time. Needs at least 3 days of alerts spanning 4+ days, and a
 * rising trend; otherwise there's no estimate and nothing is dropped.
 */
export function linkedinIdClock(frontier: Array<{ date: string; maxId: number }>, now: Date): IdClock | null {
  const pts = frontier.map((p) => ({ x: new Date(`${p.date}T12:00:00Z`).getTime() / DAY, y: p.maxId })).filter((p) => Number.isFinite(p.x));
  if (pts.length < 3) return null;
  const xs = pts.map((p) => p.x);
  if (Math.max(...xs) - Math.min(...xs) < 4) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const slope = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (!(slope > 0)) return null;
  const newestNow = my + slope * (now.getTime() / DAY - mx);
  return { idsPerDay: slope, daysAgo: (id) => Math.max(0, (newestNow - id) / slope) };
}

export const linkedinJobId = (externalId: string): number | null => {
  const m = /^linkedin:(\d+)$/.exec(externalId);
  return m ? Number(m[1]) : null;
};
