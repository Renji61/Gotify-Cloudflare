// Ported from api/user_test.go and api/session_test.go.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { comparePassword, hashStats } from '../src/bcrypt.ts';
import { createApp, createClient, createUser, makeServer, T0 } from './harness.ts';

const badRequest = (description: string) => ({ error: 'Bad Request', errorCode: 400, errorDescription: description });

test('first run creates the administrator from the configuration', async () => {
  const h = await makeServer();
  const user = h.store.getUserByName('admin')!;
  assert.equal(user.admin, true);
  assert.equal(comparePassword(user.pass, 'admin'), true);
  assert.match(user.pass, /^\$2a\$04\$/); // passStrength 4 in the harness
  assert.equal(await h.server.initialize(), 'exists');
  assert.equal(h.store.countUsers(), 1);
});

test('no default password configured: no administrator is created', async () => {
  const h = await makeServer({ defaultUser: { name: 'admin', pass: undefined } });
  assert.equal(h.store.countUsers(), 0);
  assert.equal(await h.server.initialize(), 'no-password');
  // and nobody can log in
  const res = await h.call('GET', '/current/user', { basic: ['admin', 'admin'] });
  assert.equal(res.status, 401);
});

test('first run is closed without the secret: no users, no admin/admin, no registration', async () => {
  const h = await makeServer({ defaultUser: { name: 'admin', pass: undefined } });
  assert.equal(h.store.countUsers(), 0);
  let res = await h.call('GET', '/user', { basic: ['admin', 'admin'] });
  assert.equal(res.status, 401);
  res = await h.call('POST', '/user', { json: { name: 'mallory', pass: 'x', admin: true } });
  assert.equal(res.status, 401);
  assert.equal(h.store.countUsers(), 0);

  // with the secret set the administrator exists and can log in with it
  const ok = await makeServer({ defaultUser: { name: 'admin', pass: 'long-unique-secret' } });
  assert.equal(ok.store.countUsers(), 1);
  assert.equal((await ok.call('GET', '/user', { basic: ['admin', 'long-unique-secret'] })).status, 200);
  assert.equal((await ok.call('GET', '/user', { basic: ['admin', 'admin'] })).status, 401);
});

test('a configured name and a password over 72 bytes', async () => {
  const h = await makeServer({ defaultUser: { name: 'root', pass: 'a'.repeat(73) } });
  assert.equal(h.store.countUsers(), 0);
  const h2 = await makeServer({ defaultUser: { name: 'root', pass: 's3cret' } });
  assert.equal(h2.store.getUserByName('root')?.admin, true);
});

test('GET /user, GET /user/:id', async () => {
  const h = await makeServer();
  await createUser(h, 'tom');
  let res = await h.call('GET', '/user', h.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, [
    { id: 1, name: 'admin', admin: true, createdAt: '2026-01-15T12:00:00Z' },
    { id: 2, name: 'tom', admin: false, createdAt: '2026-01-15T12:00:00Z' },
  ]);
  // passwords never leave
  assert.ok(!res.text.includes('pass'));
  res = await h.call('GET', '/user/2', h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'tom');
  res = await h.call('GET', '/user/abc', h.admin);
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, badRequest('invalid id'));
  res = await h.call('GET', '/user/3', h.admin);
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, 'user does not exist');
  res = await h.call('GET', '/user/-1', h.admin);
  assert.equal(res.status, 400);
});

test('create user: admin creates, validation, duplicates', async () => {
  const h = await makeServer();
  let res = await h.call('POST', '/user', { ...h.admin, json: { name: 'tom', pass: 'mylittlepony', admin: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { id: 2, name: 'tom', admin: true, createdAt: '2026-01-15T12:00:00Z' });
  assert.equal(comparePassword(h.store.getUserByName('tom')!.pass, 'mylittlepony'), true);

  res = await h.call('POST', '/user', { ...h.admin, json: { name: 'tom', pass: 'x' } });
  assert.deepEqual(res.json, badRequest('username already exists'));

  res = await h.call('POST', '/user', { ...h.admin, json: { name: 'a', pass: '' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'pass' is required");
  res = await h.call('POST', '/user', { ...h.admin, json: { name: '', pass: 'asd' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'name' is required");
  res = await h.call('POST', '/user', { ...h.admin, json: { name: '', pass: '' } });
  assert.equal(res.json.errorDescription, "Field 'name' is required; Field 'pass' is required");

  res = await h.call('POST', '/user', { ...h.admin, json: { name: 'long', pass: 'a'.repeat(100) } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'bcrypt: password length exceeds 72 bytes');
  assert.equal(h.store.getUserByName('long'), null);

  // form encoding works as well
  res = await h.call('POST', '/user', { ...h.admin, form: { name: 'formuser', pass: 'pw', admin: 'true' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.admin, true);

  // malformed JSON
  res = await h.call('POST', '/user', { ...h.admin, body: '{"name": ', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'unexpected EOF');
  res = await h.call('POST', '/user', { ...h.admin, body: '', headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'EOF');
});

test('registration', async () => {
  const closed = await makeServer();
  let res = await closed.call('POST', '/user', { json: { name: 'tom', pass: '1', admin: false } });
  assert.equal(res.status, 401);
  assert.equal(res.json.errorDescription, 'you are not allowed to access this api');
  assert.equal(closed.store.getUserByName('tom'), null);

  const open = await makeServer({ registration: true });
  res = await open.call('POST', '/user', { json: { name: 'tom', pass: '1', admin: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.admin, false);
  assert.ok(open.store.getUserByName('tom'));

  res = await open.call('POST', '/user', { json: { name: 'eve', pass: '1', admin: true } });
  assert.equal(res.status, 401);
  assert.equal(res.json.errorDescription, 'you are not allowed to create an admin user');
  assert.equal(open.store.getUserByName('eve'), null);

  // a registered user (authenticated, but not an admin) is refused rather than treated as anonymous
  res = await open.call('POST', '/user', { basic: ['tom', '1'], json: { name: 'other', pass: '1' } });
  assert.equal(res.status, 403);
  // wrong credentials count as anonymous for this optional-auth endpoint
  res = await open.call('POST', '/user', { basic: ['tom', 'wrong'], json: { name: 'other', pass: '1' } });
  assert.equal(res.status, 200);
});

test('update user', async () => {
  const h = await makeServer();
  const { user } = await createUser(h, 'nico');
  const oldHash = h.store.getUserById(user.id)!.pass;

  let res = await h.call('POST', `/user/${user.id}`, { ...h.admin, json: { name: 'tom', pass: '', admin: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { id: 2, name: 'tom', admin: true, createdAt: '2026-01-15T12:00:00Z' });
  assert.equal(h.store.getUserById(user.id)!.pass, oldHash); // an empty password keeps the old one

  res = await h.call('POST', `/user/${user.id}`, { ...h.admin, json: { name: 'tom', pass: 'new', admin: true } });
  assert.equal(res.status, 200);
  assert.equal(comparePassword(h.store.getUserById(user.id)!.pass, 'new'), true);

  res = await h.call('POST', `/user/${user.id}`, { ...h.admin, json: { name: 'tom', pass: 'a'.repeat(100), admin: true } });
  assert.equal(res.status, 400);

  res = await h.call('POST', '/user/abc', { ...h.admin, json: { name: 'tom', pass: '', admin: false } });
  assert.equal(res.status, 400);
  res = await h.call('POST', '/user/9', { ...h.admin, json: { name: 'tom', pass: '', admin: false } });
  assert.equal(res.status, 404);

});

test('update user: the last admin can not lose the flag', async () => {
  const h = await makeServer();
  await createUser(h, 'plain');
  const res = await h.call('POST', '/user/1', { ...h.admin, json: { name: 'admin', pass: '', admin: false } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'cannot delete last admin');
  assert.equal(h.store.getUserById(1)!.admin, true);
});

test('update user: demoting is allowed while another admin exists', async () => {
  const h = await makeServer();
  await createUser(h, 'second', 'pw', true);
  const res = await h.call('POST', '/user/1', { basic: ['second', 'pw'], json: { name: 'admin', pass: '', admin: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.admin, false);
});

test('name collisions on update are an error', async () => {
  const h = await makeServer();
  await createUser(h, 'a');
  const { user } = await createUser(h, 'b');
  const res = await h.call('POST', `/user/${user.id}`, { ...h.admin, json: { name: 'a', pass: '', admin: false } });
  assert.equal(res.status, 500);
});

test('delete user removes everything it owns and closes its sockets', async () => {
  const h = await makeServer();
  const { user, basic } = await createUser(h, 'tom');
  const app = await createApp(h, { basic }, 'tomapp');
  const client = await createClient(h, { basic }, 'tomclient');
  await h.call('POST', '/message', { key: app.token, json: { message: 'hello' } });
  const upload = await h.call('POST', `/application/${app.id}/image`, {
    basic,
    body: (await import('./harness.ts')).multipartBody('a.png', (await import('./harness.ts')).PNG),
  });
  assert.equal(upload.status, 200);
  const imageName = upload.json.image.slice('image/'.length);
  await h.call('GET', '/stream', { key: client.token, headers: { upgrade: 'websocket' } });
  assert.equal(h.hub.open(user.id).length, 1);

  const res = await h.call('DELETE', `/user/${user.id}`, h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(h.store.getUserById(user.id), null);
  assert.equal(h.hub.open(user.id).length, 0);
  assert.equal(h.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM applications')!.n, 0);
  assert.equal(h.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages')!.n, 0);
  assert.equal(h.sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM clients')!.n, 0);
  assert.equal(h.store.imageExists(imageName), false);
  assert.equal((await h.call('GET', '/current/user', { basic })).status, 401);
});

test('delete user: errors', async () => {
  const h = await makeServer();
  let res = await h.call('DELETE', '/user/1', h.admin);
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'cannot delete last admin');
  res = await h.call('DELETE', '/user/abc', h.admin);
  assert.equal(res.status, 400);
  res = await h.call('DELETE', '/user/7', h.admin);
  assert.equal(res.status, 404);
  // with a second admin the first can go
  await createUser(h, 'second', 'pw', true);
  res = await h.call('DELETE', '/user/1', { basic: ['second', 'pw'] });
  assert.equal(res.status, 200);
});

test('change password', async () => {
  const h = await makeServer();
  const { basic } = await createUser(h, 'tom', 'old');
  let res = await h.call('POST', '/current/user/password', { basic, json: { pass: 'new' } });
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal((await h.call('GET', '/current/user', { basic })).status, 401);
  assert.equal((await h.call('GET', '/current/user', { basic: ['tom', 'new'] })).status, 200);

  res = await h.call('POST', '/current/user/password', { basic: ['tom', 'new'], json: { pass: '' } });
  assert.equal(res.status, 400);
  res = await h.call('POST', '/current/user/password', { basic: ['tom', 'new'], json: { pass: 'a'.repeat(100) } });
  assert.equal(res.status, 400);
  assert.equal((await h.call('GET', '/current/user', { basic: ['tom', 'new'] })).status, 200);
});

test('login creates a session cookie and a client', async () => {
  const h = await makeServer({ secureCookie: true });
  const res = await h.call('POST', '/auth/local/login', { basic: ['admin', 'admin'], form: { name: 'test-browser' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'admin');
  assert.equal(res.json.clientId, 1);
  assert.equal(res.json.elevatedUntil, '2026-01-15T13:00:00Z');
  assert.ok(!res.text.includes('gtfy'));

  const cookie = res.headers.get('set-cookie')!;
  const m = /^gotify-client-token=(gtfyc\.[A-Za-z0-9_-]{43}); Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict$/.exec(cookie);
  assert.ok(m, cookie);

  const client = h.store.getClientsByUser(1)[0];
  assert.equal(client.name, 'test-browser');
  assert.equal(client.expiresAfterInactivitySeconds, 604800);
  assert.equal(client.expiresAt, T0 + 604800_000);
  assert.notEqual(client.token, m![1]); // the database has the public form

  // the cookie works, and the session starts out elevated
  const me = await h.call('GET', '/current/user', { cookie: `gotify-client-token=${m![1]}` });
  assert.equal(me.status, 200);
  assert.equal(me.json.clientId, 1);
  const del = await h.call('POST', '/current/user/password', { cookie: `gotify-client-token=${m![1]}`, json: { pass: 'admin2' } });
  assert.equal(del.status, 200);
});

test('login: failures set no cookie', async () => {
  const h = await makeServer();
  let res = await h.call('POST', '/auth/local/login', { basic: ['admin', 'wrong'], form: { name: 'x' } });
  assert.equal(res.status, 401);
  assert.equal(res.json.errorDescription, 'invalid credentials');
  assert.equal(res.headers.get('set-cookie'), null);
  res = await h.call('POST', '/auth/local/login', { form: { name: 'x' } });
  assert.equal(res.status, 401);
  assert.equal(res.json.errorDescription, 'basic auth required');
  res = await h.call('POST', '/auth/local/login', { basic: ['admin', 'admin'], form: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "Field 'name' is required");
  assert.equal(h.store.getClientsByUser(1).length, 0);
});

test('logout clears the cookie, deletes the client and closes its sockets', async () => {
  const h = await makeServer();
  const login = await h.call('POST', '/auth/local/login', { basic: ['admin', 'admin'], form: { name: 'b' } });
  const token = /gotify-client-token=([^;]+)/.exec(login.headers.get('set-cookie')!)![1];
  const cookie = `gotify-client-token=${token}`;
  await h.call('GET', '/stream', { cookie, headers: { upgrade: 'websocket' } });
  assert.equal(h.hub.open().length, 1);

  const res = await h.call('POST', '/auth/logout', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), 'gotify-client-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  assert.equal(h.store.getClientsByUser(1).length, 0);
  assert.equal(h.hub.open().length, 0);
  assert.equal((await h.call('GET', '/current/user', { cookie })).status, 401);

  // basic auth has no client to log out
  const basic = await h.call('POST', '/auth/logout', h.admin);
  assert.equal(basic.status, 403);
  assert.equal(basic.json.errorDescription, 'no client auth provided');
});

test('create user: the (slow) password hash is only computed for requests that will succeed', async () => {
  const closed = await makeServer();
  const open = await makeServer({ registration: true });
  await createUser(open, 'tom');
  const hashes = async (h: typeof closed, opts: Record<string, unknown>) => {
    const before = hashStats.computed;
    const res = await h.call('POST', '/user', opts as any);
    return { res, count: hashStats.computed - before };
  };
  const body = (name: string, extra: Record<string, unknown> = {}) => ({ json: { name, pass: 'secret', ...extra } });

  // anonymous while registration is closed
  let r = await hashes(closed, body('x'));
  assert.equal(r.res.status, 401);
  assert.equal(r.res.json.errorDescription, 'you are not allowed to access this api');
  assert.equal(r.count, 0);
  // anonymous and existing name (same answer as for a new one, no hashing)
  r = await hashes(closed, body('admin'));
  assert.equal(r.res.status, 401);
  assert.equal(r.count, 0);
  // registration open: admin flag refused, existing name refused, validation errors, non-admin user
  r = await hashes(open, body('eve', { admin: true }));
  assert.equal(r.res.json.errorDescription, 'you are not allowed to create an admin user');
  assert.equal(r.count, 0);
  r = await hashes(open, body('tom'));
  assert.deepEqual(r.res.json, badRequest('username already exists'));
  assert.equal(r.count, 0);
  r = await hashes(open, { json: { name: 'x', pass: '' } });
  assert.equal(r.res.json.errorDescription, "Field 'pass' is required");
  assert.equal(r.count, 0);
  r = await hashes(open, body('long', { pass: 'a'.repeat(73) }));
  assert.equal(r.res.json.errorDescription, 'bcrypt: password length exceeds 72 bytes');
  assert.equal(r.count, 0);
  r = await hashes(open, { basic: ['tom', 'pass'], json: { name: 'other', pass: 'x' } });
  assert.equal(r.res.status, 403);
  assert.equal(r.count, 0);
  // admin with an existing name
  r = await hashes(open, { ...open.admin, json: { name: 'tom', pass: 'x' } });
  assert.deepEqual(r.res.json, badRequest('username already exists'));
  assert.equal(r.count, 0);

  // successful requests hash exactly once
  r = await hashes(open, body('new1'));
  assert.equal(r.res.status, 200);
  assert.equal(r.count, 1);
  r = await hashes(open, { ...open.admin, json: { name: 'new2', pass: 'x', admin: true } });
  assert.equal(r.res.status, 200);
  assert.equal(r.count, 1);
});
