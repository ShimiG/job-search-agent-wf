import { readFileSync } from 'node:fs';
import { MasterCvSchema, type MasterCv } from '../src/config.ts';
import type { ClaimVerifier, DraftInput, TailorWriter } from '../src/tailor/llm.ts';
import { TailorConfigSchema, type Draft, type TailorConfig, type Verdicts } from '../src/tailor/schema.ts';
import type { Claim } from '../src/tailor/verify.ts';

export function exampleCv(): MasterCv {
  return MasterCvSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/master-cv.json', import.meta.url), 'utf8')));
}

export function exampleTailorConfig(overrides: Partial<TailorConfig> = {}): TailorConfig {
  const raw = JSON.parse(readFileSync(new URL('../examples/tailor.json', import.meta.url), 'utf8'));
  return TailorConfigSchema.parse({ ...raw, ...overrides });
}

/** A realistic draft with one honest rewrite and one embellished bullet. */
export function sampleDraft(): Draft {
  return {
    headline: 'Automation & AI Agent Developer',
    summary: {
      text: 'Automation and AI agent developer who owns WhatsApp automation for Northwind Clinics and builds LLM-powered support agents.',
      sources: ['acme-northwind-owner', 'acme-llm-agents'],
    },
    skills: ['REST APIs', 'LLM-powered support agents', 'Kubernetes', 'node.js', 'REST APIs'],
    experience: [
      {
        id: 'acme',
        bullets: [
          { source: 'acme-llm-agents', text: 'Built LLM-powered support agents grounded in a knowledge base, and diagnosed retrieval failures in production' },
          { source: 'acme-booking', text: 'Led a team of 4 building appointment-booking flows on Kubernetes with SOAP and REST integrations' },
          { source: 'acme-northwind-owner', text: 'Sole developer of WhatsApp automation for Northwind Clinics, the company\'s largest account, for four years' },
          { source: 'not-a-real-id', text: 'Invented bullet' },
        ],
      },
    ],
    projects: [
      { id: 'ticket-router', bullets: [{ source: 'ticket-router-pipeline', text: 'Built a multi-source job discovery agent with ATS adapters, deterministic filters, cross-source dedupe and LLM scoring' }] },
      { id: 'ghost-project', bullets: [{ source: 'x', text: 'nope' }] },
    ],
    coverLetter: {
      greeting: 'Dear Acme hiring team,',
      paragraphs: [
        'Your posting describes LLM agents that resolve support conversations, which is the work I do every day.',
        'At Acme Health I am the sole developer of WhatsApp automation for Northwind Clinics and I build LLM-powered support agents grounded in a knowledge base.',
        'I also have five years of Kubernetes experience running production clusters.',
      ].map((text) => ({ text, sources: ['acme-llm-agents'] })),
      closing: 'I would be glad to walk you through these flows.',
    },
    notes: { emphasized: ['LLM agents first'], requirementsNotMet: ['Kubernetes'] },
  };
}

/** Writer stub: returns a fixed draft, records revision requests, and "fixes" flagged paragraphs. */
export class FakeWriter implements TailorWriter {
  drafts: DraftInput[] = [];
  revisions: Array<Array<{ paragraph: number; problem: string }>> = [];
  constructor(private readonly make: () => Draft = sampleDraft, private readonly fix?: (p: string) => string) {}
  async draft(input: DraftInput) {
    this.drafts.push(input);
    return this.make();
  }
  async reviseLetter(_input: DraftInput, paragraphs: string[], problems: Array<{ paragraph: number; problem: string }>) {
    this.revisions.push(problems);
    const flagged = new Set(problems.map((p) => p.paragraph));
    return paragraphs.map((p, i) => (flagged.has(i) ? (this.fix ? this.fix(p) : p) : p));
  }
}

/** Verifier stub: anything mentioning a listed term is unsupported. */
export class FakeVerifier implements ClaimVerifier {
  calls: Claim[][] = [];
  constructor(private readonly unsupportedTerms: string[] = ['Kubernetes', 'Led a team']) {}
  async verify(_cv: MasterCv, _posting: string, claims: Claim[]): Promise<Verdicts> {
    this.calls.push(claims);
    return {
      claims: claims.map((c) => {
        const hit = this.unsupportedTerms.find((t) => c.text.includes(t));
        return { id: c.id, supported: !hit, problem: hit ? `claims ${hit}` : '' };
      }),
    };
  }
}
