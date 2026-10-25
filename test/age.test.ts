import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linkedinIdClock, linkedinJobId } from '../src/pipeline/age.ts';

const now = new Date('2026-10-23T12:00:00Z');
// Newest ID per day grows 0.4M a day, as in real alerts.
const frontier = ['2026-10-16', '2026-10-18', '2026-10-20', '2026-10-22'].map((date, i) => ({ date, maxId: 4_479_000_000 + i * 800_000 }));

describe('LinkedIn job ID age', () => {
  it('estimates age from how far an ID is below the newest ones', () => {
    const clock = linkedinIdClock(frontier, now)!;
    assert.equal(Math.round(clock.idsPerDay), 400_000);
    assert.equal(Math.round(clock.daysAgo(4_481_800_000)), 0);
    assert.equal(Math.round(clock.daysAgo(4_441_800_000)), 100);
  });

  it('gives no estimate from too little data or a flat trend', () => {
    assert.equal(linkedinIdClock(frontier.slice(0, 2), now), null);
    assert.equal(linkedinIdClock(frontier.map((p) => ({ ...p, maxId: 4_480_000_000 })), now), null);
    assert.equal(linkedinIdClock([{ date: '2026-10-20', maxId: 1 }, { date: '2026-10-21', maxId: 2 }, { date: '2026-10-22', maxId: 3 }], now), null, 'spans under 4 days');
  });

  it('reads the ID from LinkedIn alert jobs only', () => {
    assert.equal(linkedinJobId('linkedin:4479965510'), 4479965510);
    assert.equal(linkedinJobId('indeed:1816e1ec47bb370d'), null);
  });
});
