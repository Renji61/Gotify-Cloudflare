// Ed25519ph (RFC 8032, section 5.1, "HashEdDSA") with BigInt arithmetic.
//
// Why this exists: Gotify's v3 tokens carry an Ed25519ph signature over
// SHA-512("iat=<unix seconds>"), produced by Go's
//   ed25519.PrivateKey.Sign(nil, digest, &ed25519.Options{Hash: crypto.SHA512})
// WebCrypto (in Workers and Node) only offers pure Ed25519, so the prehashed
// variant is implemented here. SHA-512 itself comes from crypto.subtle.
//
// This is not constant-time. It is used to *verify* signatures on public data
// (the public key and the signature are both in the token), and to sign in
// tests; it never handles a secret in the request path.

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function pow(base: bigint, exp: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function inv(a: bigint): bigint {
  return pow(a, P - 2n);
}

const D = mod(-121665n * inv(121666n));
const D2 = mod(2n * D);
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Point = { x: bigint; y: bigint; z: bigint; t: bigint };

const IDENTITY: Point = { x: 0n, y: 1n, z: 1n, t: 0n };

function add(p: Point, q: Point): Point {
  const a = mod((p.y - p.x) * (q.y - q.x));
  const b = mod((p.y + p.x) * (q.y + q.x));
  const c = mod(p.t * D2 * q.t);
  const d = mod(2n * p.z * q.z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { x: mod(e * f), y: mod(g * h), z: mod(f * g), t: mod(e * h) };
}

function mul(p: Point, scalar: bigint): Point {
  let result = IDENTITY;
  let addend = p;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

function negate(p: Point): Point {
  return { x: mod(-p.x), y: p.y, z: p.z, t: mod(-p.t) };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodePoint(p: Point): Uint8Array {
  const zi = inv(p.z);
  const x = mod(p.x * zi);
  const y = mod(p.y * zi);
  const out = bigIntToBytes(y, 32);
  if (x & 1n) out[31] |= 0x80;
  return out;
}

function recoverX(y: bigint, sign: number): bigint | null {
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
  if (x2 === 0n) return sign ? null : 0n;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
  if (mod(x * x - x2) !== 0n) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return x;
}

function decodePoint(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  const copy = Uint8Array.from(bytes);
  const sign = copy[31] >> 7;
  copy[31] &= 0x7f;
  const y = bytesToBigInt(copy);
  if (y >= P) return null;
  const x = recoverX(y, sign);
  if (x === null) return null;
  return { x, y, z: 1n, t: mod(x * y) };
}

const BASE_Y = mod(4n * inv(5n));
const BASE: Point = (() => {
  const x = recoverX(BASE_Y, 0)!;
  return { x, y: BASE_Y, z: 1n, t: mod(x * BASE_Y) };
})();

async function sha512(...parts: Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const p of parts) total += p.length;
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-512', all));
}

const DOM2_PREFIX = new TextEncoder().encode('SigEd25519 no Ed25519 collisions');

function dom2(context: Uint8Array): Uint8Array {
  const out = new Uint8Array(DOM2_PREFIX.length + 2 + context.length);
  out.set(DOM2_PREFIX);
  out[DOM2_PREFIX.length] = 1; // phflag = 1 (prehashed)
  out[DOM2_PREFIX.length + 1] = context.length;
  out.set(context, DOM2_PREFIX.length + 2);
  return out;
}

export const SIGNATURE_SIZE = 64;
export const PUBLIC_KEY_SIZE = 32;
export const SEED_SIZE = 32;
export const PREHASH_SIZE = 64;

/** Derives the public key from a 32 byte seed using BigInt (see tokens.ts for the WebCrypto path). */
export async function publicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== SEED_SIZE) throw new Error('ed25519: bad seed length');
  const h = await sha512(seed);
  const s = clampScalar(h.subarray(0, 32));
  return encodePoint(mul(BASE, s));
}

function clampScalar(bytes: Uint8Array): bigint {
  const a = Uint8Array.from(bytes);
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  return bytesToBigInt(a);
}

/**
 * Verifies an Ed25519ph signature. `prehash` is the 64 byte SHA-512 digest of
 * the message (what Go's ed25519.VerifyWithOptions receives with Hash: SHA512).
 * Like Go, it is cofactorless and compares the encoding of [S]B - [k]A with R.
 */
export async function ed25519phVerify(
  publicKey: Uint8Array,
  prehash: Uint8Array,
  signature: Uint8Array,
  context: Uint8Array = new Uint8Array(0),
): Promise<boolean> {
  if (publicKey.length !== PUBLIC_KEY_SIZE) return false;
  if (signature.length !== SIGNATURE_SIZE) return false;
  if (prehash.length !== PREHASH_SIZE) return false;
  if (context.length > 255) return false;
  const a = decodePoint(publicKey);
  if (!a) return false;
  const rBytes = signature.subarray(0, 32);
  const s = bytesToBigInt(signature.subarray(32));
  if (s >= L) return false;
  const k = mod(bytesToBigInt(await sha512(dom2(context), rBytes, publicKey, prehash)), L);
  const check = add(mul(BASE, s), mul(negate(a), k));
  const encoded = encodePoint(check);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= encoded[i] ^ rBytes[i];
  return diff === 0;
}

/** Signs a 64 byte SHA-512 digest with Ed25519ph (deterministic, like Go). */
export async function ed25519phSign(
  seed: Uint8Array,
  prehash: Uint8Array,
  context: Uint8Array = new Uint8Array(0),
): Promise<Uint8Array> {
  if (seed.length !== SEED_SIZE) throw new Error('ed25519: bad seed length');
  if (prehash.length !== PREHASH_SIZE) throw new Error('ed25519: bad prehash length');
  if (context.length > 255) throw new Error('ed25519: bad context length');
  const h = await sha512(seed);
  const s = clampScalar(h.subarray(0, 32));
  const prefix = h.subarray(32);
  const publicKey = encodePoint(mul(BASE, s));
  const dom = dom2(context);
  const r = mod(bytesToBigInt(await sha512(dom, prefix, prehash)), L);
  const rBytes = encodePoint(mul(BASE, r));
  const k = mod(bytesToBigInt(await sha512(dom, rBytes, publicKey, prehash)), L);
  const sOut = mod(r + k * s, L);
  const signature = new Uint8Array(64);
  signature.set(rBytes);
  signature.set(bigIntToBytes(sOut, 32), 32);
  return signature;
}
