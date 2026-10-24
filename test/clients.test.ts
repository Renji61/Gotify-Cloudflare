// Ported from api/client_test.go.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateExpiresAt, clampTime } from '../src/store.ts';
import { formatTime } from '../src/http.ts';
import { createClient, createUser, makeServer, T0 } from './harness.ts';

test('create', async () => {
  const h = await makeServer();
  let res = await h.call('POST', '/client', { ...h.admin, json: { name: 'android' } });
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    /^\{"id":1,"token":"gtfyc\.[A-Za-z0-9_-]{43}","name":"android","createdAt":"2026-01-15T12:00:00Z","lastUsed":null,"expiresAfterInactivitySeconds":0\}$/,
  );
  // the token that is handed out is the private form; the database holds the public form
  const stored = h.store.getClientById(1)!;
  assert.notEqual(stored.token, res.json.token);
  assert.equal(stored.expiresAt, null);

  res = await h.call('POST', '/client', { ...h.admin, json: { name: 'timed', expiresAfterInactivitySeconds: 3600 } });
  assert.equal(res.json.expiresAfterInactivitySeconds, 3600);
  assert.equal(res.json.expiresAt, '2026-01-15T13:00:00Z');

  res = await h.call('POST', '/client', { ...h.admin, form: { name: 'formed', expiresAfterInactivitySeconds: '10' } });
  assert.equal(res.json.expiresAfterInactivitySeconds, 10);

  res = await h.call('POST', '/client', { ...h.admin, json: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'name' is required");
  res = await h.call('POST', '/client', { ...h.admin, json: { name: 'x', expiresAfterInactivitySeconds: -1 } });
  assert.equal(res.status, 400);
});

test('list: own clients, tokens hidden, expired elevation hidden', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const mine = await createClient(h, h.admin, 'mine');
  await createClient(h, { basic: other.basic }, 'theirs');
  let res = await h.call('GET', '/client', h.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, [{ id: mine.id, name: 'mine', createdAt: '2026-01-15T12:00:00Z', lastUsed: null, expiresAfterInactivitySeconds: 0 }]);

  await h.call('POST', `/client/${mine.id}/elevate`, { ...h.admin, json: { durationSeconds: 100 } });
  res = await h.call('GET', '/client', h.admin);
  assert.equal(res.json[0].elevatedUntil, '2026-01-15T12:01:40Z');
  h.clock.now = T0 + 100_000;
  res = await h.call('GET', '/client', h.admin);
  assert.equal(res.json[0].elevatedUntil, undefined);
  // never null, never an empty list as null
  assert.equal((await h.call('GET', '/client', { basic: other.basic })).json.length, 1);
});

test('list: a user without clients gets an empty array', async () => {
  const h = await makeServer();
  assert.equal((await h.call('GET', '/client', h.admin)).text, '[]');
});

test('update', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const client = await createClient(h, h.admin, 'old');
  let res = await h.call('PUT', `/client/${client.id}`, { ...h.admin, json: { name: 'new' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'new');
  assert.equal(res.json.expiresAfterInactivitySeconds, 0);
  // the update response carries the stored token (upstream behaviour)
  assert.equal(res.json.token, h.store.getClientById(client.id)!.token);

  res = await h.call('PUT', `/client/${client.id}`, { ...h.admin, json: { name: 'new', expiresAfterInactivitySeconds: 120 } });
  assert.equal(res.json.expiresAfterInactivitySeconds, 120);
  assert.equal(res.json.expiresAt, '2026-01-15T12:02:00Z');
  // omitted: unchanged
  res = await h.call('PUT', `/client/${client.id}`, { ...h.admin, json: { name: 'renamed' } });
  assert.equal(res.json.expiresAfterInactivitySeconds, 120);
  // explicit 0 turns expiry off
  res = await h.call('PUT', `/client/${client.id}`, { ...h.admin, json: { name: 'renamed', expiresAfterInactivitySeconds: 0 } });
  assert.equal(res.json.expiresAt, undefined);

  res = await h.call('PUT', `/client/${client.id}`, { ...h.admin, json: {} });
  assert.equal(res.status, 400);
  res = await h.call('PUT', '/client/99', { ...h.admin, json: { name: 'x' } });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, "client with id 99 doesn't exists");
  res = await h.call('PUT', `/client/${client.id}`, { basic: other.basic, json: { name: 'stolen' } });
  assert.equal(res.status, 404);
  res = await h.call('PUT', '/client/abc', { ...h.admin, json: { name: 'x' } });
  assert.equal(res.status, 400);
});

test('delete', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const client = await createClient(h, h.admin, 'c');
  let res = await h.call('DELETE', `/client/${client.id}`, { basic: other.basic });
  assert.equal(res.status, 404);
  res = await h.call('DELETE', `/client/${client.id}`, h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(h.store.getClientById(client.id), null);
  res = await h.call('DELETE', `/client/${client.id}`, h.admin);
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, `client with id ${client.id} doesn't exists`);
  assert.equal((await h.call('GET', '/current/user', { key: client.token })).status, 401);
});

test('elevate', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const client = await createClient(h, h.admin, 'c');
  let res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: 900 } });
  assert.equal(res.status, 204);
  assert.equal(h.store.getClientById(client.id)!.elevatedUntil, T0 + 900_000);

  res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'durationSeconds' is required");
  res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: 0 } });
  assert.equal(res.status, 400);
  res = await h.call('POST', '/client/99/elevate', { ...h.admin, json: { durationSeconds: 5 } });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, 'client not found');
  res = await h.call('POST', `/client/${client.id}/elevate`, { basic: other.basic, json: { durationSeconds: 5 } });
  assert.equal(res.status, 404);
  res = await h.call('POST', '/client/abc/elevate', { ...h.admin, json: { durationSeconds: 5 } });
  assert.equal(res.status, 400);
});

test('maintenance deletes expired clients and keeps connected ones alive', async () => {
  const h = await makeServer();
  const idle = await createClient(h, h.admin, 'idle', { expiresAfterInactivitySeconds: 600 });
  const connected = await createClient(h, h.admin, 'connected', { expiresAfterInactivitySeconds: 600 });
  const forever = await createClient(h, h.admin, 'forever');
  const connectedStored = h.store.getClientById(connected.id)!.token;
  await h.call('GET', '/stream', { key: connected.token, headers: { upgrade: 'websocket' } });
  assert.deepEqual(h.hub.connectedTokens(), [connectedStored]);

  // four minutes: nothing to do yet
  h.clock.now = T0 + 4 * 60_000;
  h.server.runMaintenance();
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM clients')!.n, 3);
  // the connected client's expiry was pushed out
  assert.equal(h.sql.first('SELECT expires_at FROM clients WHERE id = ?', connected.id)!.expires_at, T0 + 4 * 60_000 + 600_000);

  // 11 minutes: the idle client is gone
  h.clock.now = T0 + 11 * 60_000;
  h.server.runMaintenance();
  const rows = h.sql.all('SELECT id FROM clients ORDER BY id').map((r) => r.id);
  assert.deepEqual(rows, [connected.id, forever.id]);
  assert.equal((await h.call('GET', '/current/user', { key: idle.token })).status, 401);
  assert.equal((await h.call('GET', '/current/user', { key: connected.token })).status, 200);
});

test('maintenance deletes an expired client whose socket has already dropped', async () => {
  const h = await makeServer();
  const c = await createClient(h, h.admin, 'c', { expiresAfterInactivitySeconds: 60 });
  await h.call('GET', '/stream', { key: c.token, headers: { upgrade: 'websocket' } });
  // the socket dropped before the job ran
  h.hub.sockets[0].closed = true;
  h.clock.now = T0 + 120_000;
  h.server.runMaintenance();
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM clients')!.n, 0);
});

test('alarm schedule: only while something needs it', async () => {
  const h = await makeServer();
  // nothing: no alarm
  assert.equal(h.server.nextAlarmAt(), null);

  // a client that never expires: still nothing
  await createClient(h, h.admin, 'forever');
  assert.equal(h.server.nextAlarmAt(), null);

  // a client with an inactivity expiry: at its expiry
  const timed = await createClient(h, h.admin, 'timed', { expiresAfterInactivitySeconds: 3600 });
  assert.equal(h.server.nextAlarmAt(), T0 + 3600_000);
  assert.equal(h.server.alarmDirty, true);

  // an open socket: every 5 minutes
  await h.call('GET', '/stream', { key: timed.token, headers: { upgrade: 'websocket' } });
  assert.equal(h.server.nextAlarmAt(), T0 + 300_000);
  h.hub.sockets[0].closed = true;
  assert.equal(h.server.nextAlarmAt(), T0 + 3600_000);

  // already overdue: soon, but not in a tight loop
  h.clock.now = T0 + 7200_000;
  assert.equal(h.server.nextAlarmAt(), T0 + 7200_000 + 1000);
  h.server.runMaintenance();
  assert.equal(h.server.alarmDirty, false);
  assert.equal(h.server.nextAlarmAt(), null);

  // deleting the only timed client clears the need
  const again = await createClient(h, h.admin, 'timed2', { expiresAfterInactivitySeconds: 60 });
  assert.notEqual(h.server.nextAlarmAt(), null);
  await h.call('DELETE', `/client/${again.id}`, h.admin);
  assert.equal(h.server.nextAlarmAt(), null);
});

test('huge durations: expiry is rejected with a validation error and nothing is stored', async () => {
  const h = await makeServer();
  const MAX = 9223372036; // what a Go time.Duration can hold, in seconds
  for (const seconds of [1e13, 9223372037]) {
    const res = await h.call('POST', '/client', { ...h.admin, json: { name: 'huge', expiresAfterInactivitySeconds: seconds } });
    assert.equal(res.status, 400, String(seconds));
    assert.equal(res.json.errorDescription, `Field 'expiresAfterInactivitySeconds' must be less or equal to ${MAX}`);
  }
  let res = await h.call('POST', '/client', { ...h.admin, form: { name: 'huge', expiresAfterInactivitySeconds: '10000000000000' } });
  assert.equal(res.status, 400);
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM clients')!.n, 0);

  // the largest allowed value works and everything stays usable
  res = await h.call('POST', '/client', { ...h.admin, json: { name: 'max', expiresAfterInactivitySeconds: MAX } });
  assert.equal(res.status, 200);
  assert.equal(res.json.expiresAfterInactivitySeconds, MAX);
  assert.ok(res.json.expiresAt.startsWith('2'));
  assert.equal((await h.call('GET', '/client', h.admin)).status, 200);
  // updating
  res = await h.call('PUT', `/client/${res.json.id}`, { ...h.admin, json: { name: 'max', expiresAfterInactivitySeconds: 1e13 } });
  assert.equal(res.status, 400);
  assert.equal((await h.call('GET', '/client', h.admin)).status, 200);
});

test('huge durations: elevation is rejected with a validation error', async () => {
  const h = await makeServer();
  const client = await createClient(h, h.admin, 'c');
  let res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: 99999999999999 } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'durationSeconds' must be less or equal to 9223372036");
  res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: -99999999999999 } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'durationSeconds' must be more or equal to -9223372036");
  res = await h.call('GET', '/current/user', { key: client.token });
  assert.equal(res.status, 200);
  assert.equal(res.json.elevatedUntil, undefined);
  // the largest value is fine and formats
  res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: 9223372036 } });
  assert.equal(res.status, 204);
  assert.equal((await h.call('GET', '/current/user', { key: client.token })).status, 200);
  assert.equal((await h.call('GET', '/client', h.admin)).status, 200);
});

test('stored times can never be out of range', async () => {
  // calculateExpiresAt and the store clamp, whatever gets there
  assert.equal(calculateExpiresAt({ expiresAfterInactivitySeconds: 1e13, createdAt: T0, lastUsed: null }), 8.64e15 > T0 + 1e16 ? T0 + 1e16 : 8.64e15);
  assert.equal(clampTime(Infinity), 0);
  assert.equal(clampTime(NaN), 0);
  assert.equal(clampTime(-1e20), -8.64e15);
  const h = await makeServer();
  const c = h.store.createClient({ token: 'Cx', userId: 1, name: 'x', expiresAfterInactivitySeconds: 1e13 });
  assert.ok(c.expiresAt !== null && c.expiresAt <= 8.64e15);
  h.store.updateClientElevatedUntil(c.id, 1e20);
  assert.equal(h.store.getClientById(c.id)!.elevatedUntil, 8.64e15);
  assert.equal((await h.call('GET', '/client', h.admin)).status, 200);
  assert.equal((await h.call('GET', '/current/user', { key: 'Cx' })).status, 200);
  // formatting never throws
  for (const ms of [NaN, Infinity, -Infinity, 1e20, -1e20, 8.64e15 + 1]) assert.doesNotThrow(() => formatTime(ms));
  assert.equal(formatTime(NaN), '1970-01-01T00:00:00Z');
  assert.equal(formatTime(0), '1970-01-01T00:00:00Z');
});
