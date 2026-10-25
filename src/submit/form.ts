import type { Frame, Locator, Page } from 'playwright-core';
import { diceSimilarity, normalizeForMatch } from '../util/text.ts';
import type { FormField, PlannedAnswer } from './schema.ts';

/*
 * Reading forms generically, by accessible labels rather than per-site CSS selectors, is what lets
 * one Submitter handle Greenhouse, Lever, Ashby, Workable and embedded iframes. Everything is
 * located through a data-ja-key attribute the extraction script writes onto each field.
 *
 * The in-page scripts are plain JS strings on purpose: TypeScript runners inject helper calls
 * into compiled functions, and those helpers don't exist inside the browser.
 */

const EXTRACT_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el ? (el.innerText || el.textContent) : '');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const byIds = (ids) => clean((ids || '').split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
  const ownLabel = (el) => {
    if (el.getAttribute('aria-labelledby')) { const t = byIds(el.getAttribute('aria-labelledby')); if (t) return t; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && textOf(l)) return textOf(l); }
    const wrap = el.closest('label'); if (wrap && textOf(wrap)) return textOf(wrap);
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    return '';
  };
  const questionText = (el, exclude) => {
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg && textOf(lg)) return textOf(lg); }
    let node = el.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      const cands = node.querySelectorAll(':scope > label, :scope > legend, :scope > div, :scope > span, :scope > p, :scope > h3, :scope > h4');
      for (const c of cands) {
        if (c.contains(el) || (exclude && exclude.some((x) => c.contains(x)))) continue;
        if (c.querySelector('input, select, textarea')) continue;
        const t = textOf(c);
        if (t && t.length < 300) return t;
      }
    }
    return '';
  };
  const isRequired = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(label) || /\(required\)/i.test(label);
  const tidy = (label) => clean(label.replace(/\(required\)/ig, '').replace(/[\s*✱]+$/, ''));

  const fields = [];
  let n = 0;
  const seenGroups = new Set();
  const els = document.querySelectorAll('input, select, textarea, [role="combobox"]:not(input):not(select)');
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'].includes(type)) continue;
    if (el.disabled) continue;
    if (type !== 'file' && !visible(el) && !(type === 'radio' || type === 'checkbox')) continue;
    // Widgets keep invisible required inputs for their own validation (react-select, phone pickers).
    if (type !== 'radio' && type !== 'checkbox' && el.closest('[aria-hidden="true"]')) continue;

    if (type === 'radio' || type === 'checkbox') {
      const name = el.getAttribute('name') || '';
      const group = name ? [...document.querySelectorAll('input[type="' + type + '"][name="' + CSS.escape(name) + '"]')] : [el];
      if (group.length > 1 || type === 'radio') {
        if (seenGroups.has(type + ':' + name)) continue;
        seenGroups.add(type + ':' + name);
        const key = 'f' + (n++);
        const options = group.map((g) => { g.setAttribute('data-ja-key', key); return tidy(ownLabel(g) || g.value || ''); });
        const raw = questionText(el, group) || name;
        fields.push({ key, kind: type, label: tidy(raw), required: group.some((g) => isRequired(g, raw)), options, name });
        continue;
      }
      const key = 'f' + (n++);
      el.setAttribute('data-ja-key', key);
      const raw = ownLabel(el) || questionText(el) || name;
      fields.push({ key, kind: 'checkbox', label: tidy(raw), required: isRequired(el, raw), options: [], name });
      continue;
    }

    const key = 'f' + (n++);
    el.setAttribute('data-ja-key', key);
    let raw = ownLabel(el) || questionText(el) || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    // Upload buttons are often all labelled "Attach"; the input's name says which document it wants.
    if (type === 'file' && /^(attach|upload|browse|choose( a)? file|select( a)? file)$/i.test(tidy(raw))) {
      const what = clean((el.getAttribute('name') || el.id || '').replace(/[_-]+/g, ' '));
      if (what) raw = tidy(raw) + ' (' + what + ')';
    }
    let kind = type;
    if (tag === 'select') kind = 'select';
    else if (tag === 'textarea') kind = 'textarea';
    else if (el.getAttribute('role') === 'combobox') kind = 'combobox';
    else if (!['text', 'email', 'tel', 'url', 'number', 'date', 'file'].includes(type)) kind = 'text';
    const options = tag === 'select'
      ? [...el.options].filter((o) => o.value !== '' && !/^(select|choose|please select|--)/i.test(clean(o.text))).map((o) => clean(o.text))
      : [];
    fields.push({
      key, kind, label: tidy(raw), required: isRequired(el, raw), options,
      name: el.getAttribute('name') || el.id || '',
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      accept: el.getAttribute('accept') || undefined,
    });
  }
  return fields;
})()`;

/** Visible fields only: a hidden form (behind an Apply button) should count as no form yet. */
const COUNT_SCRIPT = String.raw`(() => [...document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea')]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length)()`;

const BLOCKER_SCRIPT = String.raw`(() => {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 30 && r.height > 30 && st.visibility !== 'hidden' && st.display !== 'none'; };
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.getAttribute('src') || '';
    if (/hcaptcha\.com/.test(src) && vis(f)) out.push('CAPTCHA (hCaptcha)');
    else if (/recaptcha/.test(src) && /anchor|bframe/.test(src) && vis(f) && !f.closest('.grecaptcha-badge')) out.push('CAPTCHA (reCAPTCHA)');
    else if (/challenges\.cloudflare\.com/.test(src) && vis(f)) out.push('CAPTCHA (Turnstile)');
  }
  const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  if ([...document.querySelectorAll('input[type=password]')].some(shown)) out.push('sign-in or account creation');
  return [...new Set(out)];
})()`;

const BODY_TEXT_SCRIPT = String.raw`(() => (document.body ? document.body.innerText : '').slice(0, 6000))()`;

const CONFIRM_TEXT =
  /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent)|we('ve| have) received your application|successfully (applied|submitted)|תודה על (הגשת|פנייתך|מועמדותך)|קיבלנו את (המועמדות|פנייתך)|спасибо за (отклик|заявку)/i;
const CONFIRM_URL = /\/(confirmation|thank-?you|thanks|submitted|success)(\b|\/|\?|$)/i;

/** The frame holding the application form: often the page, sometimes an embedded ATS iframe. */
export async function findFormFrame(page: Page): Promise<{ frame: Frame; count: number }> {
  let best = { frame: page.mainFrame(), count: -1 };
  for (const frame of page.frames()) {
    const count = (await frame.evaluate(COUNT_SCRIPT).catch(() => 0)) as number;
    if (count > best.count) best = { frame, count };
  }
  return best;
}

/** Job pages often hide the form behind an "Apply" button. */
export async function revealForm(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const button = frame
      .locator('a, button')
      .filter({ hasText: /^\s*(apply( for this (job|position|role))?( now)?|הגש(ת)? מועמדות|откликнуться)\s*$/i })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1200);
      return true;
    }
  }
  return false;
}

export async function extractFields(frame: Frame): Promise<FormField[]> {
  return (await frame.evaluate(EXTRACT_SCRIPT)) as FormField[];
}

export async function detectBlockers(page: Page): Promise<string[]> {
  const found = new Set<string>();
  for (const frame of page.frames()) {
    for (const b of ((await frame.evaluate(BLOCKER_SCRIPT).catch(() => [])) as string[])) found.add(b);
  }
  return [...found];
}

export async function detectConfirmation(page: Page): Promise<string | null> {
  if (page.isClosed()) return null;
  for (const frame of page.frames()) {
    if (CONFIRM_URL.test(frame.url())) return `confirmation page: ${frame.url()}`;
    const text = ((await frame.evaluate(BODY_TEXT_SCRIPT).catch(() => '')) as string) ?? '';
    const m = CONFIRM_TEXT.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Whether the page is about this job: most of the title's words appear on it. Guards application pages
 * found by the web lookup, so a careers page for another role is never filled in your name.
 */
export async function pageMentionsTitle(page: Page, title: string): Promise<boolean> {
  const words = normalizeForMatch(title).split(' ').filter((w) => w.length >= 3);
  if (!words.length) return true;
  let text = '';
  for (const frame of page.frames()) text += ' ' + (((await frame.evaluate(String.raw`(() => document.body ? document.body.innerText.slice(0, 20000) : '')()`).catch(() => '')) as string) ?? '');
  const onPage = new Set(normalizeForMatch(text).split(' '));
  return words.filter((w) => onPage.has(w)).length / words.length >= 0.6;
}

/** Index of the option that best matches the wanted answer, or -1. */
export function bestOption(options: string[], wanted: string): number {
  const w = normalizeForMatch(wanted);
  if (!w) return -1;
  const norm = options.map(normalizeForMatch);
  let i = norm.indexOf(w);
  if (i >= 0) return i;
  i = norm.findIndex((o) => o.startsWith(w) || w.startsWith(o));
  if (i >= 0 && Math.min(w.length, norm[i]!.length) >= 2) return i;
  let best = -1;
  let score = 0.75;
  norm.forEach((o, idx) => {
    const s = diceSimilarity(o, w);
    if (s > score) [best, score] = [idx, s];
  });
  return best;
}

/**
 * Index of the autocomplete suggestion for a wanted value like "Holon, Israel", or -1.
 * Every comma-separated part must appear as whole words, so "Holon" never picks "Holonga, Tonga".
 */
export function bestSuggestion(options: string[], wanted: string): number {
  const norm = options.map(normalizeForMatch);
  const exact = norm.indexOf(normalizeForMatch(wanted));
  if (exact >= 0) return exact;
  const parts = wanted.split(',').map(normalizeForMatch).filter(Boolean);
  if (!parts.length) return -1;
  const word = (p: string) => new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  const all = norm.findIndex((o) => parts.every((p) => word(p).test(o)));
  if (all >= 0) return all;
  const first = norm.findIndex((o) => word(parts[0]!).test(o));
  return first >= 0 ? first : bestOption(options, wanted);
}

const locate = (frame: Frame, key: string): Locator => frame.locator(`[data-ja-key="${key}"]`);

/**
 * While fields are being filled, the form can't submit. A stray Enter in a text box submits most
 * forms, and an application sent half-filled can't be taken back.
 */
export async function guardSubmit(frame: Frame, on: boolean): Promise<void> {
  const script = on
    ? `(() => { if (window.__jaGuard) return; window.__jaGuard = (e) => { e.preventDefault(); e.stopImmediatePropagation(); }; window.addEventListener('submit', window.__jaGuard, true); })()`
    : `(() => { if (window.__jaGuard) window.removeEventListener('submit', window.__jaGuard, true); window.__jaGuard = undefined; })()`;
  await frame.evaluate(script).catch(() => undefined);
}

/** Fills one planned answer. Never throws: failures are recorded on the answer. */
export async function fillAnswer(frame: Frame, field: FormField, answer: PlannedAnswer): Promise<void> {
  if (!answer.value) return;
  const el = locate(frame, field.key);
  try {
    switch (field.kind) {
      case 'file':
        await el.first().setInputFiles(answer.value);
        break;
      case 'select': {
        const i = bestOption(field.options, answer.value);
        if (i < 0) throw new Error(`no option matches "${answer.value}"`);
        await el.first().selectOption({ label: field.options[i]! });
        break;
      }
      case 'radio': {
        const i = bestOption(field.options, answer.value);
        if (i < 0) throw new Error(`no option matches "${answer.value}"`);
        await el.nth(i).check({ force: true });
        break;
      }
      case 'checkbox': {
        if (field.options.length === 0) {
          if (answer.value === 'true') await el.first().check({ force: true });
          break;
        }
        for (const part of answer.value.split(' | ')) {
          const i = bestOption(field.options, part);
          if (i < 0) throw new Error(`no option matches "${part}"`);
          await el.nth(i).check({ force: true });
        }
        break;
      }
      case 'combobox': {
        // Autocompletes only accept a value picked from their suggestions. Search by the first part
        // ("Holon" of "Holon, Israel"), choose the best suggestion, and never press Enter: that submits the form.
        const box = el.first();
        await box.click();
        await box.fill('');
        await box.pressSequentially(answer.value.split(',')[0]!.trim(), { delay: 40 });
        const options = frame.getByRole('option');
        await options.first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => undefined);
        const i = bestSuggestion(await options.allInnerTexts().catch(() => []), answer.value);
        if (i < 0) {
          await box.fill('').catch(() => undefined);
          await box.press('Escape').catch(() => undefined);
          throw new Error(`no suggestion matches "${answer.value}"`);
        }
        answer.value = (await options.nth(i).innerText()).trim();
        await options.nth(i).click();
        break;
      }
      default:
        await el.first().fill(field.maxLength ? answer.value.slice(0, field.maxLength) : answer.value);
    }
    answer.filled = true;
  } catch (err) {
    answer.filled = false;
    answer.error = (err as Error).message.split('\n')[0];
  }
}

/** Outlines fields you still need to handle, so they're easy to find in assist mode. */
export async function highlight(frame: Frame, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await frame
    .evaluate(
      `(() => { for (const k of ${JSON.stringify(keys)}) for (const el of document.querySelectorAll('[data-ja-key="' + k + '"]')) { el.style.outline = '3px solid #d93025'; el.style.outlineOffset = '2px'; } })()`,
    )
    .catch(() => undefined);
}

/**
 * Empty, visible inputs asking for an emailed security code: one box, or a row of one-character
 * boxes. Marks them with data-ja-code and returns how many there are.
 */
const CODE_FIELDS_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const text = (id) => { const n = id && document.getElementById(id); return n ? n.textContent : ''; };
  const describe = (el) => clean([
    el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.id, el.getAttribute('autocomplete'),
    (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(text).join(' '),
    el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]') ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]').textContent : '',
  ].join(' '));
  const empty = [...document.querySelectorAll('input')].filter((el) =>
    ['text', 'tel', 'number', ''].includes((el.getAttribute('type') || 'text').toLowerCase()) && vis(el) && !el.disabled && !el.value);
  const notCode = /zip|postal|post ?code|country|area|promo|referral|discount|coupon|voucher/i;
  let hits = empty.filter((el) => /security.?code|verification.?code|\botp\b|one-time-code|one.?time.?code|passcode/i.test(describe(el)));
  // Otherwise only when the page itself says a code was sent, so an empty "source code link" field isn't one.
  const prompt = /security code|verification code|one[- ]time (pass)?code|enter the code|code (was|has been) sent/i.test(document.body ? document.body.innerText : '');
  if (!hits.length && prompt) hits = empty.filter((el) => /code/i.test(describe(el)) && !notCode.test(describe(el)));
  if (!hits.length && prompt) hits = empty.filter((el) => el.maxLength === 1);
  if (!hits.length) return 0;
  hits.forEach((el, i) => el.setAttribute('data-ja-code', String(i)));
  return hits.length;
})()`;

/** Where the page is asking for an emailed security code, if it is. */
export async function findCodeFields(page: Page): Promise<{ frame: Frame; count: number } | null> {
  for (const frame of page.frames()) {
    const count = (await frame.evaluate(CODE_FIELDS_SCRIPT).catch(() => 0)) as number;
    if (count > 0) return { frame, count };
  }
  return null;
}

/** Types the code. A row of one-character boxes usually moves focus by itself, so type it as keystrokes. */
export async function fillCode(target: { frame: Frame; count: number }, code: string): Promise<void> {
  const first = target.frame.locator('[data-ja-code="0"]');
  if (target.count === 1) {
    await first.fill(code);
    return;
  }
  await first.click();
  await target.frame.page().keyboard.type(code, { delay: 60 });
}

/**
 * Only a button that says submit/apply/send. No fallback to "the first button": on the wrong page
 * that could be "Sign in" or "Upload", and clicking the wrong thing in your name is worse than stopping.
 */
export async function findSubmitButton(frame: Frame): Promise<Locator | null> {
  const candidates = frame.locator('button[type=submit], input[type=submit], button:not([type])');
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const c = candidates.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const text = ((await c.innerText().catch(() => '')) || (await c.getAttribute('value')) || '').trim();
    if (/submit|apply|send|הגש|שלח|отправ/i.test(text) && !/sign|log ?in|upload|attach/i.test(text)) return c;
  }
  return null;
}
