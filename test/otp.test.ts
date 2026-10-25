import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCode } from '../src/submit/otp.ts';

describe('security code emails', () => {
  it('finds the code in common wordings', () => {
    assert.equal(extractCode('Copy and paste this code into the security code field on your application: X7kP2mQa\n\nThanks'), 'X7kP2mQa');
    assert.equal(extractCode('Your verification code is 482913. It expires in 10 minutes.'), '482913');
    assert.equal(extractCode('Security code for your application\n\nHere is your security code:\n\nAB12CD34\n\nIf you did not request it, ignore this email.'), 'AB12CD34');
    assert.equal(extractCode('Your code is QWERTYUI'), 'QWERTYUI');
  });

  it("reads Greenhouse's security code email", () => {
    // The wording of a real one (HTML-only email, as text). The code has expired.
    const email = 'Security code for your application to Similarweb\nCopy and paste this code into the security code field on your application:\n1RH5EOJI\nAfter you enter the code, resubmit your application.\n© 2026 Greenhouse';
    assert.equal(extractCode(email), '1RH5EOJI');
  });

  it('ignores mail without a code', () => {
    assert.equal(extractCode('Thank you for applying to Acme. Your application has been received.'), null);
    assert.equal(extractCode('Enter the code below in the code field.\n\nThanks for applying'), null);
    assert.equal(extractCode('Please enter your security code: please'), null);
  });
});
