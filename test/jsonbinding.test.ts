// The JSON request binder must report the same errors as Go's encoding/json.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bind, type StructSpec } from '../src/binding.ts';
import { HttpError } from '../src/http.ts';
import { JSON_VECTORS } from './json-vectors.ts';

// the struct the vectors were produced with: main.P
const SPEC = {
  name: 'P',
  pkg: 'main',
  fields: [
    { field: 'Name', json: 'name', form: 'name', type: 'string' },
    { field: 'DefaultPriority', json: 'defaultPriority', form: 'defaultPriority', type: 'int' },
    { field: 'Flag', json: 'flag', form: 'flag', type: 'bool' },
    { field: 'Count', json: 'count', form: 'count', type: 'uint' },
    { field: 'Extras', json: 'extras', form: null, type: 'object' },
    { field: 'Ptr', json: 'ptr', form: 'ptr', type: 'int', pointer: true },
  ],
} as unknown as StructSpec;

test('JSON syntax and type errors match Go', async () => {
  const mismatches: string[] = [];
  for (const [input, expected] of JSON_VECTORS) {
    let actual = 'ok';
    try {
      await bind(
        { method: 'POST', url: new URL('https://x/'), contentType: 'application/json', body: async () => new TextEncoder().encode(input) },
        SPEC,
      );
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      assert.equal(e.status, 400);
      actual = e.description;
    }
    if (actual !== expected) mismatches.push(`${JSON.stringify(input)}\n    go:   ${expected}\n    here: ${actual}`);
  }
  assert.equal(mismatches.length, 0, '\n' + mismatches.join('\n'));
});

test('nesting is capped like Go: deep input is a 400, never a 500', async () => {
  const run = async (n: number) => {
    const body = new TextEncoder().encode('['.repeat(n) + ']'.repeat(n));
    return bind({ method: 'POST', url: new URL('https://x/'), contentType: 'application/json', body: async () => body }, SPEC);
  };
  const tooDeep = (e: unknown) => e instanceof HttpError && e.status === 400 && /exceeded max depth/.test(e.description);
  await assert.rejects(run(10001), tooDeep);
  await assert.rejects(run(200000), tooDeep);
  // shallow nesting still reaches the binder (an array is not an object)
  await assert.rejects(run(100), (e: unknown) => e instanceof HttpError && e.status === 400 && !/exceeded max depth/.test(e.description));
});
