// Small storage interface so the server logic can run inside a Durable Object
// (SQLite-backed storage) in production and against Node's built-in SQLite in
// the test suite.

export type SqlValue = string | number | null | ArrayBuffer;
export type Row = Record<string, SqlValue>;

export interface Sql {
  /** Run a statement and return every result row. */
  all<T extends Row = Row>(query: string, ...bindings: unknown[]): T[];
  /** Run a statement and return the first row, or null. */
  first<T extends Row = Row>(query: string, ...bindings: unknown[]): T | null;
  /** Run a statement that returns nothing. */
  run(query: string, ...bindings: unknown[]): void;
  /** Run `fn` atomically. Calls must not be nested. */
  transaction<T>(fn: () => T): T;
}

// Timestamps are stored as integer milliseconds since the Unix epoch.
// Booleans are stored as 0/1.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  internal INTEGER NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT '',
  default_priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  sort_key TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uix_application_user_id_sort_key ON applications (user_id, sort_key);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  elevated_until INTEGER,
  expires_after_inactivity_seconds INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients (user_id);
CREATE INDEX IF NOT EXISTS idx_clients_expires_at ON clients (expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  extras TEXT,
  date INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_application_id ON messages (application_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_images (
  name TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export const SCHEMA_VERSION = '1';

export function migrate(sql: Sql) {
  for (const statement of SCHEMA.split(';')) {
    if (statement.trim()) sql.run(statement);
  }
  // recorded after the statements ran (they are idempotent), so schemaIsCurrent() can skip them next time
  sql.run(`INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SCHEMA_VERSION);
}
