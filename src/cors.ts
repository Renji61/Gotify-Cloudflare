// CORS, reproducing the behaviour of auth/cors.go on top of gin-contrib/cors
// (v1.7), which is how upstream configures it:
//
//  - Allowed origins are regular expressions (unanchored, matched against the
//    lower-cased Origin), from GOTIFY_SERVER_CORS_ALLOWORIGINS.
//  - If no origin regexes are configured and the response headers config sets
//    Access-Control-Allow-Origin, that value is the one exact allowed origin
//    ("*" allows all).
//  - A request whose Origin equals http(s)://<Host> is not treated as CORS.
//  - Any other Origin that is not allowed gets an empty 403, even if the
//    request has no Origin-dependent behaviour otherwise. With nothing
//    configured, cross-origin browser requests are therefore refused; requests
//    without an Origin header (curl, the Android app) are unaffected.
//  - Preflights answer 204 with Allow-Methods/Allow-Headers only when
//    configured, and Max-Age 43200.

export interface CorsConfig {
  allowOrigins: string[];
  allowMethods: string[];
  allowHeaders: string[];
  responseHeaders: Record<string, string>;
}

export type CorsOutcome =
  | { kind: 'skip' }
  | { kind: 'reject' }
  | { kind: 'preflight'; headers: Array<[string, string]> }
  | { kind: 'normal'; headers: Array<[string, string]> };

const EXTENSION_SCHEMAS = ['chrome-extension://', 'safari-extension://', 'moz-extension://', 'ms-browser-extension://'];

/** gin-contrib/cors normalize(): trim, lower-case, de-duplicate. */
function normalize(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function canonicalHeaderKey(k: string): string {
  return k
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('-');
}

function compileRegexes(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // Upstream panics on an invalid pattern at startup; an unusable pattern simply never matches here.
    }
  }
  return out;
}

export class Cors {
  private regexes: RegExp[];
  private exactOrigins: string[] = [];
  private allowAll = false;
  private normalHeaders: Array<[string, string]> = [];
  private preflightHeaders: Array<[string, string]> = [];

  constructor(conf: CorsConfig) {
    this.regexes = compileRegexes(conf.allowOrigins);
    let configured: string | undefined;
    for (const [k, v] of Object.entries(conf.responseHeaders)) {
      if (k.toLowerCase() === 'access-control-allow-origin' && v !== '') configured = v;
    }
    if (configured !== undefined && this.regexes.length === 0) {
      // gin-contrib/cors rejects (panics on) values that neither contain '*' nor start with a known scheme.
      const schemaOk = ['http://', 'https://', ...EXTENSION_SCHEMAS].some((s) => configured!.startsWith(s));
      if (configured.includes('*') || schemaOk) this.exactOrigins = normalize([configured]);
      if (this.exactOrigins.includes('*')) this.allowAll = true;
    }

    // generateNormalHeaders
    if (this.allowAll) this.normalHeaders.push(['Access-Control-Allow-Origin', '*']);
    else this.normalHeaders.push(['Vary', 'Origin']);

    // generatePreflightHeaders
    if (conf.allowMethods.length > 0) {
      this.preflightHeaders.push(['Access-Control-Allow-Methods', normalize(conf.allowMethods).map((m) => m.toUpperCase()).join(',')]);
    }
    if (conf.allowHeaders.length > 0) {
      this.preflightHeaders.push(['Access-Control-Allow-Headers', normalize(conf.allowHeaders).map(canonicalHeaderKey).join(',')]);
    }
    this.preflightHeaders.push(['Access-Control-Max-Age', String(12 * 60 * 60)]);
    if (this.allowAll) {
      this.preflightHeaders.push(['Access-Control-Allow-Origin', '*']);
    } else {
      this.preflightHeaders.push(['Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers']);
    }
  }

  private originAllowed(origin: string): boolean {
    if (this.allowAll) return true;
    if (this.exactOrigins.includes(origin)) return true;
    const lower = origin.toLowerCase();
    return this.regexes.some((re) => re.test(lower));
  }

  /** Mirrors cors.applyCors. `host` is the request's Host header. */
  evaluate(method: string, origin: string | null, host: string): CorsOutcome {
    if (!origin) return { kind: 'skip' };
    if (origin === `http://${host}` || origin === `https://${host}`) return { kind: 'skip' };
    if (!this.originAllowed(origin)) return { kind: 'reject' };
    const extra: Array<[string, string]> = this.allowAll ? [] : [['Access-Control-Allow-Origin', origin]];
    if (method === 'OPTIONS') return { kind: 'preflight', headers: [...this.preflightHeaders, ...extra] };
    return { kind: 'normal', headers: [...this.normalHeaders, ...extra] };
  }
}
