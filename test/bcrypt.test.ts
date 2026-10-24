import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { comparePassword, hashCost, hashPassword, MAX_PASSWORD_BYTES } from '../src/bcrypt.ts';
import { BCRYPT_TOO_LONG_ERROR, BCRYPT_VECTORS, CLASSIC_BCRYPT } from './vectors.ts';

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

test('verifies hashes made by Go x/crypto/bcrypt', () => {
  for (const v of BCRYPT_VECTORS) {
    assert.equal(comparePassword(v.hash, v.password), true, `${JSON.stringify(v.password)} cost ${v.cost}`);
    // bytes after the 72nd are ignored by bcrypt, so only check shorter passwords
    if (Buffer.byteLength(v.password) < 72) assert.equal(comparePassword(v.hash, v.password + 'x'), false);
    assert.equal(hashCost(v.hash), v.cost);
  }
});

test('verifies the classic crypt_blowfish vectors', () => {
  for (const [password, hash] of CLASSIC_BCRYPT) assert.equal(comparePassword(hash, password), true, password);
});

test('generated hashes have the Go layout and verify', () => {
  const mine = hashPassword('pw', 5);
  assert.match(mine, /^\$2a\$05\$[./A-Za-z0-9]{53}$/);
  assert.equal(comparePassword(mine, 'pw'), true);
  assert.equal(comparePassword(mine, 'pW'), false);
  assert.notEqual(hashPassword('pw', 5), mine); // random salt
});

test('password length limit is 72 bytes, like Go', () => {
  assert.equal(MAX_PASSWORD_BYTES, 72);
  assert.throws(() => hashPassword('a'.repeat(73), 4), (e: Error) => e.message === BCRYPT_TOO_LONG_ERROR);
  assert.doesNotThrow(() => hashPassword('a'.repeat(72), 4));
  // bytes, not characters
  assert.throws(() => hashPassword('é'.repeat(37), 4));
});

test('cost below the minimum falls back to the default, like Go', () => {
  assert.equal(hashCost(hashPassword('x', 1)), 10);
  assert.equal(hashCost(hashPassword('x', 4)), 4);
});

test('rejects malformed hashes without throwing', () => {
  assert.equal(comparePassword('', 'x'), false);
  assert.equal(comparePassword('not a hash', 'x'), false);
  assert.equal(comparePassword('$2a$05$short', 'x'), false);
  assert.equal(comparePassword('$3a$05$' + 'a'.repeat(53), 'x'), false);
  assert.equal(comparePassword('$2a$99$' + 'a'.repeat(53), 'x'), false);
});

test('accepts $2b$ and $2y$ prefixes', () => {
  const hash = BCRYPT_VECTORS[1].hash; // $2a$05$...
  for (const minor of ['b', 'y']) {
    assert.equal(comparePassword(hash.replace('$2a$', `$2${minor}$`), 'pw'), true);
  }
});

const GO_BIN = process.env.GOTIFY_VECTOR_BIN ?? '';
test('hashes generated here are accepted by Go bcrypt', { skip: !existsSync(GO_BIN) && 'Go vector helper not available' }, () => {
  for (const [password, cost] of [
    ['admin', 4],
    ['pässwörd✓', 5],
    ['', 4],
    ['a'.repeat(72), 4],
    ['correct horse battery staple', 6],
  ] as const) {
    const hash = hashPassword(password, cost);
    const out = execFileSync(GO_BIN, ['verify', hash, hex(password)], { encoding: 'utf8' }).trim();
    assert.equal(out, 'ok', `${JSON.stringify(password)} ${hash}`);
  }
});
