import { createHash } from 'node:crypto';
import { convert } from 'html-to-text';

const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'ul', options: { itemPrefix: '- ' } },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'table', format: 'dataTable' },
  ],
};

/**
 * HTML to readable plain text. Handles entity-encoded HTML too
 * (Greenhouse returns "&lt;p&gt;..." instead of "<p>...").
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let source = html;
  if (/&lt;\/?[a-z][\s\S]*?&gt;/i.test(source) && !/<\/?[a-z][^>]*>/i.test(source)) {
    source = convert(source, { wordwrap: false });
  }
  // Lever list sections are bare <li> items; without a <ul> they'd run together on one line.
  if (/<li[\s>]/i.test(source) && !/<(ul|ol)[\s>]/i.test(source)) source = `<ul>${source}</ul>`;
  return tidyText(convert(source, HTML_TO_TEXT_OPTIONS));
}

export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lowercase, Unicode-normalized, punctuation collapsed to single spaces. Keeps Hebrew/Cyrillic letters. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '') // Hebrew niqqud / cantillation
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const COMPANY_SUFFIXES = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'llc', 'gmbh', 'ag', 'sa', 'bv', 'corp', 'corporation',
  'co', 'plc', 'בעמ', 'בע', 'מ',
]);

export function normalizeCompany(name: string): string {
  const cleaned = name.normalize('NFKC').replace(/["'״׳]/g, '');
  const tokens = normalizeForMatch(cleaned).split(' ').filter(Boolean);
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(' ');
}

/** Gender markers like (m/f/d), (M/F), /ית are noise for matching titles. */
export function normalizeTitle(title: string): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(/\((?:m|f|w|d|x|all genders?)(?:\s*[/|,]\s*(?:m|f|w|d|x))*\)/gi, ' ')
    .replace(/\/(?:ית|ה|ת)(?=\s|$)/g, ' ');
  return normalizeForMatch(cleaned);
}

const keywordRegexCache = new Map<string, RegExp>();

/**
 * Whole-word, case-insensitive keyword match that works for Hebrew and multi-word phrases.
 * JS \b is ASCII-only, so boundaries are defined as "not a letter or digit".
 */
export function containsKeyword(text: string, keyword: string): boolean {
  const kw = normalizeForMatch(keyword);
  if (!kw) return false;
  let re = keywordRegexCache.get(kw);
  if (!re) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u');
    keywordRegexCache.set(kw, re);
  }
  return re.test(normalizeForMatch(text));
}

export function findKeyword(text: string, keywords: readonly string[]): string | undefined {
  return keywords.find((kw) => containsKeyword(text, kw));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, '') + '\n[...truncated]';
}

/** Sørensen–Dice coefficient over character bigrams. 1 = identical. */
export function diceSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, ' ');
  const y = b.replace(/\s+/g, ' ');
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const bg = x.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const bg = y.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      overlap++;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

export function titleCase(text: string): string {
  return text.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
