// Server configuration. Values come from Worker vars/secrets using the same
// names and formats as upstream's environment variables (config/config.go and
// config/parse.go), with the same defaults, except where noted.

import { VERSION_INFO, type VersionInfo } from './version.ts';

export interface GotifyConfig {
  /** GOTIFY_REGISTRATION: allow anyone to create (non-admin) users. Default false. */
  registration: boolean;
  /** Always true here: there is no OIDC, so password login can not be disabled. */
  localAuthEnabled: boolean;
  /** GOTIFY_PASSSTRENGTH: bcrypt cost for new passwords. Default 10. */
  passStrength: number;
  /** GOTIFY_SERVER_SECURECOOKIE. Upstream defaults to false, this port to true (Workers are always served over HTTPS). */
  secureCookie: boolean;
  /** GOTIFY_SERVER_STREAM_ALLOWEDORIGINS: regexes matched against the lower-cased hostname of a WebSocket Origin. */
  streamAllowedOrigins: string[];
  /** GOTIFY_SERVER_CORS_ALLOWORIGINS: regexes. */
  corsAllowOrigins: string[];
  corsAllowMethods: string[];
  corsAllowHeaders: string[];
  /** GOTIFY_SERVER_RESPONSEHEADERS: JSON object of extra response headers. */
  responseHeaders: Record<string, string>;
  /** GOTIFY_SERVER_MAXBODYBYTES. Default 2 MiB (upstream has no cap). 0 disables the limit. Image uploads have their own 1.5 MiB cap. */
  maxBodyBytes: number;
  /** Defaults to what upstream calls oidcIdpName; reported by /gotifyinfo and the UI config. */
  oidcIdpName: string;
  /** First run: administrator to create when there are no users. Only created when `pass` is set. */
  defaultUser: { name: string; pass: string | undefined };
  /** GOTIFY_IMPORT_TOKEN (secret): enables POST /_import, see import.ts. Not in upstream. Unset or empty: the route does not exist. */
  importToken: string | undefined;
  version: VersionInfo;
}

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, unknown>;

function lookup(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
}

function parseBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = lookup(env, name);
  if (raw === undefined) return fallback;
  // strconv.ParseBool
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(raw)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(raw)) return false;
  throw new ConfigError(`invalid bool for ${name} (${JSON.stringify(raw)})`);
}

function parseInt10(env: Env, name: string, fallback: number): number {
  const raw = lookup(env, name);
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(raw)) throw new ConfigError(`invalid int for ${name} (${JSON.stringify(raw)})`);
  return Number(raw);
}

/** One CSV record, as Go's encoding/csv with TrimLeadingSpace and LazyQuotes. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const n = line.length;
  while (true) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    let field = '';
    if (line[i] === '"') {
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          // closing quote (a stray quote followed by text is kept, "lazy quotes")
          if (i + 1 >= n || line[i + 1] === ',') {
            i++;
            break;
          }
          field += '"';
          i++;
          continue;
        }
        field += line[i++];
      }
    } else {
      while (i < n && line[i] !== ',') field += line[i++];
    }
    fields.push(field);
    if (i >= n) break;
    i++; // the comma
    if (i >= n) {
      fields.push('');
      break;
    }
  }
  return fields;
}

function parseList(env: Env, name: string): string[] {
  const raw = lookup(env, name);
  if (raw === undefined || raw === '') return [];
  return parseCsvLine(raw);
}

function parseMap(env: Env, name: string): Record<string, string> {
  const raw = lookup(env, name);
  if (raw === undefined || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`invalid JSON for ${name}: ${(e as Error).message}`);
  }
  if (parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError(`invalid JSON for ${name}: expected an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new ConfigError(`invalid JSON for ${name}: value of ${k} is not a string`);
    out[k] = v;
  }
  return out;
}

/** Builds the configuration from Worker bindings (vars and secrets). Throws ConfigError. */
export function configFromEnv(env: Env): GotifyConfig {
  // DELIBERATE DIVERGENCE: the import token is a bearer secret for a route that replaces all data, so it must be long;
  // a bcrypt cost above 31 is invalid (and would hang). Upstream's quirk stays: a cost below 4 falls back to 10.
  const importToken = lookup(env, 'GOTIFY_IMPORT_TOKEN') || undefined;
  if (importToken !== undefined && importToken.length < 32) throw new ConfigError('GOTIFY_IMPORT_TOKEN must be at least 32 characters');
  const passStrength = parseInt10(env, 'GOTIFY_PASSSTRENGTH', 10);
  if (passStrength > 31) throw new ConfigError(`GOTIFY_PASSSTRENGTH must be at most 31 (${passStrength})`);
  return {
    registration: parseBool(env, 'GOTIFY_REGISTRATION', false),
    localAuthEnabled: true,
    passStrength,
    secureCookie: parseBool(env, 'GOTIFY_SERVER_SECURECOOKIE', true),
    streamAllowedOrigins: parseList(env, 'GOTIFY_SERVER_STREAM_ALLOWEDORIGINS'),
    corsAllowOrigins: parseList(env, 'GOTIFY_SERVER_CORS_ALLOWORIGINS'),
    corsAllowMethods: parseList(env, 'GOTIFY_SERVER_CORS_ALLOWMETHODS'),
    corsAllowHeaders: parseList(env, 'GOTIFY_SERVER_CORS_ALLOWHEADERS'),
    responseHeaders: parseMap(env, 'GOTIFY_SERVER_RESPONSEHEADERS'),
    maxBodyBytes: parseInt10(env, 'GOTIFY_SERVER_MAXBODYBYTES', DEFAULT_MAX_BODY_BYTES),
    oidcIdpName: 'OIDC',
    defaultUser: {
      name: lookup(env, 'GOTIFY_DEFAULTUSER_NAME') ?? 'admin',
      pass: lookup(env, 'GOTIFY_DEFAULTUSER_PASS') || undefined,
    },
    importToken,
    version: VERSION_INFO,
  };
}

/** A complete config with upstream's defaults, for tests and callers that only override a few values. */
export function defaultConfig(overrides: Partial<GotifyConfig> = {}): GotifyConfig {
  return { ...configFromEnv({}), ...overrides };
}
