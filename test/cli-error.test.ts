import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { test } from 'node:test';
import { ConfigError } from '../src/config.ts';
import { cliErrorMessage } from '../src/util/cli-error.ts';

const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('did not throw');
};

test('an option the command does not know is one plain line, pointing at help and at updating', () => {
  const err = thrown(() => parseArgs({ args: ['archive', '--recheck', '30'], allowPositionals: true, options: { json: { type: 'boolean' } } }));
  assert.equal(
    cliErrorMessage(err, 'npm run scout -- help'),
    `This version doesn't have the option --recheck. Run "npm run scout -- help" for what it takes. If the option is in the README, update first: git pull`,
  );
});

test('an option missing its value says so without the stack', () => {
  const err = thrown(() => parseArgs({ args: ['--limit'], options: { limit: { type: 'string' } } }));
  const message = cliErrorMessage(err, 'npm run eval')!;
  assert.match(message, /^Option '--limit <value>' argument missing\. Run "npm run eval" for what it takes\./);
});

test('a wrong setting is its own message; anything else is left to show its stack', () => {
  assert.equal(cliErrorMessage(new ConfigError('Missing config/preferences.json'), 'x'), 'Missing config/preferences.json');
  assert.equal(cliErrorMessage(new TypeError('boom'), 'x'), null);
  assert.equal(cliErrorMessage('boom', 'x'), null);
});
