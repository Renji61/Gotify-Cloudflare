// Data access: the equivalent of upstream's database/*.go, on top of the Sql
// interface. Everything here is synchronous (Durable Object SQLite is), which
// keeps check-then-write sequences atomic.

import { keyBetween } from './fracdex.ts';
import type { Sql } from './storage.ts';

export interface User {
  id: number;
  name: string;
  pass: string;
  admin: boolean;
  createdAt: number;
}

export interface Application {
  id: number;
  /** Public form of the token (what the database stores). */
  token: string;
  userId: number;
  name: string;
  description: string;
  internal: boolean;
  image: string;
  defaultPriority: number;
  createdAt: number;
  lastUsed: number | null;
  sortKey: string;
}

export interface Client {
  id: number;
  token: string;
  userId: number;
  name: string;
  createdAt: number;
  lastUsed: number | null;
  elevatedUntil: number | null;
  expiresAfterInactivitySeconds: number;
  expiresAt: number | null;
}

export interface Message {
  id: number;
  applicationId: number;
  message: string;
  title: string;
  priority: number;
  /** Canonical JSON text of the extras object, or null. */
  extras: string | null;
  date: number;
}

export class DuplicateSortKeyError extends Error {
  constructor() {
    super('sort key is not unique');
  }
}

type R = Record<string, any>;

function toUser(r: R): User {
  return { id: r.id, name: r.name, pass: r.pass, admin: !!r.admin, createdAt: r.created_at };
}

function toApp(r: R): Application {
  return {
    id: r.id,
    token: r.token,
    userId: r.user_id,
    name: r.name,
    description: r.description,
    internal: !!r.internal,
    image: r.image,
    defaultPriority: r.default_priority,
    createdAt: r.created_at,
    lastUsed: r.last_used,
    sortKey: r.sort_key,
  };
}

function toClient(r: R): Client {
  return {
    id: r.id,
    token: r.token,
    userId: r.user_id,
    name: r.name,
    createdAt: r.created_at,
    lastUsed: r.last_used,
    elevatedUntil: r.elevated_until,
    expiresAfterInactivitySeconds: r.expires_after_inactivity_seconds,
    expiresAt: r.expires_at,
  };
}

function toMessage(r: R): Message {
  return {
    id: r.id,
    applicationId: r.application_id,
    message: r.message,
    title: r.title,
    priority: r.priority,
    extras: r.extras,
    date: r.date,
  };
}

/** Client.PopulateExpiresAt: reference is the last use, or the creation time. */
export function calculateExpiresAt(c: Pick<Client, 'expiresAfterInactivitySeconds' | 'createdAt' | 'lastUsed'>): number | null {
  if (c.expiresAfterInactivitySeconds === 0) return null;
  const reference = c.lastUsed ?? c.createdAt;
  return clampTime(reference + c.expiresAfterInactivitySeconds * 1000);
}

/** The range of a JavaScript Date; stored times are kept inside it so they can always be formatted. */
export const MAX_TIME_MS = 8.64e15;

export function clampTime(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_TIME_MS, Math.max(-MAX_TIME_MS, ms));
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

export class Store {
  constructor(
    private sql: Sql,
    private now: () => number,
  ) {}

  ping(): void {
    this.sql.first('SELECT 1 AS ok');
  }

  // ---- users ----

  getUserByName(name: string): User | null {
    const r = this.sql.first('SELECT * FROM users WHERE name = ?', name);
    return r ? toUser(r) : null;
  }

  getUserById(id: number): User | null {
    const r = this.sql.first('SELECT * FROM users WHERE id = ?', id);
    return r ? toUser(r) : null;
  }

  getUsers(): User[] {
    return this.sql.all('SELECT * FROM users ORDER BY id').map(toUser);
  }

  countUsers(): number {
    return Number(this.sql.first('SELECT COUNT(*) AS n FROM users')!.n);
  }

  countAdmins(): number {
    return Number(this.sql.first('SELECT COUNT(*) AS n FROM users WHERE admin = 1')!.n);
  }

  createUser(user: { name: string; pass: string; admin: boolean }): User {
    const createdAt = this.now();
    const r = this.sql.first(
      'INSERT INTO users (name, pass, admin, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      user.name,
      user.pass,
      user.admin ? 1 : 0,
      createdAt,
    )!;
    return { id: Number(r.id), name: user.name, pass: user.pass, admin: user.admin, createdAt };
  }

  updateUser(user: User): void {
    this.sql.run('UPDATE users SET name = ?, pass = ?, admin = ? WHERE id = ?', user.name, user.pass, user.admin ? 1 : 0, user.id);
  }

  /** Deletes the user with their applications (and messages, images) and clients. */
  deleteUser(id: number): void {
    this.sql.transaction(() => {
      for (const app of this.getApplicationsByUser(id)) this.deleteApplication(app.id);
      this.sql.run('DELETE FROM clients WHERE user_id = ?', id);
      this.sql.run('DELETE FROM users WHERE id = ?', id);
    });
  }

  // ---- applications ----

  getApplicationByToken(token: string): Application | null {
    const r = this.sql.first('SELECT * FROM applications WHERE token = ?', token);
    return r ? toApp(r) : null;
  }

  getApplicationById(id: number): Application | null {
    const r = this.sql.first('SELECT * FROM applications WHERE id = ?', id);
    return r ? toApp(r) : null;
  }

  getApplicationsByUser(userId: number): Application[] {
    return this.sql.all('SELECT * FROM applications WHERE user_id = ? ORDER BY sort_key, id ASC', userId).map(toApp);
  }

  /** Creates an application; an empty sortKey is replaced by a key after the user's last one. */
  createApplication(app: Omit<Application, 'id' | 'createdAt' | 'lastUsed'>): Application {
    return this.sql.transaction(() => {
      let sortKey = app.sortKey;
      if (sortKey === '') {
        const last = this.sql.first(
          'SELECT sort_key FROM applications WHERE user_id = ? ORDER BY sort_key DESC LIMIT 1',
          app.userId,
        );
        sortKey = keyBetween((last?.sort_key as string | undefined) ?? '', '');
      }
      const createdAt = this.now();
      try {
        const r = this.sql.first(
          `INSERT INTO applications
             (token, user_id, name, description, internal, image, default_priority, created_at, last_used, sort_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) RETURNING id`,
          app.token,
          app.userId,
          app.name,
          app.description,
          app.internal ? 1 : 0,
          app.image,
          app.defaultPriority,
          createdAt,
          sortKey,
        )!;
        return { ...app, sortKey, id: Number(r.id), createdAt, lastUsed: null };
      } catch (e) {
        if (isUnique(e) && /sort_key/.test((e as Error).message)) throw new DuplicateSortKeyError();
        throw e;
      }
    });
  }

  updateApplication(app: Application): void {
    try {
      this.sql.run(
        `UPDATE applications SET token = ?, user_id = ?, name = ?, description = ?, internal = ?, image = ?,
           default_priority = ?, last_used = ?, sort_key = ? WHERE id = ?`,
        app.token,
        app.userId,
        app.name,
        app.description,
        app.internal ? 1 : 0,
        app.image,
        app.defaultPriority,
        app.lastUsed,
        app.sortKey,
        app.id,
      );
    } catch (e) {
      if (isUnique(e) && /sort_key/.test((e as Error).message)) throw new DuplicateSortKeyError();
      throw e;
    }
  }

  updateApplicationTokenLastUsed(token: string, t: number): void {
    this.sql.run('UPDATE applications SET last_used = ? WHERE token = ?', t, token);
  }

  /** Deletes an application together with its messages and its image. */
  deleteApplication(id: number): void {
    const app = this.getApplicationById(id);
    this.sql.run('DELETE FROM messages WHERE application_id = ?', id);
    this.sql.run('DELETE FROM applications WHERE id = ?', id);
    if (app && app.image) this.deleteImage(app.image);
  }

  // ---- clients ----

  getClientByToken(token: string): Client | null {
    const r = this.sql.first('SELECT * FROM clients WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)', token, this.now());
    return r ? toClient(r) : null;
  }

  getClientById(id: number): Client | null {
    const r = this.sql.first('SELECT * FROM clients WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)', id, this.now());
    return r ? toClient(r) : null;
  }

  getClientsByUser(userId: number): Client[] {
    return this.sql
      .all('SELECT * FROM clients WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id', userId, this.now())
      .map(toClient);
  }

  createClient(client: {
    token: string;
    userId: number;
    name: string;
    elevatedUntil?: number | null;
    expiresAfterInactivitySeconds?: number;
  }): Client {
    const createdAt = this.now();
    const full: Omit<Client, 'id'> = {
      token: client.token,
      userId: client.userId,
      name: client.name,
      createdAt,
      lastUsed: null,
      elevatedUntil: client.elevatedUntil ?? null,
      expiresAfterInactivitySeconds: client.expiresAfterInactivitySeconds ?? 0,
      expiresAt: null,
    };
    full.expiresAt = calculateExpiresAt(full);
    const r = this.sql.first(
      `INSERT INTO clients (token, user_id, name, created_at, last_used, elevated_until, expires_after_inactivity_seconds, expires_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?) RETURNING id`,
      full.token,
      full.userId,
      full.name,
      full.createdAt,
      full.elevatedUntil,
      full.expiresAfterInactivitySeconds,
      full.expiresAt,
    )!;
    return { ...full, id: Number(r.id) };
  }

  /** Saves name and inactivity setting; expiresAt is recomputed. */
  updateClient(client: Client): void {
    client.expiresAt = calculateExpiresAt(client);
    this.sql.run(
      `UPDATE clients SET name = ?, expires_after_inactivity_seconds = ?, expires_at = ?, last_used = ?, elevated_until = ? WHERE id = ?`,
      client.name,
      client.expiresAfterInactivitySeconds,
      client.expiresAt,
      client.lastUsed,
      client.elevatedUntil,
      client.id,
    );
  }

  deleteClient(id: number): void {
    this.sql.run('DELETE FROM clients WHERE id = ?', id);
  }

  updateClientElevatedUntil(id: number, t: number): void {
    this.sql.run('UPDATE clients SET elevated_until = ? WHERE id = ?', clampTime(t), id);
  }

  /** Sets last_used and keeps expires_at in sync (UpdateClientTokensLastUsedAndExpiresAt). */
  updateClientTokensLastUsedAndExpiresAt(tokens: string[], t: number): void {
    if (tokens.length === 0) return;
    this.sql.transaction(() => {
      for (const token of tokens) {
        const r = this.sql.first('SELECT * FROM clients WHERE token = ?', token);
        if (!r) continue;
        const c = toClient(r);
        c.lastUsed = t;
        this.sql.run('UPDATE clients SET last_used = ?, expires_at = ? WHERE id = ?', t, calculateExpiresAt(c), c.id);
      }
    });
  }

  /** Deletes clients whose expires_at has passed and returns them. */
  cleanupExpiredClients(now: number): Client[] {
    return this.sql.transaction(() => {
      const expired = this.sql.all('SELECT * FROM clients WHERE expires_at IS NOT NULL AND expires_at <= ?', now).map(toClient);
      for (const c of expired) this.sql.run('DELETE FROM clients WHERE id = ?', c.id);
      return expired;
    });
  }

  /** The earliest expires_at of any client, or null. */
  earliestClientExpiry(): number | null {
    const r = this.sql.first('SELECT MIN(expires_at) AS e FROM clients WHERE expires_at IS NOT NULL');
    return r && r.e !== null ? Number(r.e) : null;
  }

  // ---- messages ----

  createMessage(m: Omit<Message, 'id'>): Message {
    const r = this.sql.first(
      'INSERT INTO messages (application_id, message, title, priority, extras, date) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      m.applicationId,
      m.message,
      m.title,
      m.priority,
      m.extras,
      m.date,
    )!;
    return { ...m, id: Number(r.id) };
  }

  getMessageById(id: number): Message | null {
    const r = this.sql.first('SELECT * FROM messages WHERE id = ?', id);
    return r ? toMessage(r) : null;
  }

  /** Newest first. `since` (exclusive upper bound on the id) is ignored when 0. */
  getMessagesByUserSince(userId: number, limit: number, since: number): Message[] {
    const sinceClause = since !== 0 ? 'AND m.id < ?' : '';
    const args: unknown[] = [userId];
    if (since !== 0) args.push(since);
    args.push(limit);
    return this.sql
      .all(
        `SELECT m.* FROM messages m JOIN applications a ON a.id = m.application_id
         WHERE a.user_id = ? ${sinceClause} ORDER BY m.id DESC LIMIT ?`,
        ...args,
      )
      .map(toMessage);
  }

  getMessagesByApplicationSince(appId: number, limit: number, since: number): Message[] {
    const sinceClause = since !== 0 ? 'AND id < ?' : '';
    const args: unknown[] = [appId];
    if (since !== 0) args.push(since);
    args.push(limit);
    return this.sql
      .all(`SELECT * FROM messages WHERE application_id = ? ${sinceClause} ORDER BY id DESC LIMIT ?`, ...args)
      .map(toMessage);
  }

  deleteMessage(id: number): void {
    this.sql.run('DELETE FROM messages WHERE id = ?', id);
  }

  deleteMessagesByApplication(appId: number): void {
    this.sql.run('DELETE FROM messages WHERE application_id = ?', appId);
  }

  deleteMessagesByUser(userId: number): void {
    this.sql.run('DELETE FROM messages WHERE application_id IN (SELECT id FROM applications WHERE user_id = ?)', userId);
  }

  // ---- application images ----

  putImage(name: string, data: Uint8Array): void {
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.sql.run('INSERT INTO application_images (name, data, created_at) VALUES (?, ?, ?)', name, copy, this.now());
  }

  getImage(name: string): { data: Uint8Array; createdAt: number } | null {
    const r = this.sql.first('SELECT data, created_at FROM application_images WHERE name = ?', name);
    if (!r) return null;
    const d = r.data as unknown;
    const data = d instanceof ArrayBuffer ? new Uint8Array(d) : d instanceof Uint8Array ? d : new Uint8Array(0);
    return { data, createdAt: Number(r.created_at) };
  }

  imageExists(name: string): boolean {
    return this.sql.first('SELECT 1 AS x FROM application_images WHERE name = ?', name) !== null;
  }

  deleteImage(name: string): void {
    this.sql.run('DELETE FROM application_images WHERE name = ?', name);
  }
}
