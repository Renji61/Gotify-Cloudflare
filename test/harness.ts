// Runs the server against Node's built-in SQLite, a recording fake of the
// WebSocket hub and a controllable clock. This stands in for the Durable Object.

import { DatabaseSync } from 'node:sqlite';

import { defaultConfig, type GotifyConfig } from '../src/config.ts';
import type { StreamHub } from '../src/hub.ts';
import { GotifyServer } from '../src/server.ts';
import { migrate, type Sql } from '../src/storage.ts';

function toNode(value: unknown) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function fromNode(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // Durable Object SQLite returns BLOB columns as ArrayBuffer.
    out[key] =
      value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
  }
  return out;
}

export class NodeSql implements Sql {
  db = new DatabaseSync(':memory:');
  private depth = 0;

  all<T>(query: string, ...bindings: unknown[]): T[] {
    return this.db
      .prepare(query)
      .all(...(bindings.map(toNode) as any[]))
      .map((r) => fromNode(r as Record<string, unknown>)) as T[];
  }

  first<T>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] ?? null) as T | null;
  }

  run(query: string, ...bindings: unknown[]): void {
    if (bindings.length === 0 && /^\s*CREATE/i.test(query)) {
      this.db.exec(query);
      return;
    }
    this.db.prepare(query).run(...(bindings.map(toNode) as any[]));
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) throw new Error('nested transactions are not supported');
    this.depth++;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }
}

export interface FakeSocket {
  userId: number;
  token: string;
  /** Messages broadcast to this socket. */
  received: string[];
  closed: boolean;
}

export class FakeHub implements StreamHub {
  sockets: FakeSocket[] = [];

  accept(userId: number, clientToken: string): Response {
    this.sockets.push({ userId, token: clientToken, received: [], closed: false });
    // a real 101 response cannot be built outside the Workers runtime
    return new Response(null, { status: 200, headers: { 'x-fake-upgrade': 'websocket' } });
  }

  broadcast(userId: number, json: string): void {
    for (const s of this.sockets) if (!s.closed && s.userId === userId) s.received.push(json);
  }

  closeClient(userId: number, clientToken: string): void {
    for (const s of this.sockets) if (!s.closed && s.userId === userId && s.token === clientToken) s.closed = true;
  }

  closeUser(userId: number): void {
    for (const s of this.sockets) if (s.userId === userId) s.closed = true;
  }

  connectedTokens(): string[] {
    return [...new Set(this.sockets.filter((s) => !s.closed && s.token).map((s) => s.token))];
  }

  hasConnections(): boolean {
    return this.sockets.some((s) => !s.closed);
  }

  open(userId?: number) {
    return this.sockets.filter((s) => !s.closed && (userId === undefined || s.userId === userId));
  }
}

export interface CallOptions {
  /** JSON body. */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  /** Raw body (set content-type in headers). */
  body?: BodyInit;
  headers?: Record<string, string>;
  /** [name, password] for HTTP basic auth. */
  basic?: [string, string];
  /** Sent as the X-Gotify-Key header. */
  key?: string;
  bearer?: string;
  cookie?: string;
}

export const BASE = 'https://gotify.example.com';
export const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

export async function makeServer(overrides: Partial<GotifyConfig> = {}) {
  const sql = new NodeSql();
  migrate(sql);
  const hub = new FakeHub();
  const clock = { now: T0 };
  const config = defaultConfig({
    passStrength: 4, // keeps the tests fast
    defaultUser: { name: 'admin', pass: 'admin' },
    secureCookie: false,
    ...overrides,
  });
  const server = new GotifyServer(sql, hub, config, () => clock.now);
  await server.initialize();

  async function call(method: string, path: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    let body: BodyInit | undefined = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
    } else if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (opts.basic) headers.authorization = 'Basic ' + Buffer.from(`${opts.basic[0]}:${opts.basic[1]}`).toString('base64');
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.key) headers['x-gotify-key'] = opts.key;
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await server.handle(new Request(BASE + path, { method, headers, body }));
    const text = await res.text();
    let json: any;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json, response: res };
  }

  const admin = { basic: ['admin', 'admin'] as [string, string] };

  return { server, sql, hub, clock, config, call, admin, store: server.store };
}

export type Harness = Awaited<ReturnType<typeof makeServer>>;

/** Creates a user through the admin API. Returns the user and its basic auth pair. */
export async function createUser(h: Harness, name: string, pass = 'pass', admin = false) {
  const res = await h.call('POST', '/user', { ...h.admin, json: { name, pass, admin } });
  if (res.status !== 200) throw new Error(`createUser failed: ${res.status} ${res.text}`);
  return { user: res.json, basic: [name, pass] as [string, string] };
}

export async function createApp(h: Harness, auth: CallOptions, name = 'app', extra: Record<string, unknown> = {}) {
  const res = await h.call('POST', '/application', { ...auth, json: { name, ...extra } });
  if (res.status !== 200) throw new Error(`createApp failed: ${res.status} ${res.text}`);
  return res.json as { id: number; token: string; name: string; sortKey: string };
}

export async function createClient(h: Harness, auth: CallOptions, name = 'client', extra: Record<string, unknown> = {}) {
  const res = await h.call('POST', '/client', { ...auth, json: { name, ...extra } });
  if (res.status !== 200) throw new Error(`createClient failed: ${res.status} ${res.text}`);
  return res.json as { id: number; token: string };
}

/** A tiny valid PNG (1x1). */
export const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

export function multipartBody(fileName: string, bytes: Uint8Array, fieldName = 'file') {
  const form = new FormData();
  form.append(fieldName, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), fileName);
  return form;
}
