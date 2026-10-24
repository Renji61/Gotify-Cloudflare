// Ported from Gotify's fracdex/fracdex_test.go (CC0-1.0, rocicorp/fracdex).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keyBetween, nKeysBetween } from '../src/fracdex.ts';

function check(a: string, b: string, exp: string) {
  let act: string;
  try {
    act = keyBetween(a, b);
  } catch (e) {
    assert.equal((e as Error).message, exp, `keyBetween(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    return;
  }
  assert.equal(act, exp, `keyBetween(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
}

test('keyBetween', () => {
  check('', '', 'a0');
  check('', 'a0', 'Zz');
  check('', 'Zz', 'Zy');
  check('a0', '', 'a1');
  check('a1', '', 'a2');
  check('a0', 'a1', 'a0V');
  check('a1', 'a2', 'a1V');
  check('a0V', 'a1', 'a0l');
  check('Zz', 'a0', 'ZzV');
  check('Zz', 'a1', 'a0');
  check('', 'Y00', 'Xzzz');
  check('bzz', '', 'c000');
  check('a0', 'a0V', 'a0G');
  check('a0', 'a0G', 'a08');
  check('b125', 'b129', 'b127');
  check('a0', 'a1V', 'a1');
  check('Zz', 'a01', 'a0');
  check('', 'a0V', 'a0');
  check('', 'b999', 'b99');
  check('aV', 'aV0V', 'aV0G');
  check('', 'A00000000000000000000000000', 'invalid order key: A00000000000000000000000000');
  check('', 'A000000000000000000000000001', 'A000000000000000000000000000V');
  check('zzzzzzzzzzzzzzzzzzzzzzzzzzy', '', 'zzzzzzzzzzzzzzzzzzzzzzzzzzz');
  check('zzzzzzzzzzzzzzzzzzzzzzzzzzz', '', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzV');
  check('a00', '', 'invalid order key: a00');
  check('a00', 'a1', 'invalid order key: a00');
  check('0', '1', 'invalid order key head: 0');
  check('a1', 'a0', 'a1 >= a0');
});

test('nKeysBetween', () => {
  const run = (a: string, b: string, n: number) => nKeysBetween(a, b, n).join(' ');
  assert.equal(run('', '', 5), 'a0 a1 a2 a3 a4');
  assert.equal(run('a4', '', 10), 'a5 a6 a7 a8 a9 aA aB aC aD aE');
  assert.equal(run('', 'a0', 5), 'Zv Zw Zx Zy Zz');
  assert.equal(run('a0', 'a2', 20), 'a04 a08 a0G a0K a0O a0V a0Z a0d a0l a0t a1 a14 a18 a1G a1O a1V a1Z a1d a1l a1t');
});
