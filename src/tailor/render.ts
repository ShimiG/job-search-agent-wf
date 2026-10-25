import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MasterCv } from '../config.ts';
import type { OutputLanguage, TailorConfig, TailoredContent } from './schema.ts';

/*
 * Templates are deliberately plain: one column, real text, standard headings, no tables or
 * icons for layout. That's what ATS parsers read reliably. The model never touches this file;
 * it only supplies content, so layout and your facts (employers, titles, dates) can't drift.
 */

const LABELS: Record<OutputLanguage, Record<string, string>> = {
  en: { summary: 'Summary', experience: 'Experience', projects: 'Projects', skills: 'Skills', education: 'Education', languages: 'Languages', present: 'Present', cv: 'CV', letter: 'Cover Letter', re: 'Application' },
  he: { summary: 'תקציר', experience: 'ניסיון תעסוקתי', projects: 'פרויקטים', skills: 'כישורים', education: 'השכלה', languages: 'שפות', present: 'היום', cv: 'קורות חיים', letter: 'מכתב מקדים', re: 'מועמדות למשרת' },
  ru: { summary: 'О себе', experience: 'Опыт работы', projects: 'Проекты', skills: 'Навыки', education: 'Образование', languages: 'Языки', present: 'н.в.', cv: 'Резюме', letter: 'Сопроводительное письмо', re: 'Отклик на вакансию' },
};

const MONTHS: Record<OutputLanguage, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  he: ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'],
  ru: ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'],
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function formatDate(value: string | undefined, lang: OutputLanguage): string {
  if (!value) return LABELS[lang].present!;
  const m = /^(\d{4})-(\d{2})/.exec(value);
  if (!m) return value;
  const month = MONTHS[lang][Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : m[1]!;
}

const dir = (lang: OutputLanguage) => (lang === 'he' ? 'rtl' : 'ltr');

const BASE_CSS = `
@page { size: A4; margin: 15mm 17mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #1d1d1f; font: 10.3pt/1.42 "Segoe UI", Arial, "Noto Sans Hebrew", "DejaVu Sans", sans-serif; }
h1 { font-size: 20pt; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.headline { font-size: 11.5pt; color: #3a3a3c; margin: 2px 0 4px; }
.contact { font-size: 9.3pt; color: #48484a; }
.contact span + span::before { content: " · "; color: #8e8e93; }
h2 { font-size: 10pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #1f4e79;
     border-bottom: 1px solid #c7d3e0; padding-bottom: 2px; margin: 14px 0 6px; }
.entry { margin-bottom: 8px; break-inside: avoid; }
.entry-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.entry-title { font-weight: 600; }
.entry-meta { color: #48484a; font-size: 9.3pt; white-space: nowrap; }
ul { margin: 3px 0 0; padding-inline-start: 16px; }
li { margin: 1px 0; }
p { margin: 0 0 8px; }
.muted { color: #48484a; }
`;

function contactLine(cv: MasterCv, cfg: TailorConfig): string {
  const parts = [cv.location, cfg.contact.email, cfg.contact.phone, ...Object.values(cv.links)]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s) && !/^todo\b/i.test(s!));
  return parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('');
}

export function renderCvHtml(content: TailoredContent, cv: MasterCv, cfg: TailorConfig): string {
  const lang = content.cvLanguage;
  const L = LABELS[lang];
  const e = escapeHtml;
  const bullets = (items: Array<{ text: string }>) => `<ul>${items.map((b) => `<li>${e(b.text)}</li>`).join('')}</ul>`;

  const experience = content.experience
    .map((x) => {
      const entry = cv.experience.find((c) => c.id === x.id)!;
      return `<div class="entry">
  <div class="entry-head"><div class="entry-title">${e(entry.role)} · ${e(entry.company)}</div>
  <div class="entry-meta">${e(formatDate(entry.start, lang))} – ${e(formatDate(entry.end, lang))}</div></div>
  ${bullets(x.bullets)}
</div>`;
    })
    .join('\n');

  const projects = content.projects
    .map((x) => {
      const p = cv.projects.find((c) => c.id === x.id)!;
      return `<div class="entry">
  <div class="entry-head"><div class="entry-title">${e(p.name)}</div><div class="entry-meta">${e(p.stack.join(', '))}</div></div>
  ${bullets(x.bullets)}
</div>`;
    })
    .join('\n');

  const education = cv.education
    .map((ed) => `<div class="entry"><div class="entry-head"><div class="entry-title">${e(ed.degree)}</div><div class="entry-meta">${e(ed.year ?? '')}</div></div><div class="muted">${e(ed.institution)}</div></div>`)
    .join('\n');

  const languages = cv.languages.map((l) => `${e(l.language)} (${e(l.level)})`).join(' · ');

  return `<!doctype html>
<html lang="${lang}" dir="${dir(lang)}">
<head><meta charset="utf-8"><title>${e(cv.name)} – ${L.cv}</title><style>${BASE_CSS}</style></head>
<body>
<header>
  <h1>${e(cv.name)}</h1>
  <div class="headline">${e(content.headline)}</div>
  <div class="contact">${contactLine(cv, cfg)}</div>
</header>
<h2>${L.summary}</h2>
<p>${e(content.summary)}</p>
<h2>${L.experience}</h2>
${experience}
${projects ? `<h2>${L.projects}</h2>\n${projects}` : ''}
<h2>${L.skills}</h2>
<p>${content.skills.map(e).join(' · ')}</p>
${education ? `<h2>${L.education}</h2>\n${education}` : ''}
${languages ? `<h2>${L.languages}</h2>\n<p>${languages}</p>` : ''}
</body>
</html>
`;
}

export function renderLetterHtml(content: TailoredContent, cv: MasterCv, cfg: TailorConfig, today: Date): string {
  const lang = content.letterLanguage;
  const L = LABELS[lang];
  const e = escapeHtml;
  const date = today.toLocaleDateString(lang === 'he' ? 'he-IL' : lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const letter = content.coverLetter;
  return `<!doctype html>
<html lang="${lang}" dir="${dir(lang)}">
<head><meta charset="utf-8"><title>${e(cv.name)} – ${L.letter}</title><style>${BASE_CSS}
body { font-size: 10.8pt; line-height: 1.55; }
.letter { margin-top: 22px; }
.subject { font-weight: 600; margin: 18px 0 14px; }
</style></head>
<body>
<header>
  <h1>${e(cv.name)}</h1>
  <div class="contact">${contactLine(cv, cfg)}</div>
</header>
<div class="letter">
  <p class="muted">${e(date)}</p>
  <p class="subject">${L.re}: ${e(content.jobTitle)} – ${e(content.company)}</p>
  <p>${e(letter.greeting)}</p>
  ${letter.paragraphs.map((p) => `<p>${e(p)}</p>`).join('\n  ')}
  <p>${e(letter.closing)}</p>
  <p>${e(letter.signOff)},<br>${e(cv.name)}</p>
</div>
</body>
</html>
`;
}

/** File names recruiters will see when the Submitter uploads them. */
export function documentNames(cvName: string) {
  const slug = cvName.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'Candidate';
  return { cv: `${slug}-CV`, letter: `${slug}-Cover-Letter` };
}

export interface PdfEngine {
  /** Renders HTML to a PDF file and returns its page count. */
  render(html: string, outPath: string): Promise<{ pages: number }>;
  close(): Promise<void>;
}

/** Uses your installed Chrome, then Edge (always present on Windows), unless a browserPath is configured. */
export async function launchPdfEngine(browserPath: string): Promise<PdfEngine> {
  const { chromium } = await import('playwright-core');
  const attempts: Array<{ label: string; opts: Parameters<typeof chromium.launch>[0] }> = browserPath
    ? [{ label: browserPath, opts: { executablePath: browserPath } }]
    : [
        { label: 'Google Chrome', opts: { channel: 'chrome' } },
        { label: 'Microsoft Edge', opts: { channel: 'msedge' } },
      ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({ ...attempt.opts, headless: true });
      return {
        async render(html, outPath) {
          const page = await browser.newPage();
          try {
            await page.setContent(html, { waitUntil: 'load' });
            const pdf = await page.pdf({ path: outPath, printBackground: true, preferCSSPageSize: true });
            return { pages: countPdfPages(pdf) };
          } finally {
            await page.close();
          }
        },
        close: () => browser.close(),
      };
    } catch (err) {
      errors.push(`${attempt.label}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(
    `No browser found for PDF rendering (${errors.join('; ')}). Install Chrome, or set pdf.browserPath in config/tailor.json, ` +
      'or set pdf.enabled to false and print the HTML files to PDF yourself.',
  );
}

export function countPdfPages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export function writeText(dirPath: string, name: string, text: string): string {
  const file = path.join(dirPath, name);
  writeFileSync(file, text, 'utf8');
  return file;
}
