import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COLORS, CV_COLORS, contrast, cssVariables, SHADOWS, TEXT_PAIRS, type Theme } from '../src/design/tokens.ts';
import { PAGE } from '../src/review/page.ts';

const THEMES: Theme[] = ['light', 'dark'];
const css = PAGE.split('<style>')[1]!.split('</style>')[0]!;

describe('design tokens', () => {
  it('keep every text pair at 4.5:1 or more, in both themes', () => {
    for (const theme of THEMES)
      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrast(COLORS[fg][theme], COLORS[bg][theme]);
        assert.ok(ratio >= 4.5, `${fg} on ${bg} (${theme}) is ${ratio.toFixed(2)}:1`);
      }
  });

  it('keep CV text at 4.5:1 or more on the paper', () => {
    for (const name of ['ink', 'headline', 'meta', 'heading'] as const)
      assert.ok(contrast(CV_COLORS[name], CV_COLORS.paper) >= 4.5, name);
  });

  it('define every custom property the review page uses', () => {
    const defined = new Set([...Object.keys(COLORS), ...Object.keys(SHADOWS)]);
    const used = new Set([...css.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]!));
    for (const name of used) assert.ok(defined.has(name), `--${name} is used but not a token`);
  });

  it('are what the review page declares, light first and dark under the media query', () => {
    assert.ok(css.includes(`:root { ${cssVariables('light')} }`));
    const dark = css.split('prefers-color-scheme: dark')[1]!;
    assert.ok(dark.includes(`:root { ${cssVariables('dark')} }`));
  });

  it('leave no other colour written into the review page stylesheet', () => {
    const outside = css.replace(/:root \{[^}]*\}/g, '');
    // The QR code's white is deliberate: it stays white in dark mode so phones can scan it.
    const stray = [...outside.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]).filter((h) => h !== '#fff');
    assert.deepEqual(stray, []);
  });
});
