// Cloudflare entry point.
//
//  - The default export is the Worker. It serves the web UI (index.html with the
//    runtime config filled in, manifest.json and static/*) from static assets and
//    forwards everything else (API, /stream, /image/*, /health, /version,
//    /gotifyinfo) to the single Durable Object.
//  - GotifyStore is that Durable Object. It owns the SQLite database (users,
//    applications, clients, messages and application images) and the open
//    /stream WebSockets.
//
// WebSockets use the Durable Object WebSocket Hibernation API: the object can be
// evicted from memory while clients stay connected and is woken for each event.
// The server never sends pings. The runtime answers protocol-level ping frames
// (the Android app's OkHttp pings) on its own without waking the object, so no
// keep-alive timer is needed. Gotify's own 45 second server-side pings are not
// reproduced because they would keep the object awake and billing for no benefit.
//
// Upstream's 5 minute background job (keep tokens of connected clients alive,
// delete expired clients) is a Durable Object alarm here. It is only scheduled
// while there are open sockets, or while some client has an inactivity expiry.

import { DurableObject } from 'cloudflare:workers';

import { closeSocket, schemaIsCurrent, syncAlarm, warnOnce } from './dosupport.ts';
import { configFromEnv, ConfigError, DEFAULT_MAX_BODY_BYTES, type GotifyConfig } from './config.ts';
import { forwardPlan } from './forward.ts';
import { goJSON } from './http.ts';
import type { StreamHub } from './hub.ts';
import { GotifyServer } from './server.ts';
import { migrate, type Sql } from './storage.ts';
import { renderIndex, uiConfigJson } from './ui.ts';

export interface Env {
  GOTIFY: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Optional settings, see wrangler.jsonc for what each one does.
  GOTIFY_REGISTRATION?: string;
  GOTIFY_PASSSTRENGTH?: string;
  GOTIFY_SERVER_SECURECOOKIE?: string;
  GOTIFY_SERVER_STREAM_ALLOWEDORIGINS?: string;
  GOTIFY_SERVER_CORS_ALLOWORIGINS?: string;
  GOTIFY_SERVER_CORS_ALLOWMETHODS?: string;
  GOTIFY_SERVER_CORS_ALLOWHEADERS?: string;
  GOTIFY_SERVER_MAXBODYBYTES?: string;
  GOTIFY_SERVER_RESPONSEHEADERS?: string;
  GOTIFY_DEFAULTUSER_NAME?: string;
  /** Secret: set it with `wrangler secret put GOTIFY_DEFAULTUSER_PASS`. */
  GOTIFY_DEFAULTUSER_PASS?: string;
  /** Secret, optional: `wrangler secret put GOTIFY_IMPORT_TOKEN` enables POST /_import (one-time import, see src/import.ts). */
  GOTIFY_IMPORT_TOKEN?: string;
}

function loadConfig(env: Env): GotifyConfig {
  return configFromEnv(env as unknown as Record<string, unknown>);
}

// ---- Durable Object SQLite ---------------------------------------------------

class DurableSql implements Sql {
  constructor(private storage: DurableObjectStorage) {}

  all<T>(query: string, ...bindings: unknown[]): T[] {
    return this.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  first<T>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] ?? null) as T | null;
  }

  run(query: string, ...bindings: unknown[]): void {
    // exec() is lazy for SELECT-like cursors; toArray() makes sure it has run to the end.
    this.storage.sql.exec(query, ...bindings).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

// ---- WebSocket hub (hibernation API) -----------------------------------------

interface SocketInfo {
  userId: number;
  /** Stored (public form) token of the client that opened the socket, "" for basic auth. */
  token: string;
}

const userTag = (userId: number) => `u:${userId}`;
const clientTag = (userId: number, token: string) => `c:${userId}:${token}`;

// WebSocket readyState values
const CLOSING = 2;
const CLOSED = 3;

class DurableHub implements StreamHub {
  constructor(private ctx: DurableObjectState) {}

  accept(userId: number, clientToken: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const tags = [userTag(userId)];
    if (clientToken) tags.push(clientTag(userId, clientToken));
    this.ctx.acceptWebSocket(server, tags);
    const info: SocketInfo = { userId, token: clientToken };
    server.serializeAttachment(info);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(userId: number, json: string): void {
    for (const ws of this.ctx.getWebSockets(userTag(userId))) {
      try {
        ws.send(json);
      } catch {
        // a socket that cannot be written to is already going away
      }
    }
  }

  closeClient(userId: number, clientToken: string): void {
    for (const ws of this.ctx.getWebSockets(clientTag(userId, clientToken))) this.close(ws, 'client removed');
  }

  closeUser(userId: number): void {
    for (const ws of this.ctx.getWebSockets(userTag(userId))) this.close(ws, 'user removed');
  }

  connectedTokens(): string[] {
    const tokens = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.isOpen(ws)) continue;
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if (info && info.token) tokens.add(info.token);
    }
    return [...tokens];
  }

  hasConnections(): boolean {
    return this.ctx.getWebSockets().some((ws) => this.isOpen(ws));
  }

  private isOpen(ws: WebSocket): boolean {
    return ws.readyState !== CLOSING && ws.readyState !== CLOSED;
  }

  private close(ws: WebSocket, reason: string) {
    closeSocket(ws, 1000, reason);
  }
}

// ---- the Durable Object -------------------------------------------------------

export class GotifyStore extends DurableObject<Env> {
  private server?: GotifyServer;
  private configError?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = new DurableSql(ctx.storage);
    let config: GotifyConfig | undefined;
    try {
      config = loadConfig(env);
    } catch (e) {
      this.configError = e instanceof ConfigError ? e.message : String(e);
    }
    if (config) this.server = new GotifyServer(sql, new DurableHub(ctx), config);
    const server = this.server;
    // Nothing may run before the schema exists and the first administrator has been created.
    ctx.blockConcurrencyWhile(async () => {
      if (!schemaIsCurrent(sql)) migrate(sql);
      if (!server) return;
      const result = await server.initialize();
      if (result === 'created') console.log(`created the administrator "${config?.defaultUser.name}"`);
      else if (result === 'no-password') {
        // the object is woken up often: say it once per isolate
        warnOnce('no-default-password', 'no users exist and GOTIFY_DEFAULTUSER_PASS is not set: no administrator was created');
      } else if (result === 'invalid-password') {
        console.warn('GOTIFY_DEFAULTUSER_PASS is longer than 72 bytes: no administrator was created');
      }
      await this.scheduleAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.server) {
      return new Response(
        goJSON({ error: 'Internal Server Error', errorCode: 500, errorDescription: `invalid configuration: ${this.configError}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const response = await this.server.handle(request);
    if (this.server.alarmDirty) await this.scheduleAlarm();
    return response;
  }

  // Clients only ever send protocol pings, which the runtime answers. Messages are ignored, like upstream.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Finish the closing handshake.
    closeSocket(ws, code, 'closing');
    await this.scheduleAlarm();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    closeSocket(ws, 1000, 'error');
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> {
    if (!this.server) return;
    this.server.runMaintenance();
    await this.scheduleAlarm();
  }

  /**
   * Brings the alarm in line with what the server needs (see GotifyServer.nextAlarmAt).
   * Never throws: a scheduling problem must not fail a request or the object's start.
   */
  private async scheduleAlarm(): Promise<void> {
    if (!this.server) return;
    this.server.alarmDirty = false;
    let wanted: number | null = null;
    try {
      wanted = this.server.nextAlarmAt();
    } catch (e) {
      console.error('could not plan the maintenance alarm:', e instanceof Error ? e.message : String(e));
      return;
    }
    await syncAlarm(this.ctx.storage, wanted, Date.now());
  }
}

// ---- the Worker -----------------------------------------------------------------

let cachedUiConfig: string | undefined;

/** The JSON that replaces %CONFIG% in index.html. Throws ConfigError for an invalid configuration. */
function uiConfig(env: Env): string {
  cachedUiConfig ??= uiConfigJson(loadConfig(env));
  return cachedUiConfig;
}

let cachedMaxBodyBytes: number | undefined;

/** GOTIFY_SERVER_MAXBODYBYTES for the Worker's early 413; an invalid configuration falls back to the default (the object reports it). */
function maxBodyBytes(env: Env): number {
  try {
    cachedMaxBodyBytes ??= loadConfig(env).maxBodyBytes;
  } catch {
    return DEFAULT_MAX_BODY_BYTES;
  }
  return cachedMaxBodyBytes;
}

async function serveIndex(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString()));
  if (!asset.ok) return asset;
  let config: string;
  try {
    config = uiConfig(env);
  } catch (e) {
    return new Response(`invalid configuration: ${e instanceof Error ? e.message : String(e)}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const html = renderIndex(await asset.text(), config);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    // The UI, exactly the paths upstream's ui/serve.go serves.
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveIndex(request, env);
    if ((method === 'GET' || method === 'HEAD') && (pathname === '/manifest.json' || pathname.startsWith('/static/'))) {
      return env.ASSETS.fetch(request);
    }

    // One object holds all the data. A single instance keeps ids and sort keys consistent.
    const store = env.GOTIFY.get(env.GOTIFY.idFromName('main'));
    // Buffered: a streamed body that the object rejects unread (too large) makes the runtime throw
    // "Can't read from request stream after response has been sent". Bodies are at most a few MiB.
    const plan = forwardPlan(request, maxBodyBytes(env));
    if (plan === 'as-is') return store.fetch(request);
    if (plan !== 'buffer') return plan;
    return store.fetch(new Request(request, { body: await request.arrayBuffer() }));
  },
} satisfies ExportedHandler<Env>;
