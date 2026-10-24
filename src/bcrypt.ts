// bcrypt in plain TypeScript, byte-compatible with golang.org/x/crypto/bcrypt
// (which is what upstream Gotify uses for user passwords).
//
//  - Verifies $2a$, $2b$ and $2y$ hashes (like Go: any minor version byte is
//    accepted, a major version above '2' is rejected).
//  - Generates $2a$ hashes.
//  - Passwords are limited to 72 bytes when hashing (Go returns
//    ErrPasswordTooLong); when comparing, bytes beyond 72 are ignored, which is
//    what the algorithm does and what Go does.
//
// It is synchronous and CPU bound: cost 10 takes roughly 50-100 ms.

import { BLOWFISH_P, BLOWFISH_S } from './blowfish-tables.ts';

export const MIN_COST = 4;
export const MAX_COST = 31;
export const DEFAULT_COST = 10;
export const MAX_PASSWORD_BYTES = 72;

export class PasswordTooLongError extends Error {
  constructor() {
    super('bcrypt: password length exceeds 72 bytes');
    this.name = 'PasswordTooLongError';
  }
}

export class InvalidCostError extends Error {
  constructor(cost: number) {
    super(`crypto/bcrypt: cost ${cost} is outside allowed inclusive range ${MIN_COST}..${MAX_COST}`);
    this.name = 'InvalidCostError';
  }
}

const ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** bcrypt's base64 variant, without padding. */
function b64Encode(src: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= src.length; i += 3) {
    const n = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = src.length - i;
  if (rest === 1) {
    const n = src[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (src[i] << 16) | (src[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Decodes unpadded bcrypt base64; trailing bits are ignored (like Go). Returns null on bad input. */
function b64Decode(src: string): Uint8Array | null {
  if (src.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((src.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    const v = c < 128 ? DECODE[c] : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < out.length) out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

// ---- Blowfish with the bcrypt "expensive key setup" ------------------------

const P = new Uint32Array(18);
const S = new Uint32Array(1024);
let outL = 0;
let outR = 0;

function initState() {
  for (let i = 0; i < 18; i++) P[i] = BLOWFISH_P[i];
  for (let i = 0; i < 1024; i++) S[i] = BLOWFISH_S[i];
}

/** Encrypts one block with the current state; the result is left in outL/outR. */
function encryptBlock(l: number, r: number) {
  let xl = (l ^ P[0]) >>> 0;
  let xr = r >>> 0;
  for (let i = 1; i <= 15; i += 2) {
    xr = (xr ^ P[i] ^ ((((S[xl >>> 24] + S[256 + ((xl >>> 16) & 0xff)]) ^ S[512 + ((xl >>> 8) & 0xff)]) + S[768 + (xl & 0xff)]) >>> 0)) >>> 0;
    xl = (xl ^ P[i + 1] ^ ((((S[xr >>> 24] + S[256 + ((xr >>> 16) & 0xff)]) ^ S[512 + ((xr >>> 8) & 0xff)]) + S[768 + (xr & 0xff)]) >>> 0)) >>> 0;
  }
  xr = (xr ^ P[17]) >>> 0;
  outL = xr;
  outR = xl;
}

function nextWord(data: Uint8Array, pos: { j: number }): number {
  let w = 0;
  for (let k = 0; k < 4; k++) {
    w = (w << 8) | data[pos.j];
    pos.j++;
    if (pos.j >= data.length) pos.j = 0;
  }
  return w >>> 0;
}

function expandKeyWithSalt(key: Uint8Array, salt: Uint8Array) {
  const pos = { j: 0 };
  for (let i = 0; i < 18; i++) P[i] = (P[i] ^ nextWord(key, pos)) >>> 0;
  pos.j = 0;
  let l = 0;
  let r = 0;
  for (let i = 0; i < 18; i += 2) {
    l = (l ^ nextWord(salt, pos)) >>> 0;
    r = (r ^ nextWord(salt, pos)) >>> 0;
    encryptBlock(l, r);
    l = outL;
    r = outR;
    P[i] = l;
    P[i + 1] = r;
  }
  for (let i = 0; i < 1024; i += 2) {
    l = (l ^ nextWord(salt, pos)) >>> 0;
    r = (r ^ nextWord(salt, pos)) >>> 0;
    encryptBlock(l, r);
    l = outL;
    r = outR;
    S[i] = l;
    S[i + 1] = r;
  }
}

function expandKey(key: Uint8Array) {
  let j = 0;
  const n = key.length;
  for (let i = 0; i < 18; i++) {
    let d = 0;
    for (let k = 0; k < 4; k++) {
      d = (d << 8) | key[j];
      j++;
      if (j >= n) j = 0;
    }
    P[i] = (P[i] ^ d) >>> 0;
  }
  let l = 0;
  let r = 0;
  for (let i = 0; i < 18; i += 2) {
    encryptBlock(l, r);
    l = outL;
    r = outR;
    P[i] = l;
    P[i + 1] = r;
  }
  for (let i = 0; i < 1024; i += 2) {
    encryptBlock(l, r);
    l = outL;
    r = outR;
    S[i] = l;
    S[i + 1] = r;
  }
}

const MAGIC = new TextEncoder().encode('OrpheanBeholderScryDoubt');

/** Raw bcrypt: returns the 23 hash bytes encoded as 31 characters. */
function bcryptRaw(password: Uint8Array, cost: number, salt: Uint8Array): string {
  // Bug compatibility with the C implementation: the key includes the trailing NUL.
  const key = new Uint8Array(password.length + 1);
  key.set(password);
  initState();
  expandKeyWithSalt(key, salt);
  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i++) {
    expandKey(key);
    expandKey(salt);
  }
  const data = new Uint32Array(6);
  const view = new DataView(MAGIC.buffer, MAGIC.byteOffset, MAGIC.byteLength);
  for (let i = 0; i < 6; i++) data[i] = view.getUint32(i * 4, false);
  for (let i = 0; i < 6; i += 2) {
    let l = data[i];
    let r = data[i + 1];
    for (let j = 0; j < 64; j++) {
      encryptBlock(l, r);
      l = outL;
      r = outR;
    }
    data[i] = l;
    data[i + 1] = r;
  }
  const bytes = new Uint8Array(24);
  const out = new DataView(bytes.buffer);
  for (let i = 0; i < 6; i++) out.setUint32(i * 4, data[i], false);
  // Only 23 of the 24 bytes are encoded (bug compatibility).
  return b64Encode(bytes.subarray(0, 23));
}

function toBytes(password: string | Uint8Array): Uint8Array {
  return typeof password === 'string' ? new TextEncoder().encode(password) : password;
}

/** Counts the hashes computed (tests use it to show that refused requests never pay for one). */
export const hashStats = { computed: 0 };

/**
 * Hashes a password like bcrypt.GenerateFromPassword. A cost below 4 selects the
 * default cost of 10 (as in Go). `salt` (16 bytes) is only for tests.
 */
export function hashPassword(password: string | Uint8Array, cost = DEFAULT_COST, salt?: Uint8Array): string {
  const pw = toBytes(password);
  if (pw.length > MAX_PASSWORD_BYTES) throw new PasswordTooLongError();
  if (cost < MIN_COST) cost = DEFAULT_COST;
  if (cost > MAX_COST || !Number.isInteger(cost)) throw new InvalidCostError(cost);
  const rawSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const encodedSalt = b64Encode(rawSalt);
  const decodedSalt = b64Decode(encodedSalt)!;
  hashStats.computed++;
  const hash = bcryptRaw(pw, cost, decodedSalt);
  return `$2a$${String(cost).padStart(2, '0')}$${encodedSalt}${hash}`;
}

interface Parsed {
  cost: number;
  salt: string;
  hash: string;
}

/** Mirrors Go's newFromHash. Returns null for anything Go would reject. */
function parseHash(hashed: string): Parsed | null {
  // Hashes are ASCII; compare byte-wise like Go.
  if (hashed.length < 59) return null;
  if (hashed[0] !== '$') return null;
  if (hashed.charCodeAt(1) > '2'.charCodeAt(0)) return null;
  let n = 3;
  if (hashed[2] !== '$') n = 4; // minor version byte present
  let rest = hashed.slice(n);
  const costText = rest.slice(0, 2);
  if (!/^[+-]?\d{1,2}$/.test(costText)) return null;
  const cost = parseInt(costText, 10);
  if (cost < MIN_COST || cost > MAX_COST) return null;
  rest = rest.slice(3);
  if (rest.length < 22) return null;
  return { cost, salt: rest.slice(0, 22), hash: rest.slice(22) };
}

/** The cost stored in a hash, or null if it is not a valid bcrypt hash. */
export function hashCost(hashed: string): number | null {
  return parseHash(hashed)?.cost ?? null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Like bcrypt.CompareHashAndPassword, but returns a boolean. */
export function comparePassword(hashed: string, password: string | Uint8Array): boolean {
  const p = parseHash(hashed);
  if (!p) return false;
  const salt = b64Decode(p.salt);
  if (!salt) return false;
  const computed = bcryptRaw(toBytes(password), p.cost, salt);
  // Go compares re-serialised hashes, which carry exactly 31 hash characters.
  if (p.hash.length < computed.length) return false;
  return constantTimeEqual(p.hash.slice(0, computed.length), computed);
}
