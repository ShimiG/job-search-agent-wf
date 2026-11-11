import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAGE } from '../src/review/page.ts';

describe('review page', () => {
  it('ships a client script that parses', () => {
    const script = PAGE.split('<script>')[1]!.split('</script>')[0]!;
    assert.doesNotThrow(() => new Function(script));
  });
});
