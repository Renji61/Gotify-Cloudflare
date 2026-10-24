import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, configFromEnv, DEFAULT_MAX_BODY_BYTES, parseCsvLine } from '../src/config.ts';
import { renderIndex, uiConfigJson } from '../src/ui.ts';

test('defaults', () => {
  const c = configFromEnv({});
  assert.equal(c.registration, false);
  assert.equal(c.localAuthEnabled, true);
  assert.equal(c.passStrength, 10);
  assert.equal(c.secureCookie, true);
  assert.deepEqual(c.streamAllowedOrigins, []);
  assert.deepEqual(c.corsAllowOrigins, []);
  assert.deepEqual(c.responseHeaders, {});
  assert.equal(c.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  assert.equal(DEFAULT_MAX_BODY_BYTES, 2097152);
  assert.deepEqual(c.defaultUser, { name: 'admin', pass: undefined });
  assert.equal(c.version.version, '3.1.1');
});

test('there is never a default password', () => {
  assert.equal(configFromEnv({}).defaultUser.pass, undefined);
  assert.equal(configFromEnv({ GOTIFY_DEFAULTUSER_PASS: '' }).defaultUser.pass, undefined);
  assert.equal(configFromEnv({ GOTIFY_DEFAULTUSER_PASS: 'x', GOTIFY_DEFAULTUSER_NAME: 'root' }).defaultUser.name, 'root');
});

test('values from Worker vars', () => {
  const c = configFromEnv({
    GOTIFY_REGISTRATION: 'true',
    GOTIFY_PASSSTRENGTH: '12',
    GOTIFY_SERVER_SECURECOOKIE: 'false',
    GOTIFY_SERVER_STREAM_ALLOWEDORIGINS: '^a\\.example$, ^b\\.example$',
    GOTIFY_SERVER_CORS_ALLOWORIGINS: '^https://x$',
    GOTIFY_SERVER_CORS_ALLOWMETHODS: 'GET,POST',
    GOTIFY_SERVER_CORS_ALLOWHEADERS: 'Authorization',
    GOTIFY_SERVER_MAXBODYBYTES: '1000',
    GOTIFY_SERVER_RESPONSEHEADERS: '{"X-A":"b","X-C":""}',
  });
  assert.equal(c.registration, true);
  assert.equal(c.passStrength, 12);
  assert.equal(c.secureCookie, false);
  assert.deepEqual(c.streamAllowedOrigins, ['^a\\.example$', '^b\\.example$']);
  assert.deepEqual(c.corsAllowOrigins, ['^https://x$']);
  assert.deepEqual(c.corsAllowMethods, ['GET', 'POST']);
  assert.deepEqual(c.corsAllowHeaders, ['Authorization']);
  assert.equal(c.maxBodyBytes, 1000);
  assert.deepEqual(c.responseHeaders, { 'X-A': 'b', 'X-C': '' });
});

test('invalid values are configuration errors', () => {
  for (const env of [
    { GOTIFY_REGISTRATION: 'yes' },
    { GOTIFY_PASSSTRENGTH: 'ten' },
    { GOTIFY_SERVER_SECURECOOKIE: '2' },
    { GOTIFY_SERVER_RESPONSEHEADERS: 'not json' },
    { GOTIFY_SERVER_RESPONSEHEADERS: '["a"]' },
    { GOTIFY_SERVER_RESPONSEHEADERS: '{"a":1}' },
    { GOTIFY_SERVER_MAXBODYBYTES: '1.5' },
    { GOTIFY_IMPORT_TOKEN: 'x'.repeat(31) },
    { GOTIFY_PASSSTRENGTH: '32' },
  ]) {
    assert.throws(() => configFromEnv(env), ConfigError, JSON.stringify(env));
  }
});

test('Go style booleans', () => {
  for (const t of ['1', 't', 'T', 'TRUE', 'true', 'True']) assert.equal(configFromEnv({ GOTIFY_REGISTRATION: t }).registration, true);
  for (const f of ['0', 'f', 'F', 'FALSE', 'false', 'False']) assert.equal(configFromEnv({ GOTIFY_REGISTRATION: f }).registration, false);
});

test('CSV lists like encoding/csv', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine('a, b ,c'), ['a', 'b ', 'c']); // leading space trimmed
  assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(parseCsvLine('"a""b",c'), ['a"b', 'c']);
  assert.deepEqual(parseCsvLine('a,'), ['a', '']);
  assert.deepEqual(parseCsvLine('^x{2,3}$'), ['^x{2', '3}$']);
  assert.deepEqual(parseCsvLine('"^x{2,3}$"'), ['^x{2,3}$']);
});

test('the UI config and index.html substitution', () => {
  const config = configFromEnv({ GOTIFY_REGISTRATION: 'true' });
  const json = uiConfigJson(config);
  assert.equal(
    json,
    '{"register":true,"version":{"version":"3.1.1","commit":"e6361caa512547052b1013dbf4544e6d7ff32604","buildDate":"2026-09-12T17:22:24Z"},"localAuth":true,"oidc":false,"oidcIdpName":"OIDC","oidcAutoRedirect":false}',
  );
  const html = '<script>window.config = %CONFIG%;</script><script>window.other = %CONFIG%;</script>';
  assert.equal(renderIndex(html, json), `<script>window.config = ${json};</script><script>window.other = %CONFIG%;</script>`); // first one only
  // "$&" and friends in the JSON are not replacement patterns
  assert.equal(renderIndex('x%CONFIG%y', '{"a":"$&$1"}'), 'x{"a":"$&$1"}y');
  assert.equal(renderIndex('no placeholder', json), 'no placeholder');
});

test('import token length and bcrypt cost limits', () => {
  assert.equal(configFromEnv({ GOTIFY_IMPORT_TOKEN: 'x'.repeat(32) }).importToken, 'x'.repeat(32));
  assert.equal(configFromEnv({ GOTIFY_IMPORT_TOKEN: '' }).importToken, undefined);
  assert.equal(configFromEnv({ GOTIFY_PASSSTRENGTH: '31' }).passStrength, 31);
  assert.equal(configFromEnv({ GOTIFY_PASSSTRENGTH: '3' }).passStrength, 3); // below 4 falls back to 10 when hashing, as upstream
});
