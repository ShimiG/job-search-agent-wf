import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreferencesSchema, type Preferences } from '../src/config.ts';
import type { Http } from '../src/sources/http.ts';
import type { NormalizedJob } from '../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(path.join(here, 'fixtures', name), 'utf8');
}

export function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name));
}

/**
 * Http stub: maps URL substrings to payloads and records every request. A route's value may be a
 * function of the POST body (or undefined for a GET), for paged APIs.
 */
export function fakeHttp(routes: Record<string, unknown>): Http & { calls: string[]; posts: unknown[] } {
  const calls: string[] = [];
  const posts: unknown[] = [];
  const respond = (url: string, body?: unknown) => {
    calls.push(url);
    // Longest match first, so ".../jobs" doesn't swallow ".../jobs/123".
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!hit) throw new Error(`No fake route for ${url}`);
    const route = routes[hit];
    const payload = typeof route === 'function' ? (route as (b: unknown, u: string) => unknown)(body, url) : route;
    if (payload instanceof Error) throw payload;
    return structuredClone(payload);
  };
  return {
    calls,
    posts,
    async getJson(url: string) {
      return respond(url);
    },
    async postJson(url: string, body: unknown) {
      posts.push(body);
      return respond(url, body);
    },
  };
}

export function makePrefs(overrides: Partial<Record<keyof Preferences, unknown>> = {}): Preferences {
  const examples = JSON.parse(readFileSync(path.join(here, '..', 'examples', 'preferences.json'), 'utf8'));
  return PreferencesSchema.parse({ ...examples, ...overrides });
}

export function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    source: 'greenhouse',
    externalId: 'acme:1',
    company: 'Acme',
    title: 'Automation Engineer',
    location: 'Tel Aviv, Israel',
    workplaceType: 'hybrid',
    url: 'https://example.com/jobs/1',
    description: 'We are looking for an automation engineer to build integrations with our partners and you will work with REST APIs.',
    descriptionIsPartial: false,
    postedAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

export const NOW = new Date('2026-10-15T08:00:00.000Z');
