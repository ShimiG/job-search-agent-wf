import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containsKeyword, diceSimilarity, htmlToText, normalizeCompany, normalizeTitle } from '../src/util/text.ts';

describe('htmlToText', () => {
  it('decodes entity-encoded HTML (Greenhouse style) before stripping tags', () => {
    const text = htmlToText('&lt;p&gt;Hello &lt;strong&gt;world&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;');
    assert.match(text, /Hello world/);
    assert.match(text, /- One/);
    assert.doesNotMatch(text, /<|&lt;/);
  });

  it('keeps literal "&lt;" text in normal HTML', () => {
    assert.equal(htmlToText('<p>a &lt; b</p>'), 'a < b');
  });

  it('handles empty input', () => {
    assert.equal(htmlToText(null), '');
    assert.equal(htmlToText(''), '');
  });
});

describe('normalization', () => {
  it('strips company suffixes in English and Hebrew', () => {
    assert.equal(normalizeCompany('Acme Ltd.'), 'acme');
    assert.equal(normalizeCompany('ACME, Inc'), 'acme');
    assert.equal(normalizeCompany('אקמה בע"מ'), 'אקמה');
  });

  it('removes gender markers from titles', () => {
    assert.equal(normalizeTitle('Backend Developer (m/f/d)'), 'backend developer');
    assert.equal(normalizeTitle('מפתח/ת אוטומציה'), 'מפתח אוטומציה');
  });
});

describe('containsKeyword', () => {
  it('matches whole words only', () => {
    assert.equal(containsKeyword('Senior AI Engineer', 'ai'), true);
    assert.equal(containsKeyword('Maintenance Technician', 'ai'), false);
  });

  it('matches multi-word phrases across punctuation', () => {
    assert.equal(containsKeyword('Full-Stack Developer', 'full stack'), true);
    assert.equal(containsKeyword('Tel-Aviv, Israel', 'tel aviv'), true);
  });

  it('works for Hebrew', () => {
    assert.equal(containsKeyword('מפתח/ת אוטומציה - חולון', 'חולון'), true);
    assert.equal(containsKeyword('מפתחת בכירה', 'מפתח'), false);
  });
});

describe('diceSimilarity', () => {
  it('is 1 for identical strings and high for near-identical ones', () => {
    assert.equal(diceSimilarity('ai automation engineer', 'ai automation engineer'), 1);
    assert.ok(diceSimilarity('ai automation engineer', 'ai automations engineer') > 0.9);
    assert.ok(diceSimilarity('backend engineer', 'senior backend engineer') < 0.9);
  });
});
