// How the Worker passes a request to the Durable Object (kept free of cloudflare:workers so it can be tested).

import { DEFAULT_MAX_BODY_BYTES } from './config.ts';
import { errorBody } from './http.ts';
import { MAX_IMPORT_BYTES } from './import.ts';

const HEADROOM = 64 * 1024;

/** Largest body the object ever accepts (the import cap) plus headroom. */
export const MAX_FORWARD_BYTES = MAX_IMPORT_BYTES + HEADROOM;

/**
 * DELIBERATE DIVERGENCE: a declared Content-Length above the limit is answered 413 here, with the same body
 * the object gives, before anything is buffered in the 128 MB Worker isolate. The limit is the import cap
 * (plus headroom) for POST /_import and the configured GOTIFY_SERVER_MAXBODYBYTES (plus headroom) for every
 * other path; "0" (no limit) is still capped at the import cap, so nothing larger than that is ever buffered.
 * 'buffer': read the body into memory first; 'as-is': forward the request untouched.
 */
export function forwardPlan(request: Request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): 'as-is' | 'buffer' | Response {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return 'as-is';
  const declared = request.headers.get('content-length');
  const isImport = request.method === 'POST' && new URL(request.url).pathname === '/_import';
  const limit = isImport || maxBodyBytes === 0 ? MAX_FORWARD_BYTES : Math.min(MAX_FORWARD_BYTES, maxBodyBytes + HEADROOM);
  if (declared !== null && Number(declared) > limit) {
    return new Response(errorBody(413, 'http: request body too large'), { status: 413, headers: { 'Content-Type': 'application/json' } });
  }
  return 'buffer';
}
