// Version, info, health, CORS, response headers, routing details and error format.
// Ported from router/router_test.go, api/health_test.go and error/*_test.go.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GotifyServer } from '../src/server.ts';
import { defaultConfig } from '../src/config.ts';
import { migrate } from '../src/storage.ts';
import { BASE, createApp, FakeHub, makeServer, NodeSql } from './harness.ts';

const NOT_FOUND = { error: 'Not Found', errorCode: 404, errorDescription: 'page not found' };

test('/version', async () => {
  const h = await makeServer();
  const res = await h.call('GET', '/version');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    version: '3.1.1',
    commit: 'e6361caa512547052b1013dbf4544e6d7ff32604',
    buildDate: '2026-09-12T17:22:24Z',
  });
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  // no authentication needed, but only GET exists
  assert.equal((await h.call('POST', '/version')).status, 404);
});

test('/gotifyinfo', async () => {
  const h = await makeServer({ registration: true });
  const res = await h.call('GET', '/gotifyinfo');
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"version":"3.1.1","register":true,"localAuth":true,"oidc":false,"oidcIdpName":"OIDC","oidcAutoRedirect":false}');
  const closed = await makeServer();
  assert.equal((await closed.call('GET', '/gotifyinfo')).json.register, false);
});

test('/health', async () => {
  const h = await makeServer();
  let res = await h.call('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"health":"green","database":"green"}');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  res = await h.call('HEAD', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  // not behind CORS: a foreign Origin is not refused
  res = await h.call('GET', '/health', { headers: { origin: 'https://other.example.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('/health reports a broken database', async () => {
  const sql = new NodeSql();
  migrate(sql);
  const server = new GotifyServer(sql, new FakeHub(), defaultConfig({ defaultUser: { name: 'a', pass: undefined } }));
  sql.db.close();
  const res = await server.handle(new Request(BASE + '/health'));
  assert.equal(res.status, 500);
  assert.equal(await res.text(), '{"health":"orange","database":"red"}');
});

test('unknown routes and wrong methods are the JSON 404', async () => {
  const h = await makeServer();
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/nothing'],
    ['GET', '/swagger'],
    ['GET', '/docs'],
    ['POST', '/version'],
    ['GET', '/client/1/elevate'],
    ['PATCH', '/application'],
    ['GET', '/user/current/password'],
    ['GET', '/auth/local/login'],
    ['GET', '/auth/oidc/login'],
    ['GET', '/mcp'],
  ]) {
    const res = await h.call(method, path, h.admin);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(res.json, NOT_FOUND);
    assert.equal(res.headers.get('content-type'), 'application/json');
  }
});

test('paths: repeated slashes are collapsed, a trailing slash redirects', async () => {
  const h = await makeServer();
  assert.equal((await h.call('GET', '//current//user', h.admin)).status, 200);
  let res = await h.call('GET', '/application/', h.admin);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/application');
  res = await h.call('POST', '/application/?x=1', { ...h.admin, json: { name: 'x' } });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), '/application?x=1');
  res = await h.call('GET', '/version/');
  assert.equal(res.status, 301);
  // a path that only exists with a slash
  res = await h.call('GET', '/image');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/image/');
});

test('OPTIONS answers 200 on every path', async () => {
  const h = await makeServer();
  for (const path of ['/version', '/application', '/nothing', '/']) {
    const res = await h.call('OPTIONS', path);
    assert.equal(res.status, 200, path);
    assert.equal(res.text, '');
  }
});

test('plugins: none installed', async () => {
  const h = await makeServer();
  let res = await h.call('GET', '/plugin', h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '[]');
  assert.equal((await h.call('GET', '/plugin')).status, 401);
  for (const [method, suffix] of [['GET', 'config'], ['POST', 'config'], ['GET', 'display'], ['POST', 'enable'], ['POST', 'disable']]) {
    res = await h.call(method, `/plugin/1/${suffix}`, h.admin);
    assert.equal(res.status, 404, `${method} ${suffix}`);
    assert.equal(res.json.errorDescription, 'unknown plugin');
    res = await h.call(method, `/plugin/abc/${suffix}`, h.admin);
    assert.equal(res.status, 400);
  }
});

// ---- CORS (router_test.go) ----

test('CORS: nothing configured sets no CORS headers', async () => {
  const h = await makeServer();
  const res = await h.call('GET', '/version');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('CORS: headers from the configuration', async () => {
  const h = await makeServer({ responseHeaders: { 'New-Cool-Header': 'Nice', 'Access-Control-Allow-Origin': 'http://test1.com' } });
  const res = await h.call('GET', '/version', { headers: { 'content-type': 'application/json' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://test1.com');
  assert.equal(res.headers.get('new-cool-header'), 'Nice');
});

test('CORS: allowed origin from the CORS config', async () => {
  const h = await makeServer({ corsAllowOrigins: ['---', 'http://test.com'] });
  const res = await h.call('GET', '/version', { headers: { origin: 'http://test.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://test.com');
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('CORS: a disallowed origin gets an empty 403', async () => {
  const h = await makeServer({ corsAllowOrigins: ['---', 'http://test.com'] });
  const res = await h.call('GET', '/version', { headers: { origin: 'http://test1.com' } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.text, '');
  // also for authenticated API calls, before authentication
  const api = await h.call('GET', '/current/user', { ...h.admin, headers: { origin: 'http://test1.com' } });
  assert.equal(api.status, 403);
});

test('CORS: the origin from the response headers is the one allowed origin', async () => {
  const h = await makeServer({ responseHeaders: { 'Access-Control-Allow-Origin': 'http://test1.com', 'Access-Control-Allow-Methods': 'GET,POST' } });
  let res = await h.call('GET', '/version', { headers: { origin: 'http://test1.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://test1.com');
  assert.equal(res.status, 200);
  res = await h.call('GET', '/version', { headers: { origin: 'http://example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://test1.com');
  assert.equal(res.status, 403);
});

test('CORS: a wildcard in the response headers allows every origin', async () => {
  const h = await makeServer({ responseHeaders: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST' } });
  const res = await h.call('GET', '/version', { headers: { origin: 'http://test1.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.status, 200);
});

test('CORS: origins are regular expressions', async () => {
  const h = await makeServer({ corsAllowOrigins: ['---', '^http://test\\d{3}.com$'] });
  let res = await h.call('GET', '/version', { headers: { origin: 'http://test123.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://test123.com');
  res = await h.call('GET', '/version', { headers: { origin: 'http://test12.com' } });
  assert.equal(res.status, 403);
  // matched against the lower-cased origin
  res = await h.call('GET', '/version', { headers: { origin: 'http://TEST123.com' } });
  assert.equal(res.status, 200);
});

test('CORS: the CORS config overrides the response headers, preflight', async () => {
  const h = await makeServer({
    responseHeaders: {
      'New-Cool-Header': 'Nice',
      'Access-Control-Allow-Origin': 'http://example.com/',
      'Access-Control-Allow-Methods': '321test',
      'Access-Control-Allow-Headers': 'some-headers',
    },
    corsAllowOrigins: ['http://test123.com', 'aaa'],
    corsAllowMethods: ['GET', 'OPTIONS'],
    corsAllowHeaders: ['Content-Type'],
  });
  let res = await h.call('OPTIONS', '/version', { headers: { 'content-type': 'application/json', origin: 'http://test123.com' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('new-cool-header'), 'Nice');
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://test123.com');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET,OPTIONS');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(res.headers.get('access-control-max-age'), '43200');
  res = await h.call('OPTIONS', '/version', { headers: { origin: 'http://example.com' } });
  assert.equal(res.status, 403);
});

test('CORS: the same host is never treated as cross-origin', async () => {
  const h = await makeServer({ corsAllowOrigins: ['^never$'] });
  for (const origin of ['https://gotify.example.com', 'http://gotify.example.com']) {
    const res = await h.call('GET', '/version', { headers: { origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  // a different port is a different origin
  assert.equal((await h.call('GET', '/version', { headers: { origin: 'https://gotify.example.com:444' } })).status, 403);
});

test('CORS: preflight for a configured origin', async () => {
  const h = await makeServer({ corsAllowOrigins: ['^https://app\\.example\\.com$'], corsAllowMethods: ['GET', 'POST'], corsAllowHeaders: ['x-gotify-key', 'authorization'] });
  const res = await h.call('OPTIONS', '/message', {
    headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-gotify-key' },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET,POST');
  assert.equal(res.headers.get('access-control-allow-headers'), 'X-Gotify-Key,Authorization');
  assert.equal(res.text, '');
});

test('configured response headers apply to API and error responses; an empty value removes a header', async () => {
  const h = await makeServer({ responseHeaders: { 'X-Custom': 'yes', 'X-Empty': '' } });
  let res = await h.call('GET', '/version');
  assert.equal(res.headers.get('x-custom'), 'yes');
  assert.equal(res.headers.get('x-empty'), null);
  res = await h.call('GET', '/nothing');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-custom'), 'yes');
  res = await h.call('GET', '/application');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('x-custom'), 'yes');
});

// ---- error format and request parsing ----

test('error bodies', async () => {
  const h = await makeServer();
  const res = await h.call('POST', '/application', { ...h.admin, json: {} });
  assert.equal(res.status, 400);
  assert.equal(res.text, '{"error":"Bad Request","errorCode":400,"errorDescription":"Field \'name\' is required"}');
});

test('JSON binding follows Go\'s encoding/json', async () => {
  const h = await makeServer();
  const post = (body: string) => h.call('POST', '/application', { ...h.admin, body, headers: { 'content-type': 'application/json' } });
  // keys are case-insensitive
  let res = await post('{"NAME":"upper","DefaultPriority":2}');
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'upper');
  assert.equal(res.json.defaultPriority, 2);
  // unknown fields are ignored, null leaves the zero value, the last duplicate wins
  res = await post('{"name":"a","name":"b","extra":[1,2],"description":null}');
  assert.equal(res.json.name, 'b');
  assert.equal(res.json.description, '');
  // only the first JSON value counts
  res = await post('{"name":"first"}{"name":"second"}');
  assert.equal(res.json.name, 'first');
  // errors
  res = await post('[1]');
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'json: cannot unmarshal array into Go value of type api.ApplicationParams');
  res = await post('{"name": 5}');
  assert.equal(res.json.errorDescription, 'json: cannot unmarshal number into Go struct field ApplicationParams.name of type string');
  res = await post('{"name":"x","defaultPriority":1.5}');
  assert.equal(res.json.errorDescription, 'json: cannot unmarshal number 1.5 into Go struct field ApplicationParams.defaultPriority of type int');
  res = await post('{"name":"x"');
  assert.equal(res.json.errorDescription, 'unexpected EOF');
  res = await post('{name:"x"}');
  assert.equal(res.status, 400);
  assert.match(res.json.errorDescription, /^invalid character 'n' looking for beginning of object key string$/);
});

test('bodies over the limit are refused', async () => {
  const h = await makeServer({ maxBodyBytes: 1000 });
  const big = JSON.stringify({ name: 'x', description: 'd'.repeat(2000) });
  let res = await h.call('POST', '/application', { ...h.admin, json: JSON.parse(big) });
  assert.equal(res.status, 413);
  assert.equal(res.json.error, 'Request Entity Too Large');
  // without a Content-Length header the stream is cut off while it is read
  res = await h.server.handle(
    new Request(BASE + '/application', {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64'), 'content-type': 'application/json' },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big.slice(0, 900)));
          c.enqueue(new TextEncoder().encode(big.slice(900)));
          c.close();
        },
      }),
      // @ts-expect-error Node needs this for streamed bodies
      duplex: 'half',
    }),
  ) as any;
  assert.equal(res.status, 413);
  // a small request still works
  assert.equal((await h.call('POST', '/application', { ...h.admin, json: { name: 'x' } })).status, 200);
});

test('maxBodyBytes 0 disables the limit', async () => {
  const h = await makeServer({ maxBodyBytes: 0 });
  const res = await h.call('POST', '/application', { ...h.admin, json: { name: 'x', description: 'd'.repeat(100_000) } });
  assert.equal(res.status, 200);
});

test('unexpected failures are a JSON 500 without details', async () => {
  const sql = new NodeSql();
  migrate(sql);
  const server = new GotifyServer(sql, new FakeHub(), defaultConfig({ defaultUser: { name: 'a', pass: undefined } }));
  sql.db.close();
  const res = await server.handle(new Request(BASE + '/message', { method: 'POST', headers: { 'x-gotify-key': 'Ax' } }));
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(await res.text()), { error: 'Internal Server Error', errorCode: 500, errorDescription: 'internal server error' });
});

test('application ids are unsigned integers', async () => {
  const h = await makeServer();
  await createApp(h, h.admin, 'a');
  for (const id of ['abc', '-1', '1.5', '', '99999999999999999999999', '+1', '0x1']) {
    const res = await h.call('DELETE', `/application/${id}`, h.admin);
    if (id === '') continue; // that is DELETE /application/, a redirect
    assert.equal(res.status, 400, id);
    assert.equal(res.json.errorDescription, 'invalid id');
  }
});

test('the default body limit is 2 MiB', async () => {
  const h = await makeServer();
  let res = await h.call('POST', '/application', { ...h.admin, json: { name: 'x', description: 'd'.repeat(1024 * 1024) } });
  assert.equal(res.status, 200);
  res = await h.call('POST', '/application', { ...h.admin, json: { name: 'x2', description: 'd'.repeat(2 * 1024 * 1024 + 10) } });
  assert.equal(res.status, 413);
  assert.equal(res.json.error, 'Request Entity Too Large');
});

test('invalid regular expressions in the configuration make every request a 500', async () => {
  for (const [setting, overrides] of [
    ['GOTIFY_SERVER_STREAM_ALLOWEDORIGINS', { streamAllowedOrigins: ['^ok$', '('] }],
    ['GOTIFY_SERVER_CORS_ALLOWORIGINS', { corsAllowOrigins: ['^ok$', '[a-'] }],
  ] as const) {
    const h = await makeServer(overrides);
    for (const [method, path, opts] of [
      ['GET', '/version', {}],
      ['GET', '/health', {}],
      ['GET', '/current/user', h.admin],
      ['POST', '/message', {}],
      ['GET', '/nothing', {}],
      ['OPTIONS', '/version', {}],
    ] as const) {
      const res = await h.call(method, path, opts as any);
      assert.equal(res.status, 500, `${method} ${path}`);
      assert.equal(res.json.error, 'Internal Server Error');
      assert.equal(res.json.errorCode, 500);
      assert.match(res.json.errorDescription, new RegExp(`^invalid configuration: ${setting} contains an invalid regular expression`));
    }
  }
  // valid expressions are fine
  const ok = await makeServer({ streamAllowedOrigins: ['^ok$'], corsAllowOrigins: ['---'] });
  assert.equal((await ok.call('GET', '/version')).status, 200);
});
