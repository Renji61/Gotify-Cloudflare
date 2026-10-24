// The Gotify server (v3.1.1): routing, authentication and all API handlers.
//
// This file is a port of upstream's router/router.go, auth/*.go and api/*.go.
// It only depends on the Sql and StreamHub interfaces, so it runs unchanged
// inside the Durable Object (worker.ts) and in the Node test suite.
//
// Things that are deliberately the same as upstream, including odd ones:
//  - error bodies are {"error","errorCode","errorDescription"} (error/handler.go),
//  - routes registered before upstream's CORS/response-header middleware
//    (/health and /image/*) do not get CORS handling,
//  - unknown routes and wrong methods answer 404 "page not found" (JSON),
//  - a signed token with a bad signature is a 500, an unparsable one a 401.

import {
  APPLICATION_PARAMS,
  bind,
  bindQuery,
  CLIENT_PARAMS,
  CREATE_MESSAGE,
  CREATE_USER,
  ELEVATE_REQUEST,
  PAGING_PARAMS,
  parseMultipart,
  SECURITY_UPDATE_ACTION,
  UPDATE_USER,
  USER_PASS,
  type BindInput,
  type StructSpec,
} from './binding.ts';
import { comparePassword, hashPassword, MAX_PASSWORD_BYTES } from './bcrypt.ts';
import type { GotifyConfig } from './config.ts';
import { Cors } from './cors.ts';
import { importGotify, MAX_IMPORT_BYTES } from './import.ts';
import { canonicalJSON, errorBody, formatTime, goJSON, HttpError } from './http.ts';
import type { StreamHub } from './hub.ts';
import { fileExt, IMAGE_CONTENT_TYPES, isImage, validImageExt } from './imagetype.ts';
import type { Sql } from './storage.ts';
import { DuplicateSortKeyError, Store, type Application, type Client, type Message, type User } from './store.ts';
import {
  CannotParseTokenError,
  generateApplicationToken,
  generateClientToken,
  generateImageName,
  InvalidTokenError,
  resolveStoredToken,
} from './tokens.ts';

/** Largest accepted application image. A Durable Object SQLite value may hold at most 2 MB, so 1.5 MiB leaves room. */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const IMAGE_TOO_LARGE = 'image is too large (max 1.5 MiB)';
/** Extra room for the multipart framing around an image of MAX_IMAGE_BYTES. */
const MULTIPART_OVERHEAD = 64 * 1024;

/** Lifetime of the session cookie and of the client created by a login (7 days). */
export const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const COOKIE_NAME = 'gotify-client-token';
/** model.DefaultElevationDuration */
const DEFAULT_ELEVATION_MS = 60 * 60 * 1000;
/** How often last_used is refreshed for tokens in use, and the interval of the maintenance job. */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const MSG_UNAUTHORIZED = 'you need to provide a valid access token or user credentials to access this api';
const MSG_FORBIDDEN = 'you are not allowed to access this api';
const MSG_NOT_ELEVATED = 'session not elevated, use basic auth or call /client:elevate';

type AuthMode = 'none' | 'client' | 'elevated' | 'admin' | 'optionalAdmin' | 'appOrClient';

type AuthState = 'skip' | 'forbidden' | 'notElevated' | 'ok' | 'localAuthDisabled';

interface Authenticated {
  user?: User;
  client?: Client;
  app?: Application;
}

/** Per-request state (the gin.Context). */
class Ctx {
  url: URL;
  method: string;
  params: Record<string, string> = {};
  /** Response headers set by middleware and handlers so far. */
  headers = new Headers();
  auth: Authenticated = {};
  private bodyBytes?: Promise<Uint8Array>;

  constructor(
    public request: Request,
    private maxBodyBytes: number,
  ) {
    this.url = new URL(request.url);
    this.method = request.method;
  }

  get host(): string {
    return this.url.host;
  }

  /** Reads the request body once; `limit` (if smaller than the global limit) caps it. */
  body(limit?: number): Promise<Uint8Array> {
    this.bodyBytes ??= readBody(this.request, limit !== undefined && (this.maxBodyBytes === 0 || limit < this.maxBodyBytes) ? limit : this.maxBodyBytes);
    return this.bodyBytes;
  }

  bindInput(): BindInput {
    return {
      method: this.method,
      url: this.url,
      contentType: this.request.headers.get('content-type'),
      body: () => this.body(),
    };
  }

  /** gin's ctx.Bind. */
  bind(spec: StructSpec) {
    return bind(this.bindInput(), spec);
  }

  /** auth.GetUserID: throws if nothing is authenticated (cannot happen behind the auth middleware). */
  get userId(): number {
    const id = this.auth.user?.id ?? this.auth.client?.userId ?? this.auth.app?.userId;
    if (id === undefined) throw new Error('token and user may not be null');
    return id;
  }

  json(body: string, status = 200): Response {
    return new Response(body, { status, headers: this.headers });
  }

  empty(status = 200): Response {
    return new Response(null, { status, headers: this.headers });
  }
}

/** Constant-time comparison (of SHA-256 digests, so the length does not leak either). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (limit > 0 && declared !== null && Number(declared) > limit) throw new HttpError(413, 'http: request body too large');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (limit > 0 && total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'http: request body too large');
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

type Handler = (ctx: Ctx) => Promise<Response | typeof NOT_FOUND>;

/** Returned by a handler that wants the generic 404 (gin's NoRoute). */
const NOT_FOUND = Symbol('not found');

interface Route {
  method: string;
  segments: string[];
  /** Behind upstream's JSON-header + CORS middleware. */
  middleware: boolean;
  auth: AuthMode;
  handler: Handler;
}

// ---- JSON representations (the model/*.go structs) -------------------------

function userJSON(u: User) {
  return { id: u.id, name: u.name, admin: u.admin, createdAt: formatTime(u.createdAt) };
}

function applicationJSON(app: Application, token: string | undefined, resolveImage = true) {
  const out: Record<string, unknown> = { id: app.id };
  if (token) out.token = token;
  out.name = app.name;
  out.description = app.description;
  out.internal = app.internal;
  out.image = resolveImage ? (app.image === '' ? 'static/defaultapp.png' : 'image/' + app.image) : app.image;
  out.defaultPriority = app.defaultPriority;
  out.createdAt = formatTime(app.createdAt);
  out.lastUsed = app.lastUsed === null ? null : formatTime(app.lastUsed);
  out.sortKey = app.sortKey;
  return out;
}

function clientJSON(c: Client, token: string | undefined, elevatedUntil: number | null = c.elevatedUntil) {
  const out: Record<string, unknown> = { id: c.id };
  if (token) out.token = token;
  out.name = c.name;
  out.createdAt = formatTime(c.createdAt);
  out.lastUsed = c.lastUsed === null ? null : formatTime(c.lastUsed);
  if (elevatedUntil !== null) out.elevatedUntil = formatTime(elevatedUntil);
  out.expiresAfterInactivitySeconds = c.expiresAfterInactivitySeconds;
  if (c.expiresAt !== null) out.expiresAt = formatTime(c.expiresAt);
  return out;
}

function currentUserJSON(u: User, clientId?: number, elevatedUntil?: number | null) {
  const out: Record<string, unknown> = { id: u.id, name: u.name, admin: u.admin, createdAt: formatTime(u.createdAt) };
  if (clientId) out.clientId = clientId;
  if (elevatedUntil !== undefined && elevatedUntil !== null) out.elevatedUntil = formatTime(elevatedUntil);
  return out;
}

/** The message as the API and the WebSocket stream send it. Extras is already canonical JSON. */
function messageJSON(m: Message): string {
  let out = `{"id":${m.id},"appid":${m.applicationId},"message":${goJSON(m.message)},"title":${goJSON(m.title)},"priority":${m.priority}`;
  // omitempty: an empty extras object is left out
  if (m.extras !== null && m.extras !== '{}') out += `,"extras":${m.extras}`;
  out += `,"date":"${formatTime(m.date)}"}`;
  return out;
}

// ---- small helpers -----------------------------------------------------------

/** api.withID: ParseUint(id, 10, 64). */
function parseId(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || BigInt(raw) > 18446744073709551615n) throw new HttpError(400, 'invalid id');
  return Number(raw);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** gin's RemoveExtraSlash: collapses repeated slashes. */
function cleanPath(path: string): string {
  return path.replace(/\/{2,}/g, '/');
}

/** http.Cookie.String() for the session cookie. */
function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  let c = `${COOKIE_NAME}=${value}; Path=/`;
  if (maxAge > 0) c += `; Max-Age=${maxAge}`;
  else if (maxAge < 0) c += '; Max-Age=0';
  c += '; HttpOnly';
  if (secure) c += '; Secure';
  c += '; SameSite=Strict';
  return c;
}

/** Request.BasicAuth(). */
function basicAuth(request: Request): { name: string; pass: string } | null {
  const header = request.headers.get('authorization');
  if (!header || header.length < 6 || header.slice(0, 6).toLowerCase() !== 'basic ') return null;
  const encoded = header.slice(6);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { name: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

/** Value of the first cookie with this name (Request.Cookie plus QueryUnescape). */
function readCookie(request: Request, name: string): string {
  const header = request.headers.get('cookie');
  if (!header) return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    let value = trimmed.slice(eq + 1);
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return '';
    }
  }
  return '';
}

/** Host part of an Origin value as Go's url.Parse would report it (userinfo removed). */
function originHost(origin: string): string {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(origin);
  if (!m) return '';
  const authority = m[1];
  return authority.slice(authority.lastIndexOf('@') + 1);
}

/** The hostname (no port) of an Origin value, lower-cased, as url.Parse(origin).Hostname(). */
function originHostname(origin: string): string {
  const host = originHost(origin);
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end < 0 ? host : host.slice(0, end + 1).slice(1, -1);
  }
  const colon = host.lastIndexOf(':');
  return colon < 0 ? host : host.slice(0, colon);
}

/** net/http CrossOriginProtection.Check (Go 1.25). Returns an error message or null. */
function crossOriginCheck(method: string, headers: Headers, host: string): string | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const site = headers.get('sec-fetch-site') ?? '';
  if (site === 'same-origin' || site === 'none') return null;
  if (site !== '') return 'cross-origin request detected from Sec-Fetch-Site header';
  const origin = headers.get('origin') ?? '';
  if (origin === '') return null;
  if (originHost(origin) === host) return null;
  return 'cross-origin request detected, and/or browser is out of date: Sec-Fetch-Site is missing, and Origin does not match Host';
}

// ---- the server --------------------------------------------------------------

export class GotifyServer {
  readonly store: Store;
  /** Set when something changed that may require rescheduling the maintenance alarm. */
  alarmDirty = false;
  private cors: Cors;
  private streamOrigins: RegExp[];
  /** Set when the configuration is unusable; every request is then answered with a 500. */
  private configError?: string;
  private routes: Route[] = [];

  constructor(
    private sql: Sql,
    private hub: StreamHub,
    private config: GotifyConfig,
    private clock: () => number = Date.now,
  ) {
    this.store = new Store(sql, () => this.clock());
    this.cors = new Cors({
      allowOrigins: config.corsAllowOrigins,
      allowMethods: config.corsAllowMethods,
      allowHeaders: config.corsAllowHeaders,
      responseHeaders: config.responseHeaders,
    });
    // Upstream refuses to start with an invalid regular expression. Here every request is answered
    // with a 500 that says what is wrong, until the setting is fixed.
    this.streamOrigins = [];
    for (const [setting, patterns] of [
      ['GOTIFY_SERVER_STREAM_ALLOWEDORIGINS', config.streamAllowedOrigins],
      ['GOTIFY_SERVER_CORS_ALLOWORIGINS', config.corsAllowOrigins],
    ] as const) {
      for (const pattern of patterns) {
        try {
          const re = new RegExp(pattern);
          if (setting === 'GOTIFY_SERVER_STREAM_ALLOWEDORIGINS') this.streamOrigins.push(re);
        } catch (e) {
          this.configError ??= `invalid configuration: ${setting} contains an invalid regular expression ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    this.defineRoutes();
  }

  private now(): number {
    return this.clock();
  }

  /** First run: creates the administrator when there are no users and a password is configured. */
  async initialize(): Promise<'created' | 'exists' | 'no-password' | 'invalid-password'> {
    if (this.store.countUsers() > 0) return 'exists';
    const { name, pass } = this.config.defaultUser;
    if (!pass) return 'no-password';
    if (byteLength(pass) > MAX_PASSWORD_BYTES) return 'invalid-password';
    const hash = hashPassword(pass, this.config.passStrength);
    // re-check: the hash above is the slow part and nothing awaits between here and the insert
    if (this.store.countUsers() > 0) return 'exists';
    this.store.createUser({ name, pass: hash, admin: true });
    return 'created';
  }

  // ---- maintenance (upstream's 5 minute background goroutine) ----

  /** Keeps tokens of connected clients alive and deletes expired clients, closing their sockets. */
  runMaintenance(): void {
    const now = this.now();
    this.store.updateClientTokensLastUsedAndExpiresAt(this.hub.connectedTokens(), now);
    for (const client of this.store.cleanupExpiredClients(now)) {
      this.hub.closeClient(client.userId, client.token);
    }
    this.alarmDirty = false;
  }

  /**
   * When the maintenance alarm should fire next, or null if there is nothing to do.
   * With open sockets: every 5 minutes. Otherwise: when the earliest client with an
   * inactivity expiry would expire.
   */
  nextAlarmAt(): number | null {
    const now = this.now();
    if (this.hub.hasConnections()) return now + FIVE_MINUTES_MS;
    const earliest = this.store.earliestClientExpiry();
    if (earliest === null) return null;
    return Math.max(earliest, now + 1000);
  }

  // ---- entry point ----

  async handle(request: Request): Promise<Response> {
    const ctx = new Ctx(request, this.config.maxBodyBytes);
    let response: Response;
    try {
      if (this.configError) throw new HttpError(500, this.configError);
      response = await this.dispatch(ctx);
    } catch (e) {
      response = this.failure(ctx, e);
    }
    // net/http never sends a body for HEAD
    if (request.method === 'HEAD' && response.body !== null) {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  }

  /** error/handler.go: every error becomes the standard JSON body. */
  private failure(ctx: Ctx, e: unknown): Response {
    let status = 500;
    let description = 'internal server error';
    if (e instanceof HttpError) {
      status = e.status;
      description = e.description;
    } else {
      console.error('request failed', e);
    }
    return new Response(errorBody(status, description), { status, headers: ctx.headers });
  }

  private async dispatch(ctx: Ctx): Promise<Response> {
    const path = cleanPath(ctx.url.pathname);
    const method = ctx.method;
    // Deliberate divergence (see import.ts): POST /_import exists only when GOTIFY_IMPORT_TOKEN is set. It runs
    // before the body limit (own 16 MiB cap, MAX_IMPORT_BYTES) and before normal auth (bearer = the import token).
    if (this.config.importToken && method === 'POST' && path === '/_import') return this.handleImport(ctx, this.config.importToken);

    const matched = this.match(method, path);

    if (matched && !matched.route.middleware) {
      // Registered before the middleware upstream: no JSON header, no CORS.
      const res = await matched.route.handler(withParams(ctx, matched.params));
      if (res !== NOT_FOUND) return res;
      return this.noRoute(ctx);
    }

    if (!matched) {
      const redirect = this.trailingSlashRedirect(method, path, ctx.url);
      if (redirect) return redirect;
    }

    const early = this.applyMiddleware(ctx);
    if (early) return early;

    if (!matched) {
      // g.OPTIONS("/*any") has no handler: it just answers 200.
      if (method === 'OPTIONS') return ctx.empty(200);
      return ctx.json(errorBody(404, 'page not found'), 404);
    }
    const { route, params } = matched;
    withParams(ctx, params);
    await this.authenticate(ctx, route.auth);
    const res = await route.handler(ctx);
    if (res === NOT_FOUND) return ctx.json(errorBody(404, 'page not found'), 404);
    return res;
  }

  /**
   * Upstream's global middleware, in order: JSON content type, configured response
   * headers, CORS. Returns a response when CORS answers the request itself.
   */
  private applyMiddleware(ctx: Ctx): Response | null {
    ctx.headers.set('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(this.config.responseHeaders)) {
      if (value === '') ctx.headers.delete(name);
      else ctx.headers.set(name, value);
    }
    const cors = this.cors.evaluate(ctx.method, ctx.request.headers.get('origin'), ctx.host);
    if (cors.kind === 'reject') return new Response(null, { status: 403, headers: ctx.headers });
    if (cors.kind === 'preflight') {
      for (const [k, v] of cors.headers) ctx.headers.set(k, v);
      return new Response(null, { status: 204, headers: ctx.headers });
    }
    if (cors.kind === 'normal') {
      for (const [k, v] of cors.headers) ctx.headers.set(k, v);
    }
    return null;
  }

  private async handleImport(ctx: Ctx, token: string): Promise<Response> {
    const early = this.applyMiddleware(ctx);
    if (early) return early;
    const m = /^Bearer (.*)$/i.exec(ctx.request.headers.get('authorization') ?? '');
    if (!m || !(await sameSecret(m[1], token))) return ctx.json(errorBody(401, MSG_UNAUTHORIZED), 401);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBody(ctx.request, MAX_IMPORT_BYTES)));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'import: the body is not valid JSON');
    }
    const before = this.sql.all<{ id: number }>('SELECT id FROM users');
    const result = importGotify(this.sql, payload, () => this.now());
    const after = this.sql.all<{ id: number }>('SELECT id FROM users');
    for (const u of [...before, ...after]) this.hub.closeUser(u.id);
    this.alarmDirty = true; // no other in-memory caches exist: everything is read from SQLite per request
    return ctx.json(JSON.stringify(result));
  }

  /** gin's NoRoute handlers also run the global middleware (also when reached from /image or /health). */
  private noRoute(ctx: Ctx): Response {
    const early = this.applyMiddleware(ctx);
    if (early) return early;
    return ctx.json(errorBody(404, 'page not found'), 404);
  }

  // ---- routing ----

  private route(method: string, path: string, auth: AuthMode, handler: Handler, middleware = true) {
    this.routes.push({ method, segments: path.split('/').slice(1), middleware, auth, handler });
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    // "/a/b/" has an empty last element: a trailing slash is part of the match, as in gin
    const parts = path.split('/').slice(1);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, parts);
      if (params) return { route, params };
    }
    return null;
  }

  /** gin's RedirectTrailingSlash: /application/ -> /application when only that route exists. */
  private trailingSlashRedirect(method: string, path: string, url: URL): Response | null {
    if (path.length > 1 && path.endsWith('/')) {
      const stripped = path.slice(0, -1);
      if (this.match(method, stripped)) {
        const location = stripped + url.search;
        return new Response(null, { status: method === 'GET' ? 301 : 307, headers: { Location: location } });
      }
    } else if (path !== '/') {
      if (this.match(method, path + '/')) {
        return new Response(null, { status: method === 'GET' ? 301 : 307, headers: { Location: path + '/' + url.search } });
      }
    }
    return null;
  }

  private defineRoutes() {
    // Registered before the middleware upstream: no CORS, no forced JSON header.
    this.route('GET', '/health', 'none', (c) => this.health(c), false);
    this.route('HEAD', '/health', 'none', (c) => this.health(c), false);
    this.route('GET', '/image/*', 'none', (c) => this.serveImage(c), false);
    this.route('HEAD', '/image/*', 'none', (c) => this.serveImage(c), false);

    // Plugins are not supported: no plugin is ever installed, so every plugin lookup misses.
    this.route('GET', '/plugin', 'client', async (c) => c.json('[]'));
    for (const [method, action] of [
      ['GET', 'config'],
      ['POST', 'config'],
      ['GET', 'display'],
      ['POST', 'enable'],
      ['POST', 'disable'],
    ] as const) {
      this.route(method, `/plugin/:id/${action}`, 'client', async (c) => {
        parseId(c.params.id);
        throw new HttpError(404, 'unknown plugin');
      });
    }

    this.route('POST', '/user', 'optionalAdmin', (c) => this.createUser(c));
    this.route('POST', '/auth/local/login', 'none', (c) => this.login(c));
    this.route('GET', '/version', 'none', async (c) => c.json(goJSON(this.config.version)));
    this.route('GET', '/gotifyinfo', 'none', async (c) =>
      c.json(
        goJSON({
          version: this.config.version.version,
          register: this.config.registration,
          localAuth: this.config.localAuthEnabled,
          oidc: false,
          oidcIdpName: this.config.oidcIdpName,
          oidcAutoRedirect: false,
        }),
      ),
    );

    this.route('POST', '/message', 'appOrClient', (c) => this.createMessage(c));

    // client authentication
    this.route('GET', '/application', 'client', (c) => this.getApplications(c));
    this.route('POST', '/application', 'client', (c) => this.createApplication(c));
    this.route('POST', '/application/:id/image', 'client', (c) => this.uploadApplicationImage(c));
    this.route('DELETE', '/application/:id/image', 'client', (c) => this.removeApplicationImage(c));
    this.route('PUT', '/application/:id', 'client', (c) => this.updateApplication(c));
    this.route('GET', '/application/:id/message', 'client', (c) => this.getMessagesWithApplication(c));
    this.route('DELETE', '/application/:id/message', 'client', (c) => this.deleteMessagesWithApplication(c));

    this.route('GET', '/client', 'client', (c) => this.getClients(c));
    this.route('POST', '/client', 'client', (c) => this.createClient(c));
    this.route('PUT', '/client/:id', 'client', (c) => this.updateClient(c));

    this.route('GET', '/message', 'client', (c) => this.getMessages(c));
    this.route('DELETE', '/message', 'client', (c) => this.deleteMessages(c));
    this.route('DELETE', '/message/:id', 'client', (c) => this.deleteMessage(c));

    this.route('GET', '/stream', 'client', (c) => this.stream(c));
    this.route('GET', '/current/user', 'client', (c) => this.getCurrentUser(c));
    this.route('POST', '/auth/logout', 'client', (c) => this.logout(c));

    // elevated client authentication
    this.route('POST', '/client/:id/elevate', 'elevated', (c) => this.elevateClient(c));
    this.route('DELETE', '/application/:id', 'elevated', (c) => this.deleteApplication(c));
    this.route('PUT', '/application/:id/security', 'elevated', (c) => this.updateApplicationSecurity(c));
    this.route('DELETE', '/client/:id', 'elevated', (c) => this.deleteClient(c));
    this.route('POST', '/current/user/password', 'elevated', (c) => this.changePassword(c));

    // admin
    this.route('GET', '/user', 'admin', (c) => this.getUsers(c));
    this.route('DELETE', '/user/:id', 'admin', (c) => this.deleteUser(c));
    this.route('GET', '/user/:id', 'admin', (c) => this.getUserById(c));
    this.route('POST', '/user/:id', 'admin', (c) => this.updateUser(c));
  }

  // ---- authentication (auth/authentication.go) ----

  private async authenticate(ctx: Ctx, mode: AuthMode): Promise<void> {
    switch (mode) {
      case 'none':
        return;
      case 'client':
        return this.evaluateOr401(ctx, [() => this.handleUser(ctx), () => this.handleClient(ctx)]);
      case 'elevated':
        return this.evaluateOr401(ctx, [() => this.handleUser(ctx), () => this.handleClient(ctx, [checkClientElevated(this.now())])]);
      case 'admin':
        return this.evaluateOr401(ctx, this.adminHandlers(ctx));
      case 'optionalAdmin':
        await this.evaluate(ctx, this.adminHandlers(ctx));
        return;
      case 'appOrClient':
        return this.evaluateOr401(ctx, [() => this.handleApplication(ctx), () => this.handleClient(ctx), () => this.handleUser(ctx)]);
    }
  }

  private adminHandlers(ctx: Ctx) {
    return [
      () => this.handleUser(ctx, [(u: User): AuthState => (u.admin ? 'ok' : 'forbidden')]),
      () => this.handleClient(ctx, [(c: Client) => this.checkClientAdmin(c), checkClientElevated(this.now())]),
    ];
  }

  private async evaluateOr401(ctx: Ctx, handlers: Array<() => Promise<AuthState>>): Promise<void> {
    if (!(await this.evaluate(ctx, handlers))) throw new HttpError(401, MSG_UNAUTHORIZED);
  }

  /** Returns true when a handler decided the request is authenticated; throws for rejections. */
  private async evaluate(ctx: Ctx, handlers: Array<() => Promise<AuthState>>): Promise<boolean> {
    // rejectForeignOrigin: cookie authentication needs cross-origin protection
    if (this.readToken(ctx).isCookie) {
      const err = crossOriginCheck(ctx.method, ctx.request.headers, ctx.host);
      if (err) throw new HttpError(403, err);
    }
    for (const handler of handlers) {
      let state: AuthState;
      try {
        state = await handler();
      } catch (e) {
        if (e instanceof CannotParseTokenError) throw new HttpError(401, e.message);
        if (e instanceof InvalidTokenError) throw new HttpError(500, e.message);
        throw e;
      }
      switch (state) {
        case 'forbidden':
          throw new HttpError(403, MSG_FORBIDDEN);
        case 'notElevated':
          throw new HttpError(403, MSG_NOT_ELEVATED);
        case 'localAuthDisabled':
          throw new HttpError(403, 'local authentication is disabled');
        case 'ok':
          return true;
        case 'skip':
          continue;
      }
    }
    return false;
  }

  /** readTokenFromRequest: query, X-Gotify-Key, "Authorization: Bearer", then the cookie. */
  private readToken(ctx: Ctx): { token: string; isCookie: boolean } {
    const fromQuery = ctx.url.searchParams.get('token');
    if (fromQuery) return { token: fromQuery, isCookie: false };
    const fromHeader = ctx.request.headers.get('x-gotify-key');
    if (fromHeader) return { token: fromHeader, isCookie: false };
    const authorization = ctx.request.headers.get('authorization');
    if (authorization && authorization.length >= 7 && authorization.slice(0, 7).toLowerCase() === 'bearer ') {
      const token = authorization.slice(7);
      if (token) return { token, isCookie: false };
    }
    const cookie = readCookie(ctx.request, COOKIE_NAME);
    if (cookie) return { token: cookie, isCookie: true };
    return { token: '', isCookie: false };
  }

  private async handleUser(ctx: Ctx, checks: Array<(u: User) => AuthState> = []): Promise<AuthState> {
    const creds = basicAuth(ctx.request);
    if (!creds) return 'skip';
    if (!this.config.localAuthEnabled) return 'localAuthDisabled';
    const user = this.store.getUserByName(creds.name);
    if (user && comparePassword(user.pass, creds.pass)) {
      ctx.auth = { user };
      for (const check of checks) {
        const state = check(user);
        if (state !== 'ok') return state;
      }
      return 'ok';
    }
    return 'skip';
  }

  private async handleClient(ctx: Ctx, checks: Array<(c: Client) => AuthState> = []): Promise<AuthState> {
    const { token: presented, isCookie } = this.readToken(ctx);
    if (!presented) return 'skip';
    const now = this.now();
    const stored = await resolveStoredToken(presented, Math.floor(now / 1000));
    if (stored === null) return 'skip';
    const client = this.store.getClientByToken(stored);
    if (!client) return 'skip';
    ctx.auth = { client };
    if (client.lastUsed === null || client.lastUsed + FIVE_MINUTES_MS < now) {
      this.store.updateClientTokensLastUsedAndExpiresAt([client.token], now);
      if (isCookie) ctx.headers.append('Set-Cookie', sessionCookie(presented, COOKIE_MAX_AGE_SECONDS, this.config.secureCookie));
    }
    for (const check of checks) {
      const state = check(client);
      if (state !== 'ok') return state;
    }
    return 'ok';
  }

  private async handleApplication(ctx: Ctx): Promise<AuthState> {
    const { token: presented, isCookie } = this.readToken(ctx);
    if (!presented) return 'skip';
    const now = this.now();
    const stored = await resolveStoredToken(presented, Math.floor(now / 1000));
    if (stored === null) return 'skip';
    const app = this.store.getApplicationByToken(stored);
    if (!app) return 'skip';
    ctx.auth = { app };
    if (app.lastUsed === null || app.lastUsed + FIVE_MINUTES_MS < now) {
      this.store.updateApplicationTokenLastUsed(app.token, now);
      if (isCookie) ctx.headers.append('Set-Cookie', sessionCookie(presented, COOKIE_MAX_AGE_SECONDS, this.config.secureCookie));
    }
    return 'ok';
  }

  private checkClientAdmin(client: Client): AuthState {
    const user = this.store.getUserById(client.userId);
    if (!user) return 'forbidden';
    return user.admin ? 'ok' : 'forbidden';
  }

  // ---- health, images ----

  private async health(ctx: Ctx): Promise<Response> {
    ctx.headers.set('Content-Type', 'application/json; charset=utf-8');
    try {
      this.store.ping();
    } catch {
      return ctx.json(goJSON({ health: 'orange', database: 'red' }), 500);
    }
    return ctx.json(goJSON({ health: 'green', database: 'green' }));
  }

  /** GET /image/<name>: only the allowed extensions are served, everything else is a plain 404. */
  private async serveImage(ctx: Ctx): Promise<Response | typeof NOT_FOUND> {
    const name = cleanPath(ctx.url.pathname).slice('/image/'.length);
    const ext = fileExt('/' + name).toLowerCase();
    if (!validImageExt(ext)) return NOT_FOUND;
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      return NOT_FOUND;
    }
    const image = this.store.getImage(decoded);
    if (!image) return NOT_FOUND;
    const headers = new Headers({
      'Content-Type': IMAGE_CONTENT_TYPES[ext],
      'Last-Modified': new Date(Math.floor(image.createdAt / 1000) * 1000).toUTCString(),
    });
    const since = ctx.request.headers.get('if-modified-since');
    if (since) {
      const t = Date.parse(since);
      if (!Number.isNaN(t) && Math.floor(image.createdAt / 1000) * 1000 <= t) return new Response(null, { status: 304, headers });
    }
    headers.set('Content-Length', String(image.data.byteLength));
    return new Response(ctx.method === 'HEAD' ? null : (image.data as unknown as BodyInit), { status: 200, headers });
  }

  // ---- stream ----

  private async stream(ctx: Ctx): Promise<Response> {
    const upgrade = ctx.request.headers.get('upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      throw new HttpError(400, "websocket: the client is not using the websocket protocol: 'upgrade' token not found in 'Connection' header");
    }
    if (!this.isAllowedOrigin(ctx)) throw new HttpError(403, 'websocket: request origin not allowed by Upgrader.CheckOrigin');
    const token = ctx.auth.client?.token ?? '';
    this.alarmDirty = true;
    return this.hub.accept(ctx.userId, token);
  }

  /** stream.isAllowedOrigin: same host, or a configured pattern matching the origin's hostname. */
  private isAllowedOrigin(ctx: Ctx): boolean {
    const origin = ctx.request.headers.get('origin');
    if (!origin) return true;
    if (originHost(origin).toLowerCase() === ctx.host.toLowerCase()) return true;
    const hostname = originHostname(origin).toLowerCase();
    return this.streamOrigins.some((re) => re.test(hostname));
  }

  // ---- users ----

  private async getUsers(ctx: Ctx): Promise<Response> {
    const users = this.store.getUsers();
    // upstream marshals a nil slice here
    return ctx.json(users.length === 0 ? 'null' : goJSON(users.map(userJSON)));
  }

  private async getCurrentUser(ctx: Ctx): Promise<Response> {
    const user = this.store.getUserById(ctx.userId);
    if (!user) throw new Error('user of the authenticated client does not exist');
    const client = ctx.auth.client;
    let clientId: number | undefined;
    let elevatedUntil: number | null = null;
    if (client) {
      clientId = client.id;
      if (client.elevatedUntil !== null && this.now() < client.elevatedUntil) elevatedUntil = client.elevatedUntil;
    }
    return ctx.json(goJSON(currentUserJSON(user, clientId, elevatedUntil)));
  }

  private validateNewPassword(pw: string) {
    if (pw === '') throw new HttpError(400, 'password must not be empty');
    if (byteLength(pw) > MAX_PASSWORD_BYTES) throw new HttpError(400, 'bcrypt: password length exceeds 72 bytes');
  }

  private createPassword(pw: string): string {
    try {
      return hashPassword(pw, this.config.passStrength);
    } catch (e) {
      throw new HttpError(500, `failed to prepare password: ${(e as Error).message}`);
    }
  }

  private async createUser(ctx: Ctx): Promise<Response> {
    const p = await ctx.bind(CREATE_USER);
    this.validateNewPassword(p.pass);
    // The auth middleware guarantees authenticated requests to be elevated admins.
    // Only unauthenticated requests are limited to the registration checks.
    const authenticated = ctx.auth.user !== undefined || ctx.auth.client !== undefined || ctx.auth.app !== undefined;
    if (!authenticated) {
      if (!this.config.registration) throw new HttpError(401, MSG_FORBIDDEN);
      if (p.admin) throw new HttpError(401, 'you are not allowed to create an admin user');
    }
    if (this.store.getUserByName(p.name)) throw new HttpError(400, 'username already exists');
    // Upstream hashes before these checks; the responses are the same, but hashing is the
    // expensive step, so anonymous requests that are going to be refused never pay for it.
    // No await between the name check and the insert, so the name stays unique.
    const pass = this.createPassword(p.pass);
    const user = this.store.createUser({ name: p.name, pass, admin: p.admin });
    return ctx.json(goJSON(userJSON(user)));
  }

  private async getUserById(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const user = this.store.getUserById(id);
    if (!user) throw new HttpError(404, 'user does not exist');
    return ctx.json(goJSON(userJSON(user)));
  }

  private async deleteUser(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const user = this.store.getUserById(id);
    if (!user) throw new HttpError(404, 'user does not exist');
    if (user.admin && this.store.countAdmins() === 1) throw new HttpError(400, 'cannot delete last admin');
    this.hub.closeUser(id);
    this.store.deleteUser(id);
    this.alarmDirty = true;
    return ctx.empty();
  }

  private async changePassword(ctx: Ctx): Promise<Response> {
    const p = await ctx.bind(USER_PASS);
    this.validateNewPassword(p.pass);
    const user = this.store.getUserById(ctx.userId);
    if (!user) throw new Error('user of the authenticated client does not exist');
    user.pass = this.createPassword(p.pass);
    this.store.updateUser(user);
    return ctx.empty();
  }

  private async updateUser(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const p = await ctx.bind(UPDATE_USER);
    const dbUser = this.store.getUserById(id);
    if (!dbUser) throw new HttpError(404, 'user does not exist');
    if (!p.admin && dbUser.admin && this.store.countAdmins() === 1) throw new HttpError(400, 'cannot delete last admin');
    dbUser.name = p.name;
    dbUser.admin = p.admin;
    if (p.pass !== '') {
      this.validateNewPassword(p.pass);
      dbUser.pass = this.createPassword(p.pass);
    }
    try {
      this.store.updateUser(dbUser);
    } catch (e) {
      throw new HttpError(500, (e as Error).message);
    }
    return ctx.json(goJSON(userJSON(dbUser)));
  }

  // ---- sessions ----

  private async login(ctx: Ctx): Promise<Response> {
    if (!this.config.localAuthEnabled) throw new HttpError(403, 'local authentication is disabled');
    const creds = basicAuth(ctx.request);
    if (!creds) throw new HttpError(401, 'basic auth required');
    const user = this.store.getUserByName(creds.name);
    if (!user || !comparePassword(user.pass, creds.pass)) throw new HttpError(401, 'invalid credentials');
    const p = await ctx.bind(CLIENT_PARAMS);
    const elevatedUntil = this.now() + DEFAULT_ELEVATION_MS;
    const token = await generateClientToken();
    const client = this.store.createClient({
      token: token.publicForm,
      userId: user.id,
      name: p.name,
      elevatedUntil,
      expiresAfterInactivitySeconds: COOKIE_MAX_AGE_SECONDS,
    });
    this.alarmDirty = true;
    ctx.headers.append('Set-Cookie', sessionCookie(token.privateForm, COOKIE_MAX_AGE_SECONDS, this.config.secureCookie));
    return ctx.json(goJSON(currentUserJSON(user, client.id, client.elevatedUntil)));
  }

  private async logout(ctx: Ctx): Promise<Response> {
    ctx.headers.append('Set-Cookie', sessionCookie('', -1, this.config.secureCookie));
    const client = ctx.auth.client;
    if (!client) throw new HttpError(403, 'no client auth provided');
    this.hub.closeClient(client.userId, client.token);
    this.store.deleteClient(client.id);
    this.alarmDirty = true;
    return ctx.empty();
  }

  // ---- applications ----

  private requireOwnApplication(ctx: Ctx, id: number): Application {
    const app = this.store.getApplicationById(id);
    if (!app || app.userId !== ctx.userId) throw new HttpError(404, `app with id ${id} doesn't exists`);
    return app;
  }

  private async getApplications(ctx: Ctx): Promise<Response> {
    const apps = this.store.getApplicationsByUser(ctx.userId);
    return ctx.json(goJSON(apps.map((a) => applicationJSON(a, undefined))));
  }

  private async createApplication(ctx: Ctx): Promise<Response> {
    const p = await ctx.bind(APPLICATION_PARAMS);
    const token = await generateApplicationToken();
    let app: Application;
    try {
      app = this.store.createApplication({
        token: token.publicForm,
        userId: ctx.userId,
        name: p.name,
        description: p.description,
        internal: false,
        image: '',
        defaultPriority: p.defaultPriority,
        sortKey: p.sortKey,
      });
    } catch (e) {
      throw applicationError(e);
    }
    return ctx.json(goJSON(applicationJSON(app, token.privateForm)));
  }

  private async updateApplication(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    this.requireOwnApplication(ctx, id); // 404 before 400, like upstream
    const p = await ctx.bind(APPLICATION_PARAMS);
    // Read again after the await: other requests may have run meanwhile (a Durable Object only
    // serialises storage access, not whole requests) and the whole row is written back.
    const app = this.requireOwnApplication(ctx, id);
    app.description = p.description;
    app.name = p.name;
    app.defaultPriority = p.defaultPriority;
    if (p.sortKey !== '') app.sortKey = p.sortKey;
    try {
      this.store.updateApplication(app);
    } catch (e) {
      throw applicationError(e);
    }
    return ctx.json(goJSON(applicationJSON(app, app.token)));
  }

  private async updateApplicationSecurity(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    this.requireOwnApplication(ctx, id);
    const action = await ctx.bind(SECURITY_UPDATE_ACTION);
    const response: Record<string, unknown> = {};
    let publicForm: string | undefined;
    if (action.regenerateToken) {
      const token = await generateApplicationToken();
      publicForm = token.publicForm;
      response.regenerateToken = { token: token.privateForm };
    }
    // no await from here on: read, change and write happen without other requests in between
    const app = this.requireOwnApplication(ctx, id);
    if (publicForm !== undefined) app.token = publicForm;
    this.store.updateApplication(app);
    return ctx.json(goJSON(response));
  }

  private async deleteApplication(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const app = this.requireOwnApplication(ctx, id);
    if (app.internal) throw new HttpError(400, 'cannot delete internal application');
    this.store.deleteApplication(id);
    return ctx.empty();
  }

  private async uploadApplicationImage(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    this.requireOwnApplication(ctx, id);

    const contentType = ctx.request.headers.get('content-type') ?? '';
    // Go: FormFile -> ParseMultipartForm; these failures are reported as 500 upstream.
    if (contentType.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') {
      throw new HttpError(500, "request Content-Type isn't multipart/form-data");
    }
    let form: FormData;
    try {
      form = await parseMultipart(await ctx.body(MAX_IMAGE_BYTES + MULTIPART_OVERHEAD), contentType);
    } catch (e) {
      if (e instanceof HttpError) {
        // 400, not 413: the web UI shows the message of a 400 to the user
        const imageLimitApplied = this.config.maxBodyBytes === 0 || this.config.maxBodyBytes > MAX_IMAGE_BYTES + MULTIPART_OVERHEAD;
        if (e.status === 413 && imageLimitApplied) throw new HttpError(400, IMAGE_TOO_LARGE);
        throw e;
      }
      throw new HttpError(500, (e as Error).message);
    }
    const file = form.get('file');
    if (file === null || typeof file === 'string') throw new HttpError(400, "file with key 'file' must be present");

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isImage(bytes.subarray(0, 261))) throw new HttpError(400, 'file must be an image');
    const ext = fileExt(file.name);
    if (!validImageExt(ext)) throw new HttpError(400, 'invalid file extension');
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new HttpError(400, IMAGE_TOO_LARGE);
    }

    // Everything below is synchronous: no other request can change the application in between.
    const current = this.requireOwnApplication(ctx, id);
    let name: string;
    do {
      name = generateImageName() + ext;
    } while (this.store.imageExists(name));
    this.store.putImage(name, bytes);
    if (current.image !== '') this.store.deleteImage(current.image);
    current.image = name;
    this.store.updateApplication(current);
    return ctx.json(goJSON(applicationJSON(current, current.token)));
  }

  private async removeApplicationImage(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const app = this.requireOwnApplication(ctx, id);
    if (app.image === '') throw new HttpError(400, `app with id ${id} does not have a customized image`);
    const image = app.image;
    app.image = '';
    this.store.updateApplication(app);
    this.store.deleteImage(image);
    return ctx.json(goJSON(applicationJSON(app, app.token)));
  }

  // ---- clients ----

  private async getClients(ctx: Ctx): Promise<Response> {
    const now = this.now();
    const clients = this.store.getClientsByUser(ctx.userId);
    return ctx.json(
      goJSON(clients.map((c) => clientJSON(c, undefined, c.elevatedUntil !== null && now < c.elevatedUntil ? c.elevatedUntil : null))),
    );
  }

  private async createClient(ctx: Ctx): Promise<Response> {
    const p = await ctx.bind(CLIENT_PARAMS);
    const token = await generateClientToken();
    const client = this.store.createClient({
      token: token.publicForm,
      userId: ctx.userId,
      name: p.name,
      expiresAfterInactivitySeconds: p.expiresAfterInactivitySeconds ?? 0,
    });
    this.alarmDirty = true;
    return ctx.json(goJSON(clientJSON(client, token.privateForm)));
  }

  private async updateClient(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const exists = this.store.getClientById(id);
    if (!exists || exists.userId !== ctx.userId) throw new HttpError(404, `client with id ${id} doesn't exists`);
    const p = await ctx.bind(CLIENT_PARAMS);
    // read again after the await, see updateApplication
    const client = this.store.getClientById(id);
    if (!client || client.userId !== ctx.userId) throw new HttpError(404, `client with id ${id} doesn't exists`);
    client.name = p.name;
    if (p.expiresAfterInactivitySeconds !== null) client.expiresAfterInactivitySeconds = p.expiresAfterInactivitySeconds;
    this.store.updateClient(client);
    this.alarmDirty = true;
    return ctx.json(goJSON(clientJSON(client, client.token)));
  }

  private async deleteClient(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const client = this.store.getClientById(id);
    if (!client || client.userId !== ctx.userId) throw new HttpError(404, `client with id ${id} doesn't exists`);
    this.hub.closeClient(client.userId, client.token);
    this.store.deleteClient(id);
    this.alarmDirty = true;
    return ctx.empty();
  }

  private async elevateClient(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const p = await ctx.bind(ELEVATE_REQUEST);
    const client = this.store.getClientById(id);
    if (!client || client.userId !== ctx.userId) throw new HttpError(404, 'client not found');
    this.store.updateClientElevatedUntil(client.id, this.now() + p.durationSeconds * 1000);
    return ctx.empty(204);
  }

  // ---- messages ----

  private pagedMessages(ctx: Ctx, limit: number, messages: Message[]): string {
    let next = '';
    let since = 0;
    let used = messages;
    if (messages.length > limit) {
      used = messages.slice(0, messages.length - 1);
      since = used[used.length - 1].id;
      // url.Values.Encode sorts by key
      next = `${ctx.url.pathname}?limit=${limit}&since=${since}`;
    }
    const paging = (next ? `"next":${goJSON(next)},` : '') + `"size":${used.length},"since":${since},"limit":${limit}`;
    return `{"paging":{${paging}},"messages":[${used.map(messageJSON).join(',')}]}`;
  }

  private paging(ctx: Ctx): { limit: number; since: number } {
    const p = bindQuery(ctx.url, PAGING_PARAMS, { limit: 100, since: 0 });
    return { limit: p.limit, since: p.since };
  }

  private async getMessages(ctx: Ctx): Promise<Response> {
    const userId = ctx.userId;
    const { limit, since } = this.paging(ctx);
    // one more than requested, to find out whether there is a next page
    const messages = this.store.getMessagesByUserSince(userId, limit + 1, since);
    return ctx.json(this.pagedMessages(ctx, limit, messages));
  }

  private async getMessagesWithApplication(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const { limit, since } = this.paging(ctx);
    const app = this.store.getApplicationById(id);
    if (!app || app.userId !== ctx.userId) throw new HttpError(404, 'application does not exist');
    const messages = this.store.getMessagesByApplicationSince(id, limit + 1, since);
    return ctx.json(this.pagedMessages(ctx, limit, messages));
  }

  private async deleteMessages(ctx: Ctx): Promise<Response> {
    this.store.deleteMessagesByUser(ctx.userId);
    return ctx.empty();
  }

  private async deleteMessagesWithApplication(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const app = this.store.getApplicationById(id);
    if (!app || app.userId !== ctx.userId) throw new HttpError(404, 'application does not exists');
    this.store.deleteMessagesByApplication(id);
    return ctx.empty();
  }

  private async deleteMessage(ctx: Ctx): Promise<Response> {
    const id = parseId(ctx.params.id);
    const msg = this.store.getMessageById(id);
    if (!msg) throw new HttpError(404, 'message does not exist');
    const app = this.store.getApplicationById(msg.applicationId);
    if (!app || app.userId !== ctx.userId) throw new HttpError(404, 'message does not exist');
    this.store.deleteMessage(id);
    return ctx.empty();
  }

  private async createMessage(ctx: Ctx): Promise<Response> {
    const p = await ctx.bind(CREATE_MESSAGE);

    let app = ctx.auth.app;
    if (!app) {
      if (p.appid === 0) throw new HttpError(400, 'appid is required when not authenticating with an application token');
      const fetched = this.store.getApplicationById(p.appid);
      if (!fetched || fetched.userId !== ctx.userId) throw new HttpError(400, 'appid not found');
      app = fetched;
    }

    const extras: Record<string, unknown> | null = p.extras;
    const created = this.store.createMessage({
      applicationId: app.id,
      message: p.message,
      title: p.title.trim() === '' ? app.name : p.title,
      priority: p.priority ?? app.defaultPriority,
      extras: extras === null || Object.keys(extras).length === 0 ? null : canonicalJSON(extras),
      date: this.now(),
    });
    this.hub.broadcast(ctx.userId, messageJSON(created));
    return ctx.json(messageJSON(created));
  }
}

function applicationError(e: unknown): Error {
  if (e instanceof DuplicateSortKeyError) return new HttpError(400, 'sort key is not unique');
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}

function checkClientElevated(now: number) {
  return (client: Client): AuthState => (client.elevatedUntil === null || !(now < client.elevatedUntil) ? 'notElevated' : 'ok');
}

function withParams(ctx: Ctx, params: Record<string, string>): Ctx {
  ctx.params = params;
  return ctx;
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    if (seg === '*') {
      // catch-all: "/image/" matches with an empty remainder, "/image" does not
      return i <= parts.length - 1 ? params : null;
    }
    if (i >= parts.length) return null;
    if (seg.startsWith(':')) {
      if (parts[i] === '') return null;
      params[seg.slice(1)] = parts[i];
    } else if (seg !== parts[i]) return null;
  }
  return pattern.length === parts.length ? params : null;
}
