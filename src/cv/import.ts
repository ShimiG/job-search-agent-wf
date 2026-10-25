import { inflateSync } from 'node:zlib';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { MasterCvSchema, type MasterCv } from '../config.ts';
import { overlap } from '../llm/enrich.ts';

/*
 * Turns your CV file (PDF or Word) into the master CV the agents work from. Claude reads it and fills
 * the structure, copying your wording: the Tailor later proves every claim against these highlights,
 * so they must be yours. Each highlight is then checked against the file's text, and anything not
 * found there word for word is flagged in the preview before you save.
 */

const Extract = z.object({
  /** Only for PDFs: the CV's full text, so the result can be checked against it. Empty for Word files. */
  transcript: z.string(),
  name: z.string(),
  headline: z.string(),
  location: z.string(),
  summary: z.string(),
  email: z.string(),
  phone: z.string(),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  skills: z.array(z.object({ category: z.string(), items: z.array(z.string()) })),
  experience: z.array(z.object({ company: z.string(), role: z.string(), start: z.string(), end: z.string(), highlights: z.array(z.string()) })),
  projects: z.array(z.object({ name: z.string(), stack: z.array(z.string()), highlights: z.array(z.string()) })),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), year: z.string() })),
  languages: z.array(z.object({ language: z.string(), level: z.string() })),
});
type Extracted = z.infer<typeof Extract>;

const INSTRUCTIONS = `You convert a CV into structured data for a job-application tool. The tool later proves every claim in a tailored CV against what you extract, so copy, never improve:

- Use the CV's own words for every field. Bullet points become highlights exactly as written: don't merge, split, shorten, reword or translate them. Keep the CV's language.
- Add nothing that isn't in the CV. If a field isn't there, leave it empty (or an empty list).
- experience: one entry per role. A company with two roles is two entries. Dates as written, or YYYY-MM when the CV gives a month and year; "end" is empty for a current role.
- headline: the title line under the name, if there is one. summary: the CV's summary or profile paragraph, as written.
- links: LinkedIn, GitHub, portfolio and similar, with full URLs when the CV shows them.
- transcript: when you're given a PDF, its full text in reading order. When you're given text, leave it empty.`;

export interface CvImport {
  cv: MasterCv;
  contact: { email: string; phone: string };
  /** Highlights and summary lines not found word for word in the file. */
  warnings: string[];
  cost: number;
}

/** A short ID part, cut at a word boundary: "acme-ai-automation-developer". */
const slug = (s: string, max = 36) => {
  const full = s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  if (full.length <= max) return full || 'item';
  const cut = full.slice(0, max);
  return cut.slice(0, cut.lastIndexOf('-') > 10 ? cut.lastIndexOf('-') : max) || 'item';
};

/** "Acme — enterprise customer-engagement platform" → "Acme": the name without its description. */
const shortName = (company: string) => company.split(/\s+[—–-]\s+|,|\(|:/)[0]!.trim() || company;

/**
 * Web addresses behind a PDF's links ("LinkedIn" as a clickable word). They aren't visible text, so
 * Claude can't see them unless they're passed along. Reads plain and compressed parts of the file.
 */
export function pdfLinks(file: Buffer): string[] {
  const parts = [file.toString('latin1')];
  for (const m of file.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'));
    } catch {
      // Not a compressed stream (an image, say).
    }
  }
  const urls = parts.flatMap((p) => [...p.matchAll(/\/URI\s*\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!.replace(/\\/g, '')));
  return [...new Set(urls)].filter((u) => !/^mailto:/i.test(u));
}

/** Plain text from a Word file. */
export async function docxText(file: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  return (await mammoth.extractRawText({ buffer: file })).value;
}

/** Shapes Claude's extraction into the master CV, with stable highlight IDs, and checks it against the source text. */
export function toMasterCv(x: Extracted, source: string): Omit<CvImport, 'cost'> {
  const used = new Set<string>();
  // Unique IDs: shortened first, then numbered, so the number is never cut off.
  const unique = (candidate: string) => {
    let out = candidate;
    for (let n = 2; used.has(out); n++) out = `${candidate}-${n}`;
    used.add(out);
    return out;
  };
  const id = (base: string) => unique(slug(base));
  const highlights = (prefix: string, items: string[]) =>
    items.map((t) => t.trim()).filter(Boolean).map((text, i) => ({ id: unique(`${prefix}-${i + 1}`), text }));

  const cv = MasterCvSchema.parse({
    name: x.name.trim(),
    headline: x.headline.trim(),
    location: x.location.trim() || undefined,
    summary: x.summary.trim(),
    skills: x.skills.filter((s) => s.items.length).map((s) => ({ category: s.category.trim() || 'Skills', items: s.items.map((i) => i.trim()).filter(Boolean) })),
    experience: x.experience.map((e) => {
      const key = id(`${shortName(e.company)} ${e.role}`);
      return { id: key, company: e.company.trim(), role: e.role.trim(), start: e.start.trim(), end: e.end.trim() || undefined, highlights: highlights(key, e.highlights) };
    }),
    projects: x.projects.map((p) => {
      const key = id(p.name);
      return { id: key, name: p.name.trim(), stack: p.stack.map((s) => s.trim()).filter(Boolean), highlights: highlights(key, p.highlights) };
    }),
    education: x.education.map((e) => ({ institution: e.institution.trim(), degree: e.degree.trim(), year: e.year.trim() || undefined })),
    languages: x.languages.filter((l) => l.language.trim()).map((l) => ({ language: l.language.trim(), level: l.level.trim() })),
    links: Object.fromEntries(x.links.filter((l) => l.url.trim()).map((l) => [slug(l.label) || 'link', l.url.trim()])),
  });

  const warnings: string[] = [];
  if (!source.trim()) warnings.push('Could not read the text of the file to check the result against it: review everything carefully.');
  else {
    const check = (where: string, text: string) => {
      if (text && overlap(text, source) < 0.8) warnings.push(`${where}: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}" isn't word for word in your file`);
    };
    check('Summary', cv.summary);
    for (const e of cv.experience) for (const h of e.highlights) check(`${e.company} (${e.role})`, h.text);
    for (const p of cv.projects) for (const h of p.highlights) check(p.name, h.text);
  }
  if (!cv.name) warnings.push('No name found.');
  if (!cv.experience.length) warnings.push('No work experience found.');
  return { cv, contact: { email: x.email.trim(), phone: x.phone.trim() }, warnings };
}

export async function importCv(
  file: { data: Buffer; kind: 'pdf' | 'docx' },
  opts: { model?: string; client?: Pick<Anthropic, 'messages'> } = {},
): Promise<CvImport> {
  const client = opts.client ?? new Anthropic({ maxRetries: 3, timeout: 180_000 });
  const model = opts.model ?? 'claude-sonnet-5-5';
  const text = file.kind === 'docx' ? await docxText(file.data) : '';
  const links = file.kind === 'pdf' ? pdfLinks(file.data) : [];
  if (file.kind === 'docx' && !text.trim()) throw new Error('The Word file has no readable text.');
  const content: Anthropic.MessageParam['content'] =
    file.kind === 'pdf'
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data.toString('base64') } },
          { type: 'text', text: `Convert this CV.${links.length ? `\n\nWeb addresses behind the file's links (not visible as text): ${links.join(', ')}` : ''}` },
        ]
      : [{ type: 'text', text: `Convert this CV:\n\n<cv>\n${text}\n</cv>` }];
  const message = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: INSTRUCTIONS,
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(Extract), effort: 'low' },
  });
  if (message.stop_reason === 'refusal') throw new Error('The model declined to read this file.');
  if (message.stop_reason === 'max_tokens') throw new Error('The CV is too long to convert in one go.');
  if (!message.parsed_output) throw new Error('The model returned no CV.');
  const u = message.usage;
  const cost = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0)) * 2 + (u.cache_read_input_tokens ?? 0) * 0.2 + u.output_tokens * 10) / 1e6;
  return { ...toMasterCv(message.parsed_output, text || message.parsed_output.transcript), cost };
}
