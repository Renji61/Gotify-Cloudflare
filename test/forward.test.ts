import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forwardPlan, MAX_FORWARD_BYTES } from '../src/forward.ts';

const post = (headers: Record<string, string> = {}) => new Request('https://x/message', { method: 'POST', body: 'hi', headers });

test('GET and HEAD are forwarded untouched', () => {
  assert.equal(forwardPlan(new Request('https://x/message')), 'as-is');
  assert.equal(forwardPlan(new Request('https://x/message', { method: 'HEAD' })), 'as-is');
});

test('a body-less POST is forwarded untouched', () => {
  assert.equal(forwardPlan(new Request('https://x/message', { method: 'POST' })), 'as-is');
});

test('a declared oversize body is answered 413 in the Worker', async () => {
  const res = forwardPlan(post({ 'content-length': String(MAX_FORWARD_BYTES + 1) }));
  assert.ok(res instanceof Response);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'Request Entity Too Large', errorCode: 413, errorDescription: 'http: request body too large' });
});

test('a normal POST is buffered, also at the limit', () => {
  assert.equal(forwardPlan(post()), 'buffer');
  assert.equal(forwardPlan(post({ 'content-length': String(2 * 1024 * 1024 + 64 * 1024) })), 'buffer');
});

const MiB = 1024 * 1024;
const postTo = (path: string, length: number) =>
  new Request(`https://x${path}`, { method: 'POST', body: 'hi', headers: { 'content-length': String(length) } });

test('only /_import may go up to the import cap; other paths stop at 2 MiB', () => {
  const res = forwardPlan(postTo('/message', 3 * MiB));
  assert.ok(res instanceof Response);
  assert.equal(res.status, 413);
  assert.equal(forwardPlan(postTo('/message', 2 * MiB)), 'buffer');
  assert.equal(forwardPlan(postTo('/_import', 10 * MiB)), 'buffer');
  assert.ok(forwardPlan(postTo('/_import', MAX_FORWARD_BYTES + 1)) instanceof Response);
});

test('a configured larger or unlimited body limit is still capped at the import cap', () => {
  assert.equal(forwardPlan(postTo('/message', 8 * MiB), 10 * MiB), 'buffer');
  assert.ok(forwardPlan(postTo('/message', 3 * MiB), 1 * MiB) instanceof Response);
  assert.equal(forwardPlan(postTo('/message', 10 * MiB), 0), 'buffer');
  assert.ok(forwardPlan(postTo('/message', MAX_FORWARD_BYTES + 1), 0) instanceof Response);
});
