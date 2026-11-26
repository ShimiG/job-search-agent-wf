// The design tokens: the one place the review page, the tailored CV and the Submitter's form outline
// take their colours, shadows and font stacks from. The design system on claude.ai mirrors these values
// (names and all), so a change here is the change; re-sync the system after editing.

export type Theme = 'light' | 'dark';

/** A value per theme. Light comes first: it is what the page shows when the OS asks for neither. */
type Themed = Record<Theme, string>;

/** Review page colours, written out as `--<name>` custom properties. */
export const COLORS = {
  bg: { light: '#f6f7f9', dark: '#111317' },
  card: { light: '#ffffff', dark: '#1a1d23' },
  text: { light: '#16181d', dark: '#e8eaee' },
  muted: { light: '#5f6672', dark: '#9aa1ad' },
  line: { light: '#e3e6eb', dark: '#2b3038' },
  accent: { light: '#2f6fec', dark: '#5b8ff5' },
  'accent-text': { light: '#ffffff', dark: '#0b0d10' },
  // Score tiers and states: each colour is text on its -bg tint, and must stay at 4.5:1 or more on it.
  good: { light: '#1b7b44', dark: '#5cc98a' },
  ok: { light: '#0e767d', dark: '#4fc3c9' },
  warn: { light: '#9c5d00', dark: '#e8a948' },
  low: { light: '#656a73', dark: '#9aa1ad' },
  'good-bg': { light: '#e6f5ec', dark: '#173324' },
  'ok-bg': { light: '#e2f4f5', dark: '#133234' },
  'warn-bg': { light: '#fdf1dc', dark: '#3a2c12' },
  'low-bg': { light: '#eef0f3', dark: '#262a31' },
  danger: { light: '#bc3831', dark: '#f07167' },
  'danger-bg': { light: '#fbe7e5', dark: '#3a1d1b' },
  sel: { light: '#eaf1ff', dark: '#1d2a44' },
} as const satisfies Record<string, Themed>;

export type ColorName = keyof typeof COLORS;

/** Review page shadows: also custom properties. Dark mode drops the card shadow and lets borders carry the edge. */
export const SHADOWS = {
  shadow: { light: '0 1px 2px rgba(16, 24, 40, .06)', dark: 'none' },
} as const satisfies Record<string, Themed>;

/** The dialog's shadow is the same in both themes, so it stays a plain value. */
export const DIALOG_SHADOW = '0 12px 40px rgba(0, 0, 0, .25)';

/** The tailored CV prints on white whatever the screen's theme, so its colours have one value each. */
export const CV_COLORS = {
  paper: '#ffffff',
  ink: '#1d1d1f',
  headline: '#3a3a3c',
  meta: '#48484a',
  /** The dot between contact items: decorative, so exempt from the text contrast rule. */
  separator: '#8e8e93',
  heading: '#1f4e79',
  rule: '#c7d3e0',
} as const;

/** The Submitter's outline on form fields that still need an answer. Drawn on other sites' pages. */
export const FORM_FLAG = '#d93025';

export const FONTS = {
  /** The review page: the platform's UI face, so a local page opens with no font to load. */
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Hebrew", sans-serif',
  /** The CV: faces every PDF renderer has, with Hebrew coverage. */
  cv: '"Segoe UI", Arial, "Noto Sans Hebrew", "DejaVu Sans", sans-serif',
} as const;

/** The review page's custom properties for one theme, as declarations for a `:root` block. */
export function cssVariables(theme: Theme): string {
  const all: Record<string, Themed> = { ...COLORS, ...SHADOWS };
  return Object.entries(all)
    .map(([name, value]) => `--${name}: ${value[theme]};`)
    .join(' ');
}

/** The pairs that carry text, as [text, background]: each must keep 4.5:1 in every theme. */
export const TEXT_PAIRS: ReadonlyArray<readonly [ColorName, ColorName]> = [
  ['text', 'bg'], ['text', 'card'], ['text', 'sel'],
  ['muted', 'bg'], ['muted', 'card'],
  ['accent', 'card'], ['accent-text', 'accent'],
  ['good', 'good-bg'], ['ok', 'ok-bg'], ['warn', 'warn-bg'], ['low', 'low-bg'], ['danger', 'danger-bg'],
  ['good', 'card'], ['warn', 'card'], ['danger', 'card'],
  ['bg', 'text'], // the toast inverts the theme
];

/** WCAG 2 contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
