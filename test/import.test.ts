// Tests for the one-time import (src/import.ts, POST /_import).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashPassword } from '../src/bcrypt.ts';
import { MAX_IMPORT_BYTES, parseDateTime } from '../src/import.ts';
import { makeServer } from './harness.ts';

const TOKEN = 'import-secret';
const APP_TOKEN = 'AV4aaaaaaaaaaaa';
const CLIENT_TOKEN = 'C0Gaaaaaaaaaaaa';

function fixture() {
  return {
    users: [
      { id: 7, name: 'alice', pass: hashPassword('secret', 4), admin: 1, created_at: '2026-01-02 03:04:05.123456789+05:30', oidc_id: null },
    ],
    applications: [
      { id: 3, token: APP_TOKEN, user_id: 7, name: 'second', description: null, internal: 0, image: '', default_priority: null, last_used: null, sort_key: 'a1', created_at: null },
      { id: 2, token: 'AV4bbbbbbbbbbbb', user_id: 7, name: 'first', description: 'd', internal: 0, image: null, default_priority: 4, last_used: '2026-10-23 15:42:58.036749354+05:30', sort_key: 'a0', created_at: '2026-10-01T00:00:00Z' },
      { id: 5, token: 'AV4cccccccccccc', user_id: 7, name: 'nokey', description: '', internal: 1, image: '', default_priority: 0, last_used: null, sort_key: '', created_at: '2026-10-01 00:00:00+00:00' },
    ],
    clients: [
      { id: 4, token: CLIENT_TOKEN, user_id: 7, name: 'phone', last_used: null, created_at: '2026-10-23 15:42:58+05:30', elevated_until: null, expires_after_inactivity_seconds: null, expires_at: null },
    ],
    messages: [
      { id: 10, application_id: 2, message: 'one', title: null, priority: null, extras: '{"b":1,"a":{"z":true}}', date: '2026-10-23 15:42:58.036749354+05:30' },
      { id: 12, application_id: 3, message: 'two', title: 't', priority: 5, extras: '{}', date: '2026-10-23 10:12:58Z' },
    ],
    sequences: { users: 9, applications: 20, clients: 30, messages: 100 },
  };
}

async function imp(h: Awaited<ReturnType<typeof makeServer>>, body: unknown, bearer: string | undefined = TOKEN) {
  return h.call('POST', '/_import', { json: body, bearer });
}

test('parseDateTime: upstream formats', () => {
  assert.equal(parseDateTime('2026-10-23 15:42:58.036749354+05:30', 'x'), Date.UTC(2026, 9, 23, 10, 12, 58, 36));
  assert.equal(parseDateTime('2026-10-23T10:12:58Z', 'x'), Date.UTC(2026, 9, 23, 10, 12, 58));
  assert.equal(parseDateTime('2026-10-23 10:12:58.5-02:00', 'x'), Date.UTC(2026, 9, 23, 12, 12, 58, 500));
  assert.equal(parseDateTime('2026-10-23 10:12:58', 'x'), Date.UTC(2026, 9, 23, 10, 12, 58));
  assert.throws(() => parseDateTime('yesterday', 'x'));
});

test('the route does not exist without GOTIFY_IMPORT_TOKEN', async () => {
  const h = await makeServer();
  const res = await imp(h, fixture());
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, 'page not found');
  assert.equal((await h.call('GET', '/application', h.admin)).status, 200);
});

test('wrong or missing bearer: 401, nothing changes', async () => {
  const h = await makeServer({ importToken: TOKEN });
  for (const bearer of ['nope', '']) {
    const res = await imp(h, fixture(), bearer);
    assert.equal(res.status, 401);
    assert.equal(res.json.errorCode, 401);
  }
  assert.equal((await h.call('GET', '/application', h.admin)).status, 200); // admin still there
});

test('full import, then use the normal API', async () => {
  const h = await makeServer({ importToken: TOKEN });
  const res = await imp(h, fixture());
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { users: 1, applications: 3, clients: 1, messages: 2 });

  // the old admin is gone, the imported user logs in with the imported bcrypt hash
  assert.equal((await h.call('GET', '/application', h.admin)).status, 401);
  const auth = { basic: ['alice', 'secret'] as [string, string] };
  const apps = await h.call('GET', '/application', auth);
  assert.equal(apps.status, 200);
  assert.deepEqual(apps.json.map((a: any) => [a.id, a.name]), [[2, 'first'], [3, 'second'], [5, 'nokey']]);
  assert.equal(apps.json[0].defaultPriority, 4);
  assert.equal(apps.json[0].lastUsed, '2026-10-23T10:12:58.036Z');
  assert.equal(apps.json[1].description, '');
  assert.equal(apps.json[2].internal, true);

  const user = await h.call('GET', '/current/user', auth);
  assert.equal(user.json.admin, true);
  assert.equal((await h.call('GET', '/user', auth)).json[0].id, 7);

  // legacy client token reads the imported messages
  const msgs = await h.call('GET', '/message', { key: CLIENT_TOKEN });
  assert.equal(msgs.status, 200);
  assert.deepEqual(msgs.json.messages.map((m: any) => m.id), [12, 10]);
  const m10 = msgs.json.messages[1];
  assert.deepEqual(m10, { id: 10, appid: 2, message: 'one', title: '', priority: 0, extras: { a: { z: true }, b: 1 }, date: '2026-10-23T10:12:58.036Z' });
  assert.equal(msgs.json.messages[0].extras, undefined);
  assert.equal(msgs.json.messages[0].date, '2026-10-23T10:12:58Z');
  assert.equal((await h.call('GET', '/client', auth)).json[0].id, 4);

  // the legacy app token sends; ids continue after the upstream sequences
  const sent = await h.call('POST', '/message', { key: APP_TOKEN, json: { message: 'new' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.id, 101);
  const newApp = await h.call('POST', '/application', { ...auth, json: { name: 'x' } });
  assert.equal(newApp.json.id, 21);
  assert.ok(newApp.json.sortKey > apps.json[2].sortKey);
  assert.equal((await h.call('POST', '/client', { ...auth, json: { name: 'x' } })).json.id, 31);
  assert.equal((await h.call('POST', '/user', { ...auth, json: { name: 'u', pass: 'p' } })).json.id, 10);
});

test('re-import replaces everything and closes sockets', async () => {
  const h = await makeServer({ importToken: TOKEN });
  assert.equal((await imp(h, fixture())).status, 200);
  h.hub.accept(7, CLIENT_TOKEN);
  const second = fixture();
  second.applications = second.applications.slice(0, 1);
  second.messages = [];
  second.clients = [];
  const res = await imp(h, second);
  assert.deepEqual(res.json, { users: 1, applications: 1, clients: 0, messages: 0 });
  assert.equal(h.hub.open().length, 0);
  assert.equal(h.server.alarmDirty, true);
  const auth = { basic: ['alice', 'secret'] as [string, string] };
  assert.equal((await h.call('GET', '/application', auth)).json.length, 1);
  assert.equal((await h.call('GET', '/message', auth)).json.messages.length, 0);
});

test('bad payloads: 400 and nothing written', async () => {
  const h = await makeServer({ importToken: TOKEN });
  const withImage = fixture();
  (withImage.applications[0] as any).image = 'abc.png';
  const badPass = fixture();
  badPass.users[0].pass = 'plaintext';
  const orphan = fixture();
  orphan.messages[0].application_id = 99;
  const dup = fixture();
  dup.applications[1].token = APP_TOKEN; // unique violation inside the transaction
  const badJson = fixture();
  badJson.messages[0].extras = '{nope';
  const missing: any = fixture();
  delete missing.clients;
  for (const body of [withImage, badPass, orphan, dup, badJson, missing]) {
    const res = await imp(h, body);
    assert.equal(res.status, 400, res.text);
    assert.equal((await h.call('GET', '/application', h.admin)).status, 200); // admin untouched
  }
  const res = await h.call('POST', '/_import', { body: 'not json', headers: { 'content-type': 'application/json' }, bearer: TOKEN });
  assert.equal(res.status, 400);
});

test('no admin among the imported users: 400 and nothing written', async () => {
  const h = await makeServer({ importToken: TOKEN });
  const body = fixture();
  body.users[0].admin = 0;
  const res = await imp(h, body);
  assert.equal(res.status, 400, res.text);
  assert.match(res.json.errorDescription, /admin/);
  assert.equal((await h.call('GET', '/application', h.admin)).status, 200);
});

test('a body over MAX_IMPORT_BYTES: 413 and nothing written', async () => {
  const h = await makeServer({ importToken: TOKEN });
  assert.equal(MAX_IMPORT_BYTES, 16 * 1024 * 1024);
  const res = await h.call('POST', '/_import', {
    body: new Uint8Array(MAX_IMPORT_BYTES + 1),
    headers: { 'content-type': 'application/json' },
    bearer: TOKEN,
  });
  assert.equal(res.status, 413);
  assert.equal(res.json.errorDescription, 'http: request body too large');
  assert.equal((await h.call('GET', '/application', h.admin)).status, 200);
});
