// Response helpers that mirror what upstream's gin handlers and the error
// middleware (error/handler.go) put on the wire.

/** net/http.StatusText for the codes this server produces. */
export const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  301: 'Moved Permanently',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Request Entity Too Large',
  500: 'Internal Server Error',
};

export function statusText(code: number): string {
  return STATUS_TEXT[code] ?? '';
}

/** An error that is reported to the client as the upstream error body. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public description: string,
  ) {
    super(description);
    this.name = 'HttpError';
  }
}

/**
 * JSON.stringify with Go's encoding/json escaping: <, >, & and U+2028/U+2029
 * become \u00XX escapes. Those characters can only occur inside strings in
 * JSON output, so a global replace is safe.
 */
export function goJSON(value: unknown): string {
  return escapeHtmlJson(JSON.stringify(value));
}

export function escapeHtmlJson(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Go's time.Time JSON form (RFC 3339, UTC): fractional seconds only when non-zero, trailing zeros trimmed. */
export function formatTime(ms: number): string {
  // Dates outside JavaScript's range (or NaN) must not make toISOString throw.
  const safe = Number.isFinite(ms) ? Math.min(8.64e15, Math.max(-8.64e15, ms)) : 0;
  const iso = new Date(safe).toISOString(); // 2017-01-02T00:00:00.000Z
  return iso.replace(/\.?0+Z$/, 'Z');
}

export function errorBody(status: number, description: string): string {
  return goJSON({ error: statusText(status), errorCode: status, errorDescription: description });
}

/**
 * Canonical JSON for message extras: object keys sorted, like Go's
 * json.Marshal of a map. (Upstream stores the marshalled map and
 * unmarshals it again for every response, so keys always come out sorted.)
 */
export function canonicalJSON(value: unknown): string {
  try {
    return escapeHtmlJson(canonical(value));
  } catch (e) {
    // shortcut: the recursive walk runs out of stack at a few thousand levels, long before Go's 10000; report it like the binding does
    if (e instanceof RangeError) throw new HttpError(400, "invalid character '[' exceeded max depth");
    throw e;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
