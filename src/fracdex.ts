// Fractional indexing, ported from Gotify's fracdex package (which ports
// https://github.com/rocicorp/fracdex, CC0-1.0). Application sort keys use it:
// KeyBetween(a, b) returns a key that sorts lexicographically between a and b,
// where "" means "no bound".

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INT = 'A00000000000000000000000000';
const ZERO = 'a0';

export class FracdexError extends Error {}

/** Returns a key that sorts lexicographically between a and b. b must be "" or > a. */
export function keyBetween(a: string, b: string): string {
  if (a !== '') validateOrderKey(a);
  if (b !== '') validateOrderKey(b);
  if (a !== '' && b !== '' && a >= b) throw new FracdexError(`${a} >= ${b}`);

  if (a === '') {
    if (b === '') return ZERO;
    const ib = getIntPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInt(ib);
    if (res === '') throw new FracdexError('range underflow');
    return res;
  }

  if (b === '') {
    const ia = getIntPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInt(ia);
    if (i === '') return ia + midpoint(fa, '');
    return i;
  }

  const ia = getIntPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInt(ia);
  if (i === '') throw new FracdexError('range overflow');
  if (i < b) return i;
  return ia + midpoint(fa, '');
}

/** Returns n keys between a and b, in order. */
export function nKeysBetween(a: string, b: string, n: number): string[] {
  if (n === 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === '') {
    let c = keyBetween(a, b);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(c, b);
      result.push(c);
    }
    return result;
  }
  if (a === '') {
    let c = keyBetween(a, b);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = keyBetween(a, c);
      result.push(c);
    }
    result.reverse();
    return result;
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...nKeysBetween(a, c, mid), c, ...nKeysBetween(c, b, n - mid - 1)];
}

function midpoint(a: string, b: string): string {
  if (b !== '') {
    // Remove the longest common prefix, padding `a` with 0s as we go.
    let i = 0;
    for (; i < b.length; i++) {
      const c = a.length > i ? a[i] : '0';
      if (c !== b[i]) break;
    }
    if (i > 0) {
      if (i > a.length) return b.slice(0, i) + midpoint('', b.slice(i));
      return b.slice(0, i) + midpoint(a.slice(i), b.slice(i));
    }
  }

  // First digits (or lack of digit) are different.
  const digitA = a !== '' ? BASE62.indexOf(a[0]) : 0;
  const digitB = b !== '' ? BASE62.indexOf(b[0]) : BASE62.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return BASE62[midDigit];
  }

  // First digits are consecutive.
  if (b.length > 1) return b.slice(0, 1);

  // `b` is empty or a single digit; `a`'s first digit is the one before it.
  const sa = a.length > 0 ? a.slice(1) : '';
  return BASE62[digitA] + midpoint(sa, '');
}

function validateInt(i: string): void {
  const exp = getIntLen(i[0]);
  if (i.length !== exp) throw new FracdexError(`invalid integer part of order key: ${i}`);
}

function getIntLen(head: string | undefined): number {
  if (head !== undefined && head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head !== undefined && head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new FracdexError(`invalid order key head: ${head ?? ''}`);
}

function getIntPart(key: string): string {
  const len = getIntLen(key[0]);
  if (len > key.length) throw new FracdexError(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function validateOrderKey(key: string): void {
  if (key === SMALLEST_INT) throw new FracdexError(`invalid order key: ${key}`);
  // getIntPart throws if the first character is bad or the key is too short.
  const i = getIntPart(key);
  const f = key.slice(i.length);
  if (f.endsWith('0')) throw new FracdexError(`invalid order key: ${key}`);
}

/** Returns "" if the range is exceeded. */
function incrementInt(x: string): string {
  validateInt(x);
  const digs = x.split('');
  const head = digs.shift()!;
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = BASE62.indexOf(digs[i]) + 1;
    if (d === BASE62.length) {
      digs[i] = '0';
    } else {
      digs[i] = BASE62[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') return 'a0';
    if (head === 'z') return '';
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') digs.push('0');
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}

/** Returns "" if the range is exceeded. */
function decrementInt(x: string): string {
  validateInt(x);
  const digs = x.split('');
  const head = digs.shift()!;
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = BASE62.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = BASE62[BASE62.length - 1];
    } else {
      digs[i] = BASE62[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') return 'Z' + BASE62[BASE62.length - 1];
    if (head === 'A') return '';
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') digs.push(BASE62[BASE62.length - 1]);
    else digs.pop();
    return h + digs.join('');
  }
  return head + digs.join('');
}
