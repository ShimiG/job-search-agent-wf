import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectLanguage, findRequiredLanguage } from '../src/pipeline/language.ts';

describe('detectLanguage', () => {
  it('detects English, Hebrew with English terms, Russian and German', () => {
    assert.equal(detectLanguage('We are looking for a developer to join our team and you will work with the platform.'), 'en');
    assert.equal(detectLanguage('אנחנו מחפשים מפתח/ת Node.js עם ניסיון ב-REST APIs ו-JavaScript לצוות שלנו'), 'he');
    assert.equal(detectLanguage('Мы ищем разработчика с опытом работы в команде и знанием JavaScript'), 'ru');
    assert.equal(detectLanguage('Wir suchen eine Entwicklerin für unser Team und die Arbeit mit der Plattform ist spannend.'), 'de');
  });

  it('returns unknown for very short text', () => {
    assert.equal(detectLanguage('Engineer'), 'unknown');
  });
});

describe('findRequiredLanguage', () => {
  const blocked = ['german', 'french'];
  it('flags required languages', () => {
    assert.equal(findRequiredLanguage('Requirements:\nFluent German (C1) is required.', blocked), 'german');
    assert.equal(findRequiredLanguage('You are a French-speaking engineer', blocked), 'french');
  });

  it('ignores nice-to-have mentions and unrelated sentences', () => {
    assert.equal(findRequiredLanguage('German is a plus.', blocked), undefined);
    assert.equal(findRequiredLanguage('French would be an advantage', blocked), undefined);
    assert.equal(findRequiredLanguage('We serve German customers. Strong Python skills required.', blocked), undefined);
  });
});
