/*
 * Small, dependency-free language detection. Good enough to tell a Hebrew posting from an
 * English one, or spot a German-language posting, which is all the hard filter needs.
 */

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'to', 'of', 'with', 'you', 'we', 'for', 'are', 'our', 'will', 'your', 'in', 'is'],
  de: ['und', 'der', 'die', 'das', 'mit', 'für', 'wir', 'sie', 'ist', 'eine', 'ein', 'zu', 'auf', 'bei', 'deine', 'ihre'],
  fr: ['et', 'le', 'la', 'les', 'des', 'avec', 'pour', 'nous', 'vous', 'est', 'une', 'dans', 'sur', 'votre'],
  nl: ['en', 'het', 'van', 'met', 'voor', 'wij', 'je', 'een', 'zijn', 'jouw', 'onze', 'bij'],
  es: ['y', 'el', 'los', 'las', 'con', 'para', 'nosotros', 'una', 'del', 'por', 'tu', 'nuestro'],
};

export type DetectedLanguage = 'en' | 'he' | 'ru' | 'de' | 'fr' | 'nl' | 'es' | 'unknown';

export function detectLanguage(text: string): DetectedLanguage {
  const sample = text.slice(0, 5000);
  const hebrew = (sample.match(/[\u05D0-\u05EA]/g) ?? []).length;
  const cyrillic = (sample.match(/[\u0400-\u04FF]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  const letters = hebrew + cyrillic + latin;
  if (letters < 20) return 'unknown';
  // Hebrew and Russian postings are full of English tech terms, so a modest share is enough.
  if (hebrew / letters > 0.3) return 'he';
  if (cyrillic / letters > 0.3) return 'ru';

  const words = sample.toLowerCase().match(/[a-zà-ÿ]+/g) ?? [];
  const counts = new Map<string, number>();
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    counts.set(lang, words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0));
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 3) return 'unknown';
  if (second && best[1] < second[1] * 1.3) return 'unknown';
  return best[0] as DetectedLanguage;
}

const NICE_TO_HAVE = /\b(nice to have|a plus|an advantage|advantage|bonus|preferred|beneficial|is a plus|desirable)\b|יתרון/i;
const REQUIRED =
  /\b(fluent|fluency|native|mother tongue|proficien\w*|business[- ]level|professional[- ]level|excellent|strong|required|must|mandatory|essential|c1|c2|b2)\b|חובה|שליטה/i;

/**
 * Returns the first blocked language the posting *requires*, ignoring "nice to have" mentions.
 * Works sentence by sentence so "German is a plus" doesn't trigger, but "Fluent German required" does.
 */
export function findRequiredLanguage(text: string, blocked: readonly string[]): string | undefined {
  if (blocked.length === 0) return undefined;
  const sentences = text.split(/[\n.;!?]+/).map((s) => s.trim()).filter(Boolean);
  for (const lang of blocked) {
    const langRe = new RegExp(`(?:^|[^\\p{L}])${lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}])`, 'iu');
    for (const sentence of sentences) {
      const match = langRe.exec(sentence);
      if (!match) continue;
      if (NICE_TO_HAVE.test(sentence)) continue;
      // Only look near the mention, so "German clients ... Python required" doesn't count.
      const window = sentence.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50);
      if (REQUIRED.test(window) || /[- ]speaking\b/i.test(window)) return lang;
    }
  }
  return undefined;
}
