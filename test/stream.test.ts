// The /stream endpoint (api/stream), against the fake hub. The hub contract
// itself (WebSocket Hibernation) lives in src/worker.ts and needs the Workers runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp, createClient, createUser, makeServer } from './harness.ts';

const WS = { upgrade: 'websocket' };

test('needs authentication and an upgrade request', async () => {
  const h = await makeServer();
  let res = await h.call('GET', '/stream', { headers: WS });
  assert.equal(res.status, 401);
  res = await h.call('GET', '/stream', h.admin);
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'Bad Request');
  assert.equal(h.hub.open().length, 0);
  // an application token is not enough
  const app = await createApp(h, h.admin, 'a');
  res = await h.call('GET', '/stream', { key: app.token, headers: WS });
  assert.equal(res.status, 401);
});

test('accepts client tokens (query, header, cookie) and basic auth', async () => {
  const h = await makeServer();
  const client = await createClient(h, h.admin, 'phone');
  const stored = h.store.getClientById(client.id)!.token;

  let res = await h.call('GET', `/stream?token=${encodeURIComponent(client.token)}`, { headers: WS });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-fake-upgrade'), 'websocket');
  await h.call('GET', '/stream', { key: client.token, headers: WS });
  await h.call('GET', '/stream', { cookie: `gotify-client-token=${client.token}`, headers: WS });
  await h.call('GET', '/stream', { ...h.admin, headers: WS });

  assert.deepEqual(
    h.hub.sockets.map((s) => [s.userId, s.token]),
    [[1, stored], [1, stored], [1, stored], [1, '']],
  );
  assert.deepEqual(h.hub.connectedTokens(), [stored]);
});

test('messages go to the owner\'s sockets only, in the API\'s JSON format', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const mine = await createApp(h, h.admin, 'mine');
  const theirs = await createApp(h, { basic: other.basic }, 'theirs');
  await h.call('GET', '/stream', { ...h.admin, headers: WS });
  await h.call('GET', '/stream', { ...h.admin, headers: WS });
  await h.call('GET', '/stream', { basic: other.basic, headers: WS });

  const res = await h.call('POST', '/message', { key: mine.token, json: { message: 'hello', extras: { 'a::b': { c: 1 } } } });
  assert.equal(res.status, 200);
  const [s1, s2, s3] = h.hub.sockets;
  assert.deepEqual(s1.received, [res.text]);
  assert.deepEqual(s2.received, [res.text]);
  assert.deepEqual(s3.received, []);
  assert.equal(JSON.parse(s1.received[0]).message, 'hello');

  await h.call('POST', '/message', { key: theirs.token, json: { message: 'secret' } });
  assert.equal(s1.received.length, 1);
  assert.equal(s3.received.length, 1);
  assert.equal(JSON.parse(s3.received[0]).message, 'secret');

  // sent by a client token on behalf of an application
  const client = await createClient(h, h.admin, 'c');
  await h.call('POST', '/message', { key: client.token, json: { message: 'via client', appid: mine.id } });
  assert.equal(s1.received.length, 2);
});

test('a failed message is not broadcast', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  await h.call('GET', '/stream', { ...h.admin, headers: WS });
  await h.call('POST', '/message', { key: app.token, json: { title: 'no message' } });
  assert.equal(h.hub.sockets[0].received.length, 0);
});

test('closing: client deletion, logout, user deletion', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const c1 = await createClient(h, h.admin, 'c1');
  const c2 = await createClient(h, h.admin, 'c2');
  const oc = await createClient(h, { basic: other.basic }, 'oc');
  for (const c of [c1, c1, c2]) await h.call('GET', '/stream', { key: c.token, headers: WS });
  await h.call('GET', '/stream', { key: oc.token, headers: WS });
  await h.call('GET', '/stream', { ...h.admin, headers: WS });
  assert.equal(h.hub.open().length, 5);

  // deleting a client closes only the sockets it opened
  let res = await h.call('DELETE', `/client/${c1.id}`, h.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(h.hub.sockets.map((s) => s.closed), [true, true, false, false, false]);

  // a failed delete closes nothing
  await h.call('DELETE', `/client/${c2.id}`, { basic: other.basic });
  assert.equal(h.hub.open().length, 3);

  // deleting a user closes all of its sockets, and nobody else's
  res = await h.call('DELETE', '/user/1', { basic: ['other', 'pass'] });
  assert.equal(res.status, 403);
  await createUser(h, 'admin2', 'pw', true);
  res = await h.call('DELETE', `/user/${(await h.call('GET', '/user', h.admin)).json.find((u: any) => u.name === 'other').id}`, h.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(h.hub.sockets.map((s) => s.closed), [true, true, false, true, false]);
});

test('websocket origin rules', async () => {
  const h = await makeServer({
    // every origin passes CORS, so that the stream's own origin check decides
    corsAllowOrigins: ['.*'],
    streamAllowedOrigins: ['^allowed\\.example\\.org$', '^.*\\.trusted\\.example$'],
  });
  const stream = (origin?: string) => h.call('GET', '/stream', { ...h.admin, headers: origin ? { ...WS, origin } : WS });

  assert.equal((await stream()).status, 200); // no Origin header (the Android app)
  assert.equal((await stream('https://gotify.example.com')).status, 200); // same host
  assert.equal((await stream('http://GOTIFY.example.com')).status, 200); // host names are compared case-insensitively
  assert.equal((await stream('https://allowed.example.org')).status, 200);
  assert.equal((await stream('https://allowed.example.org:8443')).status, 200); // matches the host name, not the port
  assert.equal((await stream('https://ALLOWED.example.org')).status, 200); // lower-cased before matching
  assert.equal((await stream('https://a.b.trusted.example')).status, 200);

  for (const origin of ['https://evil.example.org', 'https://gotify.example.com:8443', 'https://allowed.example.org.evil.net', 'null', 'garbage']) {
    const res = await stream(origin);
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.errorDescription, 'websocket: request origin not allowed by Upgrader.CheckOrigin');
  }
  assert.equal(h.hub.sockets.length, 7);
});

test('websocket origin rules: nothing configured allows only the same host', async () => {
  const h = await makeServer({ corsAllowOrigins: ['.*'] });
  const stream = (origin: string) => h.call('GET', '/stream', { ...h.admin, headers: { ...WS, origin } });
  assert.equal((await stream('https://gotify.example.com')).status, 200);
  assert.equal((await stream('https://other.example.com')).status, 403);
});

test('a foreign origin is stopped by CORS before the stream is reached', async () => {
  const h = await makeServer({ streamAllowedOrigins: ['.*'] });
  const res = await h.call('GET', '/stream', { ...h.admin, headers: { ...WS, origin: 'https://other.example.com' } });
  assert.equal(res.status, 403);
  assert.equal(res.text, '');
});
