// One-time import of an existing upstream Gotify (3.1.1) SQLite database.
//
// DELIBERATE DIVERGENCE from upstream (also in server.ts, wrangler.jsonc and the README):
// the optional secret GOTIFY_IMPORT_TOKEN enables `POST /_import`. When the secret is unset the
// route does not exist. The body is the raw upstream rows (upstream column names, see
// scripts/import-gotify.mjs); this module converts them (datetimes to integer ms, NULLs to the
// defaults of this schema) and replaces ALL data in one transaction, keeping ids, tokens, the
// bcrypt hashes and the AUTOINCREMENT counters. Application images are not imported.

import { hashCost } from './bcrypt.ts';
import { keyBetween } from './fracdex.ts';
import { canonicalJSON, HttpError } from './http.ts';
import type { Sql } from './storage.ts';

// DELIBERATE DIVERGENCE: lowered from 64 MiB; a 128 MB isolate holds the chunks, the joined copy, the decoded
// string and the parsed objects at once.
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

export interface ImportResult {
  users: number;
  applications: number;
  clients: number;
  messages: number;
}

type Raw = Record<string, unknown>;

const bad = (msg: string) => new HttpError(400, `import: ${msg}`);

const DATETIME = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/;

/** Upstream datetime text (`2026-10-23 15:42:58.036749354+05:30`, `Z`, `T`, no fraction) to ms since the epoch. */
export function parseDateTime(value: unknown, what: string): number {
  const m = typeof value === 'string' ? DATETIME.exec(value) : null;
  if (!m) throw bad(`${what}: invalid datetime`);
  const d = new Date(0);
  d.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // Date.UTC would map years 0-99 to 19xx
  d.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]), Number((m[7] ?? '').slice(0, 3).padEnd(3, '0')));
  let offset = 0;
  if (m[8] && m[8] !== 'Z') {
    const digits = m[8].slice(1).replace(':', '');
    offset = (m[8][0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * 60000;
  }
  const ms = d.getTime() - offset;
  if (!Number.isFinite(ms)) throw bad(`${what}: invalid datetime`);
  return ms;
}

function rows(payload: Raw, key: string): Raw[] {
  const list = payload[key];
  if (!Array.isArray(list)) throw bad(`"${key}" must be an array`);
  for (const r of list) if (r === null || typeof r !== 'object' || Array.isArray(r)) throw bad(`"${key}" must contain objects`);
  return list as Raw[];
}

function int(r: Raw, col: string, what: string, fallback?: number): number {
  const v = r[col];
  if (v === null || v === undefined) {
    if (fallback !== undefined) return fallback;
  } else if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  throw bad(`${what}: ${col} must be an integer`);
}

function str(r: Raw, col: string, what: string, nullAs?: string): string {
  const v = r[col];
  if (v === null || v === undefined) {
    if (nullAs !== undefined) return nullAs;
  } else if (typeof v === 'string') return v;
  throw bad(`${what}: ${col} must be a string`);
}

function nonEmpty(r: Raw, col: string, what: string): string {
  const v = str(r, col, what);
  if (v === '') throw bad(`${what}: ${col} is empty`);
  return v;
}

function time(r: Raw, col: string, what: string, now: number | null): number | null {
  const v = r[col];
  if (v === null || v === undefined || v === '') return now;
  return parseDateTime(v, `${what}: ${col}`);
}

function extras(r: Raw, what: string): string | null {
  const v = r.extras;
  if (v === null || v === undefined || v === '') return null;
  let parsed: unknown;
  try {
    parsed = typeof v === 'string' ? JSON.parse(v) : v;
  } catch {
    throw bad(`${what}: extras is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad(`${what}: extras must be a JSON object`);
  return Object.keys(parsed).length === 0 ? null : canonicalJSON(parsed);
}

/** Replaces all data with the upstream rows in `payload`. Throws HttpError(400) and writes nothing when the payload is bad. */
export function importGotify(sql: Sql, payload: unknown, now: () => number): ImportResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw bad('the body must be a JSON object');
  const p = payload as Raw;
  const users = rows(p, 'users');
  const apps = rows(p, 'applications');
  const clients = rows(p, 'clients');
  const messages = rows(p, 'messages');
  const seqRaw = p.sequences;
  if (seqRaw === null || typeof seqRaw !== 'object') throw bad('"sequences" must be an object');
  const seq = (t: string) => int(seqRaw as Raw, t, `sequences`, 0);
  const t0 = now();

  // Convert and validate everything first.
  const userIds = new Set<number>();
  const userRows = users.map((r) => {
    const id = int(r, 'id', 'user');
    const what = `user ${id}`;
    const pass = str(r, 'pass', what);
    if (hashCost(pass) === null) throw bad(`${what}: pass is not a bcrypt hash`);
    userIds.add(id);
    return [id, nonEmpty(r, 'name', what), pass, int(r, 'admin', what, 0) ? 1 : 0, time(r, 'created_at', what, t0)];
  });

  // DELIBERATE DIVERGENCE: without an admin nobody could manage the instance after the replace.
  if (!userRows.some((u) => u[3] === 1)) throw bad('at least one user must be an admin');

  const appIds = new Set<number>();
  const appRows = apps.map((r) => {
    const id = int(r, 'id', 'application');
    const what = `application ${id}`;
    if (str(r, 'image', what, '') !== '') throw bad(`${what} has an image; images are not imported`);
    const userId = int(r, 'user_id', what);
    if (!userIds.has(userId)) throw bad(`${what}: unknown user ${userId}`);
    appIds.add(id);
    return {
      userId,
      sortKey: str(r, 'sort_key', what, ''),
      values: [
        id, nonEmpty(r, 'token', what), userId, str(r, 'name', what), str(r, 'description', what, ''),
        int(r, 'internal', what, 0) ? 1 : 0, '', int(r, 'default_priority', what, 0), time(r, 'created_at', what, t0),
        time(r, 'last_used', what, null),
      ] as unknown[],
    };
  });

  const clientRows = clients.map((r) => {
    const id = int(r, 'id', 'client');
    const what = `client ${id}`;
    const userId = int(r, 'user_id', what);
    if (!userIds.has(userId)) throw bad(`${what}: unknown user ${userId}`);
    return [
      id, nonEmpty(r, 'token', what), userId, str(r, 'name', what), time(r, 'created_at', what, t0), time(r, 'last_used', what, null),
      time(r, 'elevated_until', what, null), int(r, 'expires_after_inactivity_seconds', what, 0), time(r, 'expires_at', what, null),
    ];
  });

  const messageRows = messages.map((r) => {
    const id = int(r, 'id', 'message');
    const what = `message ${id}`;
    const appId = int(r, 'application_id', what);
    if (!appIds.has(appId)) throw bad(`${what}: unknown application ${appId}`);
    return [id, appId, str(r, 'message', what, ''), str(r, 'title', what, ''), int(r, 'priority', what, 0), extras(r, what), time(r, 'date', what, t0)];
  });

  const sequences = { users: seq('users'), applications: seq('applications'), clients: seq('clients'), messages: seq('messages') };

  try {
    sql.transaction(() => {
      for (const t of ['messages', 'clients', 'applications', 'application_images', 'users']) sql.run(`DELETE FROM ${t}`);
      for (const v of userRows) sql.run('INSERT INTO users (id, name, pass, admin, created_at) VALUES (?, ?, ?, ?, ?)', ...v);
      const insertApp = (v: unknown[]) =>
        sql.run(
          `INSERT INTO applications (id, token, user_id, name, description, internal, image, default_priority, created_at, last_used, sort_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ...v,
        );
      // apps without a sort key go last, each after the last key of its user
      for (const a of appRows) if (a.sortKey !== '') insertApp([...a.values, a.sortKey]);
      for (const a of appRows) {
        if (a.sortKey !== '') continue;
        const last = sql.first<{ sort_key: string }>('SELECT sort_key FROM applications WHERE user_id = ? ORDER BY sort_key DESC LIMIT 1', a.userId);
        insertApp([...a.values, keyBetween(last?.sort_key ?? '', '')]);
      }
      for (const v of clientRows) {
        sql.run(
          `INSERT INTO clients (id, token, user_id, name, created_at, last_used, elevated_until, expires_after_inactivity_seconds, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ...v,
        );
      }
      for (const v of messageRows) {
        sql.run('INSERT INTO messages (id, application_id, message, title, priority, extras, date) VALUES (?, ?, ?, ?, ?, ?, ?)', ...v);
      }
      // Raise the AUTOINCREMENT counters (new ids must not reuse ids upstream handed out) by inserting and
      // deleting a row with the id; sqlite_sequence itself is not written.
      const bump = (table: string, imported: Raw[], target: number, insert: string) => {
        const max = imported.reduce((m, r) => Math.max(m, r.id as number), 0);
        if (target <= max) return;
        sql.run(insert, target);
        sql.run(`DELETE FROM ${table} WHERE id = ?`, target);
      };
      bump('users', users, sequences.users, `INSERT INTO users (id, name, pass, created_at) VALUES (?, '', '', 0)`);
      bump('applications', apps, sequences.applications, `INSERT INTO applications (id, token, user_id, name, created_at) VALUES (?, '', 0, '', 0)`);
      bump('clients', clients, sequences.clients, `INSERT INTO clients (id, token, user_id, name, created_at) VALUES (?, '', 0, '', 0)`);
      bump('messages', messages, sequences.messages, `INSERT INTO messages (id, application_id, message, date) VALUES (?, 0, '', 0)`);
    });
  } catch (e) {
    // a constraint violation (duplicate name, token or sort key): the transaction was rolled back
    throw bad(e instanceof Error ? e.message : String(e));
  }
  return { users: users.length, applications: apps.length, clients: clients.length, messages: messages.length };
}
