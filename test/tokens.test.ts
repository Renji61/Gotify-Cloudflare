import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { ed25519phSign, ed25519phVerify, publicKeyFromSeed } from '../src/ed25519ph.ts';
import {
  base64UrlDecode,
  base64UrlEncode,
  CannotParseTokenError,
  derivePublicKey,
  generateApplicationToken,
  generateClientToken,
  generateImageName,
  InvalidTokenError,
  newEnhancedToken,
  parseEnhancedToken,
  resolveStoredToken,
  signToken,
  tokenPublicForm,
  tokenToString,
  validateTimestamp,
} from '../src/tokens.ts';
import { RFC8032, TOKEN_VECTORS } from './vectors.ts';

const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sha512 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-512', new TextEncoder().encode(s)));

test('Ed25519ph matches RFC 8032 section 7.3', async () => {
  const abc = await sha512('abc');
  assert.equal(hex(await publicKeyFromSeed(unhex(RFC8032.seedHex))), RFC8032.pubHex);
  const sig = await ed25519phSign(unhex(RFC8032.seedHex), abc);
  assert.equal(hex(sig), RFC8032.sigHex);
  assert.equal(await ed25519phVerify(unhex(RFC8032.pubHex), abc, sig), true);
  assert.equal(await ed25519phVerify(unhex(RFC8032.pubHex), await sha512('abd'), sig), false);
});

test('verifies the signatures Go produced and reproduces them', async () => {
  for (const v of TOKEN_VECTORS) {
    const digest = await sha512(`iat=${v.timestamp}`);
    assert.equal(await ed25519phVerify(unhex(v.pubHex), digest, unhex(v.sigHex)), true, v.ident);
    // Ed25519 signatures are deterministic, so ours must be identical to Go's
    assert.equal(hex(await ed25519phSign(unhex(v.seedHex), digest)), v.sigHex);
    assert.equal(hex(await derivePublicKey(unhex(v.seedHex))), v.pubHex);
    assert.equal(hex(await publicKeyFromSeed(unhex(v.seedHex))), v.pubHex);
  }
});

test('rejects tampered signatures, keys and malformed input', async () => {
  const v = TOKEN_VECTORS[0];
  const digest = await sha512(`iat=${v.timestamp}`);
  const sig = unhex(v.sigHex);
  const flipped = Uint8Array.from(sig);
  flipped[10] ^= 1;
  assert.equal(await ed25519phVerify(unhex(v.pubHex), digest, flipped), false);
  const highS = Uint8Array.from(sig);
  highS[63] |= 0xf0; // S >= L
  assert.equal(await ed25519phVerify(unhex(v.pubHex), digest, highS), false);
  assert.equal(await ed25519phVerify(unhex(TOKEN_VECTORS[1].pubHex), digest, sig), false);
  assert.equal(await ed25519phVerify(unhex(v.pubHex).subarray(1), digest, sig), false);
  assert.equal(await ed25519phVerify(unhex(v.pubHex), digest.subarray(1), sig), false);
});

test('token forms match what Go produces', async () => {
  for (const v of TOKEN_VECTORS) {
    const priv = await parseEnhancedToken(v.private);
    assert.equal(priv.ident, v.ident);
    assert.equal(await tokenPublicForm(priv), v.public);
    assert.equal(tokenToString(priv), v.private);

    const signed = await parseEnhancedToken(v.signed);
    assert.equal(signed.timestamp, v.timestamp);
    assert.equal(await tokenPublicForm(signed), v.public);
    assert.equal(tokenToString(signed), v.signed);

    // signing here gives the same string as Go
    const mine = await signToken(priv, v.timestamp);
    assert.equal(tokenToString(mine), v.signed);
  }
});

test('public form of the public form is itself (it can be looked up)', async () => {
  for (const v of TOKEN_VECTORS) {
    // the public form has the same shape as a private form with a 32 byte key; it is NOT re-derived by lookups,
    // the stored value is compared directly. Lookup of a private form must give the stored public form.
    assert.equal(await resolveStoredToken(v.private, 0), v.public);
    assert.equal(await resolveStoredToken(v.signed, v.timestamp), v.public);
  }
});

test('signed tokens must be within 15 minutes', async () => {
  const v = TOKEN_VECTORS[1];
  const now = v.timestamp;
  assert.equal(await resolveStoredToken(v.signed, now + 15 * 60), v.public);
  assert.equal(await resolveStoredToken(v.signed, now - 15 * 60), v.public);
  assert.equal(await resolveStoredToken(v.signed, now + 15 * 60 + 1), null);
  assert.equal(await resolveStoredToken(v.signed, now - 15 * 60 - 1), null);
  const parsed = await parseEnhancedToken(v.signed);
  assert.equal(validateTimestamp(parsed, now), true);
  assert.equal(validateTimestamp(await parseEnhancedToken(v.private), now + 99999), true);
});

test('legacy tokens are used as they are', async () => {
  assert.equal(await resolveStoredToken('AxxxxxxxxxxxxXX', 0), 'AxxxxxxxxxxxxXX');
});

test('parse errors', async () => {
  const v = TOKEN_VECTORS[0];
  await assert.rejects(parseEnhancedToken('gtfya'), (e) => e instanceof CannotParseTokenError);
  await assert.rejects(parseEnhancedToken('gtfya.AAAA'), (e) => e instanceof CannotParseTokenError); // short key
  await assert.rejects(parseEnhancedToken('gtfya.!!!!'), (e) => e instanceof CannotParseTokenError);
  await assert.rejects(parseEnhancedToken(`${v.public}.abc`), (e) => e instanceof CannotParseTokenError); // 3 fields
  await assert.rejects(parseEnhancedToken(`${v.public}.notanumber.${v.signed.split('.')[3]}`), (e) => e instanceof CannotParseTokenError);
  await assert.rejects(parseEnhancedToken(`${v.public}.12345.AAAA`), (e) => e instanceof CannotParseTokenError); // short signature
  // good shape, wrong signature: errInvalidToken (answered with a 500 by upstream)
  await assert.rejects(parseEnhancedToken(v.signed.replace('.12345.', '.12346.')), (e) => e instanceof InvalidTokenError);
  assert.equal(new CannotParseTokenError('x').message, 'cannot parse token: x');
  assert.equal(new InvalidTokenError().message, 'invalid token');
});

test('generated tokens', async () => {
  const app = await generateApplicationToken();
  const client = await generateClientToken();
  assert.match(app.privateForm, /^gtfya\.[A-Za-z0-9_-]{43}$/);
  assert.match(app.publicForm, /^gtfya\.[A-Za-z0-9_-]{43}$/);
  assert.match(client.privateForm, /^gtfyc\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(app.privateForm, app.publicForm);
  assert.equal(await resolveStoredToken(app.privateForm, 0), app.publicForm);
  assert.equal(newEnhancedToken('a.b').ident, 'a_b');
  assert.match(generateImageName(), /^[A-Za-z0-9_-]{25}$/);
});

test('base64url is lenient like Go', () => {
  assert.equal(base64UrlEncode(Uint8Array.from([251, 255, 254])), '-__-');
  assert.deepEqual([...base64UrlDecode('-__-')!], [251, 255, 254]);
  assert.equal(base64UrlDecode('a'), null);
  assert.equal(base64UrlDecode('a+b/'), null);
  assert.equal(base64UrlDecode('ab=='), null);
  // non-zero trailing bits are accepted (Go without Strict())
  assert.deepEqual([...base64UrlDecode('AB')!], [0]);
  // newlines are skipped
  assert.deepEqual([...base64UrlDecode('-_\n_-')!], [251, 255, 254]);
});

const GO_BIN = process.env.GOTIFY_VECTOR_BIN ?? '';
test('tokens generated here are accepted by Go', { skip: !existsSync(GO_BIN) && 'Go vector helper not available' }, async () => {
  for (const ts of [1735732800, 1893456000]) {
    const token = newEnhancedToken('a');
    const signed = await signToken(token, ts);
    const sig = (await parseEnhancedToken(tokenToString(signed))).signature;
    const out = execFileSync(GO_BIN, ['verifyph', hex(signed.key), String(ts), hex(sig)], { encoding: 'utf8' }).trim();
    assert.equal(out, 'ok');
    // the public key derived here equals Go's derivation from the same seed
    const pub = execFileSync(GO_BIN, ['pub', hex(token.key)], { encoding: 'utf8' }).trim();
    assert.equal(pub, hex(signed.key));
  }
});
