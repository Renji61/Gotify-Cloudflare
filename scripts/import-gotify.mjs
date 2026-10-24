// One-time import of an upstream Gotify database into the deployed Worker (POST /_import).
// Usage: GOTIFY_IMPORT_TOKEN=... node scripts/import-gotify.mjs <path/to/gotify.db> <base-url> --yes
// Replaces ALL data on the target; without --yes it only prints what would be sent. Needs Node 22.13+ (node:sqlite).
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const [dbPath, baseUrl] = args.filter((a) => a !== '--yes');
const token = process.env.GOTIFY_IMPORT_TOKEN;
if (!dbPath || !baseUrl || !token) {
  console.error('usage: GOTIFY_IMPORT_TOKEN=... node scripts/import-gotify.mjs <path/to/gotify.db> <base-url> --yes');
  process.exit(1);
}

// The bearer token would travel in clear over plain http (loopback excepted, for local testing).
let target;
try {
  target = new URL('/_import', baseUrl);
} catch {
  console.error(`invalid base url: ${baseUrl}`);
  process.exit(1);
}
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
  console.error('refusing a non-https target: the import token would be sent in clear (http is allowed only for localhost, 127.0.0.1 and [::1])');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));

const withImage = all(`SELECT id FROM applications WHERE image IS NOT NULL AND image != ''`);
if (withImage.length > 0) {
  console.error(`refusing to import: ${withImage.length} application(s) have an image (ids ${withImage.map((a) => a.id).join(', ')}); images are not imported`);
  process.exit(1);
}
let plugins = 0;
try {
  plugins = all('SELECT id FROM plugin_confs').length;
} catch {
  // no plugin_confs table: nothing to lose
}
if (plugins > 0) {
  console.error(`refusing to import: plugin_confs has ${plugins} row(s); plugins are not supported`);
  process.exit(1);
}

const sequences = { users: 0, applications: 0, clients: 0, messages: 0 };
for (const r of all('SELECT name, seq FROM sqlite_sequence')) if (r.name in sequences) sequences[r.name] = r.seq;

const payload = {
  users: all('SELECT id, name, CAST(pass AS TEXT) AS pass, admin, created_at, oidc_id FROM users'),
  applications: all(
    `SELECT id, token, user_id, name, description, internal, image, default_priority, last_used,
            CAST(sort_key AS TEXT) AS sort_key, created_at FROM applications`,
  ),
  clients: all('SELECT id, token, user_id, name, last_used, created_at, elevated_until, expires_after_inactivity_seconds, expires_at FROM clients'),
  messages: all('SELECT id, application_id, message, title, priority, CAST(extras AS TEXT) AS extras, date FROM messages'),
  sequences,
};

console.log(
  `target ${target.origin}: ALL existing data there will be REPLACED by ${payload.users.length} users, ` +
    `${payload.applications.length} applications, ${payload.clients.length} clients, ${payload.messages.length} messages`,
);
if (!yes) {
  console.error('nothing sent: pass --yes to go ahead');
  process.exit(1);
}

const res = await fetch(target, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log(res.status, text);
process.exit(res.ok ? 0 : 1);
