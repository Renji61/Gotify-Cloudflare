// Authentication matrix, ported from auth/authentication_test.go and router/router_test.go.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newEnhancedToken, signToken, tokenToString } from '../src/tokens.ts';
import { createApp, createClient, createUser, makeServer, T0 } from './harness.ts';

const UNAUTHORIZED = {
  error: 'Unauthorized',
  errorCode: 401,
  errorDescription: 'you need to provide a valid access token or user credentials to access this api',
};
const FORBIDDEN = { error: 'Forbidden', errorCode: 403, errorDescription: 'you are not allowed to access this api' };
const NOT_ELEVATED = {
  error: 'Forbidden',
  errorCode: 403,
  errorDescription: 'session not elevated, use basic auth or call /client:elevate',
};

test('no credentials: 401 with the standard error body', async () => {
  const h = await makeServer();
  for (const [method, path] of [
    ['GET', '/current/user'],
    ['GET', '/application'],
    ['GET', '/client'],
    ['GET', '/message'],
    ['POST', '/message'],
    ['GET', '/stream'],
    ['GET', '/plugin'],
    ['GET', '/user'],
    ['DELETE', '/application/1'],
    ['POST', '/current/user/password'],
  ]) {
    const res = await h.call(method, path);
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.deepEqual(res.json, UNAUTHORIZED);
    assert.equal(res.headers.get('content-type'), 'application/json');
  }
});

test('basic auth: valid, wrong password, unknown user', async () => {
  const h = await makeServer();
  let res = await h.call('GET', '/current/user', { basic: ['admin', 'admin'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { id: 1, name: 'admin', admin: true, createdAt: '2026-01-15T12:00:00Z' });
  res = await h.call('GET', '/current/user', { basic: ['admin', 'wrong'] });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, UNAUTHORIZED);
  res = await h.call('GET', '/current/user', { basic: ['nobody', 'admin'] });
  assert.equal(res.status, 401);
  // malformed Authorization header is simply not credentials
  res = await h.call('GET', '/current/user', { headers: { authorization: 'Basic !!!notbase64' } });
  assert.equal(res.status, 401);
  res = await h.call('GET', '/current/user', { headers: { authorization: 'Basic ' + Buffer.from('nocolon').toString('base64') } });
  assert.equal(res.status, 401);
  // the scheme is case-insensitive
  res = await h.call('GET', '/current/user', { headers: { authorization: 'bAsIc ' + Buffer.from('admin:admin').toString('base64') } });
  assert.equal(res.status, 200);
});

test('client token in every position', async () => {
  const h = await makeServer();
  const client = await createClient(h, h.admin, 'phone');
  const ok = [
    { key: client.token },
    { bearer: client.token },
    { headers: { authorization: 'bearer ' + client.token } },
    { cookie: `gotify-client-token=${client.token}` },
    { cookie: `other=1; gotify-client-token=${client.token}` },
  ];
  for (const opts of ok) {
    const res = await h.call('GET', '/current/user', opts);
    assert.equal(res.status, 200, JSON.stringify(opts));
    assert.equal(res.json.name, 'admin');
    assert.equal(res.json.clientId, client.id);
  }
  const res = await h.call('GET', `/current/user?token=${encodeURIComponent(client.token)}`);
  assert.equal(res.status, 200);
  // wrong tokens
  for (const opts of [{ key: 'Cwrong' }, { bearer: 'Cwrong' }, { cookie: 'gotify-client-token=Cwrong' }]) {
    const r = await h.call('GET', '/current/user', opts);
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, UNAUTHORIZED);
  }
  assert.equal((await h.call('GET', '/current/user?token=Cwrong')).status, 401);
  // "Bearer" without a token is nothing
  assert.equal((await h.call('GET', '/current/user', { headers: { authorization: 'Bearer ' } })).status, 401);
});

test('token sources have a priority: query, X-Gotify-Key, Authorization, cookie', async () => {
  const h = await makeServer();
  const a = await createClient(h, h.admin, 'a');
  // a bad token in the query wins over a good one in the header
  let res = await h.call('GET', '/current/user?token=bad', { key: a.token });
  assert.equal(res.status, 401);
  res = await h.call('GET', `/current/user?token=${a.token}`, { key: 'bad' });
  assert.equal(res.status, 200);
  res = await h.call('GET', '/current/user', { key: 'bad', bearer: a.token });
  assert.equal(res.status, 401);
});

test('application tokens only work where upstream allows them', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'backup');
  // not on client endpoints
  for (const path of ['/current/user', '/application', '/message', '/client']) {
    const res = await h.call('GET', path, { key: app.token });
    assert.equal(res.status, 401, path);
    assert.deepEqual(res.json, UNAUTHORIZED);
  }
  // on POST /message
  const res = await h.call('POST', '/message', { key: app.token, json: { message: 'hi' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.appid, app.id);
  assert.equal(res.json.title, 'backup');
});

test('POST /message with client token or basic auth needs an application id', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const mine = await createApp(h, h.admin, 'mine');
  const theirs = await createApp(h, { basic: other.basic }, 'theirs');
  const client = await createClient(h, h.admin, 'c');

  for (const auth of [{ key: client.token }, h.admin]) {
    let res = await h.call('POST', '/message', { ...auth, json: { message: 'm' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, {
      error: 'Bad Request',
      errorCode: 400,
      errorDescription: 'appid is required when not authenticating with an application token',
    });
    res = await h.call('POST', '/message', { ...auth, json: { message: 'm', appid: theirs.id } });
    assert.equal(res.status, 400);
    assert.equal(res.json.errorDescription, 'appid not found');
    res = await h.call('POST', '/message', { ...auth, json: { message: 'm', appid: 9999 } });
    assert.equal(res.status, 400);
    res = await h.call('POST', '/message', { ...auth, json: { message: 'm', appid: mine.id } });
    assert.equal(res.status, 200);
    assert.equal(res.json.appid, mine.id);
  }
});

test('an application token ignores the appid in the body', async () => {
  const h = await makeServer();
  const a = await createApp(h, h.admin, 'a');
  const b = await createApp(h, h.admin, 'b');
  const res = await h.call('POST', '/message', { key: a.token, json: { message: 'm', appid: b.id } });
  assert.equal(res.status, 200);
  assert.equal(res.json.appid, a.id);
});

test('elevated endpoints: plain client is refused, basic auth and elevated clients pass', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'x');
  const client = await createClient(h, h.admin, 'c');

  let res = await h.call('DELETE', `/application/${app.id}`, { key: client.token });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, NOT_ELEVATED);

  res = await h.call('POST', `/client/${client.id}/elevate`, { key: client.token, json: { durationSeconds: 60 } });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, NOT_ELEVATED);

  // elevate with basic auth for a minute
  res = await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: 60 } });
  assert.equal(res.status, 204);
  assert.equal(res.text, '');

  res = await h.call('GET', '/current/user', { key: client.token });
  assert.equal(res.json.elevatedUntil, '2026-01-15T12:01:00Z');

  // after the elevation ended
  h.clock.now = T0 + 61_000;
  res = await h.call('DELETE', `/application/${app.id}`, { key: client.token });
  assert.equal(res.status, 403);
  res = await h.call('GET', '/current/user', { key: client.token });
  assert.equal(res.json.elevatedUntil, undefined);

  h.clock.now = T0 + 30_000;
  res = await h.call('DELETE', `/application/${app.id}`, { key: client.token });
  assert.equal(res.status, 200);
});

test('admin endpoints: the full matrix', async () => {
  const h = await makeServer();
  const normal = await createUser(h, 'normal');
  const adminPlain = await createUser(h, 'admin2', 'pass', true);

  const adminClient = await createClient(h, { basic: adminPlain.basic }, 'plain');
  const adminElevated = await createClient(h, { basic: adminPlain.basic }, 'elevated');
  await h.call('POST', `/client/${adminElevated.id}/elevate`, { basic: adminPlain.basic, json: { durationSeconds: 600 } });
  const normalElevated = await createClient(h, { basic: normal.basic }, 'normal');
  await h.call('POST', `/client/${normalElevated.id}/elevate`, { basic: normal.basic, json: { durationSeconds: 600 } });

  const body = { name: 'newadmin', pass: 'secret', admin: true };
  // admin but not elevated
  let res = await h.call('POST', '/user', { key: adminClient.token, json: body });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, NOT_ELEVATED);
  assert.equal(h.store.getUserByName('newadmin'), null);
  // elevated but not an admin
  res = await h.call('POST', '/user', { key: normalElevated.token, json: body });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, FORBIDDEN);
  // non-admin basic auth
  res = await h.call('GET', '/user', { basic: normal.basic });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, FORBIDDEN);
  res = await h.call('POST', '/user', { basic: normal.basic, json: body });
  assert.equal(res.status, 403);
  // elevated admin
  res = await h.call('POST', '/user', { key: adminElevated.token, json: body });
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'newadmin');
  assert.equal(res.json.admin, true);
  // admin basic auth
  res = await h.call('GET', '/user', { basic: adminPlain.basic });
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 4);
  // wrong credentials are 401, not 403
  res = await h.call('GET', '/user', { basic: ['admin2', 'wrong'] });
  assert.equal(res.status, 401);
});

test('v3 tokens: private form, signed form, timestamp window and bad signatures', async () => {
  const h = await makeServer();
  const client = await createClient(h, h.admin, 'c');
  assert.match(client.token, /^gtfyc\.[A-Za-z0-9_-]{43}$/);
  const nowSec = Math.floor(h.clock.now / 1000);

  const parsedSeed = Buffer.from(client.token.slice('gtfyc.'.length), 'base64url');
  const priv = { ident: 'c', key: Uint8Array.from(parsedSeed), timestamp: 0, signature: new Uint8Array(0) };

  const signedNow = tokenToString(await signToken(priv, nowSec));
  let res = await h.call('GET', '/current/user', { key: signedNow });
  assert.equal(res.status, 200);
  assert.equal(res.json.clientId, client.id);

  // +-15 minutes
  res = await h.call('GET', '/current/user', { key: tokenToString(await signToken(priv, nowSec + 15 * 60)) });
  assert.equal(res.status, 200);
  res = await h.call('GET', '/current/user', { key: tokenToString(await signToken(priv, nowSec - 15 * 60)) });
  assert.equal(res.status, 200);
  res = await h.call('GET', '/current/user', { key: tokenToString(await signToken(priv, nowSec + 15 * 60 + 1)) });
  assert.equal(res.status, 401);
  res = await h.call('GET', '/current/user', { key: tokenToString(await signToken(priv, nowSec - 15 * 60 - 1)) });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, UNAUTHORIZED);

  // a signature that does not verify: upstream answers 500 "invalid token"
  const tampered = signedNow.replace(/\.\d+\./, `.${nowSec + 1}.`);
  res = await h.call('GET', '/current/user', { key: tampered });
  assert.equal(res.status, 500);
  assert.equal(res.json.errorDescription, 'invalid token');

  // unparsable: 401 with the parse error
  res = await h.call('GET', '/current/user', { key: 'gtfyc.short' });
  assert.equal(res.status, 401);
  assert.match(res.json.errorDescription, /^cannot parse token: /);
  res = await h.call('GET', '/current/user', { key: 'gtfyc' });
  assert.equal(res.status, 401);

  // a valid token for a client that does not exist
  const stranger = newEnhancedToken('c');
  res = await h.call('GET', '/current/user', { key: tokenToString(stranger) });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, UNAUTHORIZED);

  // the stored value is the public form: using it as a token does not work
  const stored = h.store.getClientById(client.id)!.token;
  assert.notEqual(stored, client.token);
  res = await h.call('GET', '/current/user', { key: stored });
  assert.equal(res.status, 401);
});

test('legacy plain tokens are looked up directly', async () => {
  const h = await makeServer();
  h.store.createClient({ token: 'Clegacytoken123', userId: 1, name: 'old', expiresAfterInactivitySeconds: 0 });
  const app = h.store.createApplication({
    token: 'Alegacytoken123',
    userId: 1,
    name: 'oldapp',
    internal: false,
    image: '',
    defaultPriority: 0,
    sortKey: '',
    description: '',
  });
  let res = await h.call('GET', '/current/user', { key: 'Clegacytoken123' });
  assert.equal(res.status, 200);
  res = await h.call('POST', '/message', { key: 'Alegacytoken123', json: { message: 'x' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.appid, app.id);
  // the application listing shows the stored (legacy) token only on create/update, never in the list
  res = await h.call('GET', '/application', h.admin);
  assert.equal(res.json[0].token, undefined);
});

test('last used is refreshed at most every 5 minutes; cookie auth renews the cookie', async () => {
  const h = await makeServer({ secureCookie: true });
  const client = await createClient(h, h.admin, 'c');
  const lastUsed = async () => (await h.call('GET', '/client', h.admin)).json.find((c: any) => c.id === client.id).lastUsed;
  assert.equal(await lastUsed(), null);

  let res = await h.call('GET', '/current/user', { cookie: `gotify-client-token=${client.token}` });
  assert.equal(res.status, 200);
  assert.equal(await lastUsed(), '2026-01-15T12:00:00Z');
  const setCookie = res.headers.get('set-cookie')!;
  assert.equal(setCookie, `gotify-client-token=${client.token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`);

  // within 5 minutes: no update, no new cookie
  h.clock.now = T0 + 4 * 60_000;
  res = await h.call('GET', '/current/user', { cookie: `gotify-client-token=${client.token}` });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(await lastUsed(), '2026-01-15T12:00:00Z');

  // later: updated
  h.clock.now = T0 + 6 * 60_000;
  res = await h.call('GET', '/current/user', { cookie: `gotify-client-token=${client.token}` });
  assert.ok(res.headers.get('set-cookie'));
  assert.equal(await lastUsed(), '2026-01-15T12:06:00Z');

  // header auth never sets a cookie
  h.clock.now = T0 + 20 * 60_000;
  res = await h.call('GET', '/current/user', { key: client.token });
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(await lastUsed(), '2026-01-15T12:20:00Z');
});

test('application last used follows the same rule', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const used = async () => (await h.call('GET', '/application', h.admin)).json[0].lastUsed;
  assert.equal(await used(), null);
  await h.call('POST', '/message', { key: app.token, json: { message: 'x' } });
  assert.equal(await used(), '2026-01-15T12:00:00Z');
  h.clock.now = T0 + 60_000;
  await h.call('POST', '/message', { key: app.token, json: { message: 'x' } });
  assert.equal(await used(), '2026-01-15T12:00:00Z');
  h.clock.now = T0 + 6 * 60_000;
  await h.call('POST', '/message', { key: app.token, json: { message: 'x' } });
  assert.equal(await used(), '2026-01-15T12:06:00Z');
});

test('cookie authentication has cross-origin protection', async () => {
  // allow every origin in CORS, so that the cross-origin check of the cookie auth is what answers
  const h = await makeServer({ corsAllowOrigins: ['.*'] });
  const client = await createClient(h, h.admin, 'c');
  await h.call('POST', `/client/${client.id}/elevate`, { ...h.admin, json: { durationSeconds: 3600 } });
  const cookie = `gotify-client-token=${client.token}`;
  const host = 'gotify.example.com';

  // safe methods are always fine
  let res = await h.call('GET', '/current/user', { cookie, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 200);

  // unsafe methods: Sec-Fetch-Site decides
  const post = (headers: Record<string, string>) => h.call('POST', '/message', { cookie, headers, json: { message: 'x', appid: 1 } });
  res = await post({ 'sec-fetch-site': 'cross-site' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'Forbidden');
  assert.match(res.json.errorDescription, /cross-origin request detected from Sec-Fetch-Site header/);
  res = await post({ 'sec-fetch-site': 'same-site' });
  assert.equal(res.status, 403);
  // same-origin and none pass the cross-origin check (then fail on the missing application)
  res = await post({ 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 400);
  res = await post({ 'sec-fetch-site': 'none' });
  assert.equal(res.status, 400);
  // without Sec-Fetch-Site: Origin is compared with Host; no Origin means a non-browser client
  res = await post({});
  assert.equal(res.status, 400);
  res = await post({ origin: `https://${host}` });
  assert.equal(res.status, 400);
  res = await post({ origin: 'https://evil.example.org' });
  assert.equal(res.status, 403);
  assert.match(res.json.errorDescription, /cross-origin request detected, and\/or browser is out of date/);

  // the protection only applies to cookies: the same request with a header token is not checked
  res = await h.call('POST', '/message', { key: client.token, headers: { 'sec-fetch-site': 'cross-site' }, json: { message: 'x', appid: 1 } });
  assert.equal(res.status, 400);
});

test('expired clients cannot authenticate; use pushes the expiry out', async () => {
  const h = await makeServer();
  const client = await createClient(h, h.admin, 'c', { expiresAfterInactivitySeconds: 600 });
  const get = () => h.call('GET', '/current/user', { key: client.token });
  assert.equal((await get()).status, 200); // used at 0s, expires at 600s
  h.clock.now = T0 + 599_000;
  assert.equal((await get()).status, 200); // used again (more than 5 minutes later): expires at 1199s
  h.clock.now = T0 + 1198_000;
  assert.equal((await get()).status, 200); // expires at 1798s
  h.clock.now = T0 + 1798_000;
  const res = await get();
  assert.equal(res.status, 401);
  assert.deepEqual(res.json, UNAUTHORIZED);
});
