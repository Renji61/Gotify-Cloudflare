// Gotify v3 "enhanced" tokens, ported from auth/token.go.
//
// Three string forms exist:
//   private:  gtfy<ident>.<base64url(32 byte Ed25519 seed)>
//             what the user gets and keeps; sent as the bearer token.
//   public:   gtfy<ident>.<base64url(32 byte Ed25519 public key)>
//             what the database stores. It is derived from the private form,
//             so a database leak does not reveal usable tokens.
//   signed:   gtfy<ident>.<base64url(public key)>.<unix seconds>.<base64url(64 byte signature)>
//             optional, never stored: a client can prove it owns the private
//             key without sending it. The signature is Ed25519ph over
//             SHA-512("iat=<unix seconds>") and must be within +-15 minutes.
//
// Tokens that do not start with "gtfy" are legacy plain tokens (pre-v3,
// e.g. "AxxxxxxxxxxxxXX"), which are looked up directly.

import {
  ed25519phSign,
  ed25519phVerify,
  publicKeyFromSeed,
  PUBLIC_KEY_SIZE,
  SEED_SIZE,
  SIGNATURE_SIZE,
} from './ed25519ph.ts';

export const ENHANCED_TOKEN_PREFIX = 'gtfy';
export const MAX_TIMESTAMP_DIFF_SECONDS = 15 * 60;

/** The token cannot be parsed (upstream: errCannotParseToken, answered with 401). */
export class CannotParseTokenError extends Error {
  constructor(message: string) {
    super(`cannot parse token: ${message}`);
    this.name = 'CannotParseTokenError';
  }
}

/** A signed token whose signature does not verify (upstream: errInvalidToken). */
export class InvalidTokenError extends Error {
  constructor() {
    super('invalid token');
    this.name = 'InvalidTokenError';
  }
}

export class NoPrivateKeyError extends Error {
  constructor() {
    super('no private key');
    this.name = 'NoPrivateKeyError';
  }
}

export interface EnhancedToken {
  ident: string;
  /** The seed (private form) or the public key (signed form). */
  key: Uint8Array;
  /** Unix seconds; 0 for the private form. */
  timestamp: number;
  signature: Uint8Array;
}

// ---- base64url (Go's base64.RawURLEncoding, lenient like Go) --------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < B64URL.length; i++) B64URL_DECODE[B64URL.charCodeAt(i)] = i;

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/** Go's DecodedLen for unpadded encodings. */
function decodedLen(n: number): number {
  return Math.floor((n * 6) / 8);
}

/**
 * Decodes unpadded base64url the way Go's RawURLEncoding does without Strict():
 * CR and LF are skipped and non-zero trailing bits are ignored. Returns null on
 * invalid input.
 */
export function base64UrlDecode(input: string): Uint8Array | null {
  const src = input.replace(/[\r\n]/g, '');
  if (src.length % 4 === 1) return null;
  const out = new Uint8Array(decodedLen(src.length));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    const v = c < 128 ? B64URL_DECODE[c] : -1;
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

// ---- Ed25519 public key derivation -----------------------------------------

// RFC 8410 PKCS#8 prefix for an Ed25519 private key; the 32 byte seed follows.
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

let webCryptoEd25519: boolean | undefined;

/**
 * Derives the public key from a seed. Uses WebCrypto (native speed) when the
 * runtime supports Ed25519, otherwise the BigInt implementation.
 */
export async function derivePublicKey(seed: Uint8Array): Promise<Uint8Array> {
  if (webCryptoEd25519 !== false) {
    try {
      const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
      pkcs8.set(PKCS8_ED25519_PREFIX);
      pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
      const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
      const jwk = (await crypto.subtle.exportKey('jwk', key)) as { x?: string };
      const pub = jwk.x ? base64UrlDecode(jwk.x) : null;
      if (pub && pub.length === PUBLIC_KEY_SIZE) {
        webCryptoEd25519 = true;
        return pub;
      }
    } catch {
      // fall through to the portable implementation
    }
    webCryptoEd25519 = false;
  }
  return publicKeyFromSeed(seed);
}

// ---- parsing / formatting ----------------------------------------------------

function iatDigest(timestamp: number): Promise<Uint8Array> {
  return crypto.subtle.digest('SHA-512', new TextEncoder().encode(`iat=${timestamp}`)).then((d) => new Uint8Array(d));
}

/** Port of ParseEnhancedToken. Throws CannotParseTokenError or InvalidTokenError. */
export async function parseEnhancedToken(input: string): Promise<EnhancedToken> {
  if (!input.startsWith(ENHANCED_TOKEN_PREFIX)) {
    throw new CannotParseTokenError(`token must start with ${ENHANCED_TOKEN_PREFIX}`);
  }
  const rest = input.slice(ENHANCED_TOKEN_PREFIX.length);
  // strings.SplitN(token, ".", 4)
  const fields: string[] = [];
  let remaining = rest;
  while (fields.length < 3) {
    const idx = remaining.indexOf('.');
    if (idx < 0) break;
    fields.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx + 1);
  }
  fields.push(remaining);
  if (fields.length !== 2 && fields.length !== 4) {
    throw new CannotParseTokenError('token must have 2 or 4 fields separated by dots');
  }
  const ident = fields[0];
  const keyB64 = fields[1];
  const keyLen = decodedLen(keyB64.length);
  const key = base64UrlDecode(keyB64);
  if (!key) throw new CannotParseTokenError('base64 decode failed: illegal base64 data');
  if (fields.length === 2) {
    if (keyLen !== SEED_SIZE) throw new CannotParseTokenError(`private key must be ${SEED_SIZE} bytes`);
    return { ident, key, timestamp: 0, signature: new Uint8Array(0) };
  }
  if (keyLen !== PUBLIC_KEY_SIZE) throw new CannotParseTokenError(`public key must be ${PUBLIC_KEY_SIZE} bytes`);
  const timestampText = fields[2];
  if (!/^[+-]?\d+$/.test(timestampText) || !Number.isSafeInteger(Number(timestampText))) {
    throw new CannotParseTokenError(`timestamp must be an integer: invalid syntax`);
  }
  const timestamp = Number(timestampText);
  const sigB64 = fields[3];
  if (decodedLen(sigB64.length) !== SIGNATURE_SIZE) {
    throw new CannotParseTokenError(`signature must be ${SIGNATURE_SIZE} bytes`);
  }
  const signature = base64UrlDecode(sigB64);
  if (!signature) throw new CannotParseTokenError('base64 decode failed: illegal base64 data');
  if (!(await ed25519phVerify(key, await iatDigest(timestamp), signature))) throw new InvalidTokenError();
  return { ident, key, timestamp, signature };
}

function isSigned(token: EnhancedToken): boolean {
  return token.timestamp !== 0 || token.signature.length !== 0;
}

/** The canonical public representation (what the database stores). */
export async function tokenPublicForm(token: EnhancedToken): Promise<string> {
  const pub = isSigned(token) ? token.key : await derivePublicKey(token.key);
  return `${ENHANCED_TOKEN_PREFIX}${token.ident}.${base64UrlEncode(pub)}`;
}

/** The string form of the token itself (private form, or signed form). */
export function tokenToString(token: EnhancedToken): string {
  let s = `${ENHANCED_TOKEN_PREFIX}${token.ident}.${base64UrlEncode(token.key)}`;
  if (isSigned(token)) s += `.${token.timestamp}.${base64UrlEncode(token.signature)}`;
  return s;
}

/** Signs `timestamp` with the private form of a token, producing the signed form. */
export async function signToken(token: EnhancedToken, timestamp: number): Promise<EnhancedToken> {
  if (isSigned(token) || token.key.length !== SEED_SIZE) throw new NoPrivateKeyError();
  const signature = await ed25519phSign(token.key, await iatDigest(timestamp));
  return { ident: token.ident, key: await derivePublicKey(token.key), timestamp, signature };
}

export function validateTimestamp(token: EnhancedToken, nowSeconds: number): boolean {
  if (!isSigned(token)) return true;
  if (token.timestamp < nowSeconds - MAX_TIMESTAMP_DIFF_SECONDS) return false;
  if (token.timestamp > nowSeconds + MAX_TIMESTAMP_DIFF_SECONDS) return false;
  return true;
}

export function newEnhancedToken(ident: string): EnhancedToken {
  return {
    ident: ident.replaceAll('.', '_'),
    key: crypto.getRandomValues(new Uint8Array(SEED_SIZE)),
    timestamp: 0,
    signature: new Uint8Array(0),
  };
}

export interface GeneratedToken {
  /** Stored in the database. */
  publicForm: string;
  /** Handed to the user once. */
  privateForm: string;
}

async function generate(ident: string): Promise<GeneratedToken> {
  const token = newEnhancedToken(ident);
  return { publicForm: await tokenPublicForm(token), privateForm: tokenToString(token) };
}

export const generateApplicationToken = () => generate('a');
export const generateClientToken = () => generate('c');

const TOKEN_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

/** 25 random characters, like auth.GenerateImageName (64 symbols, so no modulo bias). */
export function generateImageName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  let out = '';
  for (const b of bytes) out += TOKEN_CHARACTERS[b & 63];
  return out;
}

/**
 * Resolves a presented token string to the form stored in the database:
 *  - "gtfy..." tokens are parsed and reduced to their public form. A signed token
 *    outside the +-15 minute window resolves to null (it is treated as unknown).
 *    Parse failures throw (CannotParseTokenError, InvalidTokenError).
 *  - anything else is a legacy plain token and is used as is.
 */
export async function resolveStoredToken(presented: string, nowSeconds: number): Promise<string | null> {
  if (!presented.startsWith(ENHANCED_TOKEN_PREFIX)) return presented;
  const parsed = await parseEnhancedToken(presented);
  if (!validateTimestamp(parsed, nowSeconds)) return null;
  return tokenPublicForm(parsed);
}
