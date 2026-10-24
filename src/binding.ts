// Request binding and validation, modelled on gin's ctx.Bind and the
// go-playground validator as upstream uses them (see error/handler.go for the
// message formats).
//
// Binding is chosen like gin's binding.Default: GET requests bind the query
// string; otherwise exactly "application/json" binds JSON, "multipart/form-data"
// binds a multipart form, and everything else binds a form (the query string
// plus, for application/x-www-form-urlencoded, the body).

import { HttpError } from './http.ts';

export type FieldType = 'string' | 'int' | 'uint' | 'bool' | 'object';

export interface FieldSpec {
  /** Go struct field name, used in validation messages ("Name" -> "name"). */
  field: string;
  json: string;
  /** Form/query key; null for fields that are not form bindable (form:"-"). */
  form: string | null;
  type: FieldType;
  /** *int / *uint: absent is reported as null. */
  pointer?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
}

export interface StructSpec {
  /** Go struct name, used in JSON type error messages. */
  name: string;
  /** Go package of the struct (only for the "Go value of type" message). */
  pkg?: 'api' | 'model';
  fields: FieldSpec[];
}

export type Bound = Record<string, any>;

/** The largest number of whole seconds a Go time.Duration can represent (2^63 - 1 ns). */
export const MAX_DURATION_SECONDS = 9223372036;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function goTypeName(f: FieldSpec): string {
  switch (f.type) {
    case 'string':
      return 'string';
    case 'int':
      return 'int';
    case 'uint':
      return 'uint';
    case 'bool':
      return 'bool';
    case 'object':
      return 'map[string]interface {}';
  }
}

function zeroValue(f: FieldSpec): unknown {
  if (f.pointer) return null;
  switch (f.type) {
    case 'string':
      return '';
    case 'int':
    case 'uint':
      return 0;
    case 'bool':
      return false;
    case 'object':
      return null;
  }
}

function newBound(spec: StructSpec): Bound {
  const out: Bound = {};
  for (const f of spec.fields) out[f.json] = zeroValue(f);
  return out;
}

/** The part of a Content-Type before any parameters, as gin's filterFlags. */
export function contentTypeOf(header: string | null): string {
  if (!header) return '';
  const i = header.search(/[; ]/);
  return i < 0 ? header : header.slice(0, i);
}

// ---- JSON ------------------------------------------------------------------

function jsonKind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    default:
      return 'object';
  }
}

// ---- a scanner with encoding/json's syntax error messages ----

/** strconv.Quote of one byte (as Go's quoteChar does), without the outer quotes handled. */
function quoteChar(c: number): string {
  if (c === 0x27) return `'\\''`;
  if (c === 0x22) return `'"'`;
  const named: Record<number, string> = { 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v', 0x5c: '\\\\' };
  let q: string;
  if (named[c] !== undefined) q = named[c];
  else if (c < 0x20 || c === 0x7f) q = '\\x' + c.toString(16).padStart(2, '0');
  else if (c >= 0x80 && c < 0xa0) q = '\\u' + c.toString(16).padStart(4, '0');
  else q = String.fromCharCode(c);
  return `'${q}'`;
}

const MAX_JSON_DEPTH = 10000;

class JsonScanner {
  pos = 0;
  private depth = 0;
  /** Containers currently open (objects and arrays); `depth` counts objects only. */
  private nest = 0;
  /** Raw text of the number values of the top-level object, by key (Go reports the literal in type errors). */
  numbers = new Map<string, string>();
  constructor(private b: Uint8Array) {}

  private fail(c: number, context: string): never {
    throw new HttpError(400, `invalid character ${quoteChar(c)} ${context}`);
  }

  private eof(): never {
    throw new HttpError(400, 'unexpected EOF');
  }

  private skipSpace() {
    while (this.pos < this.b.length) {
      const c = this.b[this.pos];
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  /** Scans the first value; returns the byte offset where it ends. */
  scanTop(): number {
    this.skipSpace();
    if (this.pos >= this.b.length) throw new HttpError(400, 'EOF');
    this.value();
    return this.pos;
  }

  private value() {
    this.skipSpace();
    if (this.pos >= this.b.length) this.eof();
    const c = this.b[this.pos];
    if (c === 0x7b) return this.object();
    if (c === 0x5b) return this.array();
    if (c === 0x22) return this.string();
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
    if (c === 0x74) return this.literal('true');
    if (c === 0x66) return this.literal('false');
    if (c === 0x6e) return this.literal('null');
    this.fail(c, 'looking for beginning of value');
  }

  /** Go's encoding/json refuses more than 10000 nested containers. */
  private enter() {
    if (++this.nest > MAX_JSON_DEPTH) this.fail(this.b[this.pos], 'exceeded max depth');
  }

  private object() {
    this.enter();
    this.depth++;
    this.pos++; // {
    this.skipSpace();
    if (this.pos >= this.b.length) this.eof();
    if (this.b[this.pos] === 0x7d) {
      this.pos++;
      this.depth--;
      this.nest--;
      return;
    }
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.b.length) this.eof();
      if (this.b[this.pos] !== 0x22) this.fail(this.b[this.pos], 'looking for beginning of object key string');
      const keyStart = this.pos;
      this.string();
      const keyEnd = this.pos;
      this.skipSpace();
      if (this.pos >= this.b.length) this.eof();
      if (this.b[this.pos] !== 0x3a) this.fail(this.b[this.pos], 'after object key');
      this.pos++;
      this.skipSpace();
      const valueStart = this.pos;
      this.value();
      if (this.depth === 1 && valueStart < this.b.length && (this.b[valueStart] === 0x2d || (this.b[valueStart] >= 0x30 && this.b[valueStart] <= 0x39))) {
        const key = JSON.parse(new TextDecoder().decode(this.b.subarray(keyStart, keyEnd))) as string;
        this.numbers.set(key, new TextDecoder().decode(this.b.subarray(valueStart, this.pos)));
      }
      this.skipSpace();
      if (this.pos >= this.b.length) this.eof();
      const c = this.b[this.pos];
      if (c === 0x2c) {
        this.pos++;
        continue;
      }
      if (c === 0x7d) {
        this.pos++;
        this.depth--;
        this.nest--;
        return;
      }
      this.fail(c, 'after object key:value pair');
    }
  }

  private array() {
    this.enter();
    this.pos++; // [
    this.skipSpace();
    if (this.pos >= this.b.length) this.eof();
    if (this.b[this.pos] === 0x5d) {
      this.pos++;
      this.nest--;
      return;
    }
    for (;;) {
      this.value();
      this.skipSpace();
      if (this.pos >= this.b.length) this.eof();
      const c = this.b[this.pos];
      if (c === 0x2c) {
        this.pos++;
        continue;
      }
      if (c === 0x5d) {
        this.pos++;
        this.nest--;
        return;
      }
      this.fail(c, 'after array element');
    }
  }

  private string() {
    this.pos++; // opening quote
    for (;;) {
      if (this.pos >= this.b.length) this.eof();
      const c = this.b[this.pos++];
      if (c === 0x22) return;
      if (c === 0x5c) {
        if (this.pos >= this.b.length) this.eof();
        const e = this.b[this.pos++];
        if ('bfnrt\\/"'.includes(String.fromCharCode(e))) continue;
        if (e === 0x75) {
          for (let i = 0; i < 4; i++) {
            if (this.pos >= this.b.length) this.eof();
            const h = this.b[this.pos++];
            const hex = (h >= 0x30 && h <= 0x39) || (h >= 0x41 && h <= 0x46) || (h >= 0x61 && h <= 0x66);
            if (!hex) this.fail(h, 'in \\u hexadecimal character escape');
          }
          continue;
        }
        this.fail(e, 'in string escape code');
      }
      if (c < 0x20) this.fail(c, 'in string literal');
    }
  }

  private digits(): number {
    let n = 0;
    while (this.pos < this.b.length && this.b[this.pos] >= 0x30 && this.b[this.pos] <= 0x39) {
      this.pos++;
      n++;
    }
    return n;
  }

  private number() {
    if (this.b[this.pos] === 0x2d) {
      this.pos++;
      if (this.pos >= this.b.length) this.eof();
      const c = this.b[this.pos];
      if (c < 0x30 || c > 0x39) this.fail(c, 'in numeric literal');
    }
    if (this.b[this.pos] === 0x30) this.pos++;
    else this.digits();
    if (this.pos < this.b.length && this.b[this.pos] === 0x2e) {
      this.pos++;
      if (this.pos >= this.b.length) this.eof();
      const c = this.b[this.pos];
      if (c < 0x30 || c > 0x39) this.fail(c, 'after decimal point in numeric literal');
      this.digits();
    }
    if (this.pos < this.b.length && (this.b[this.pos] === 0x65 || this.b[this.pos] === 0x45)) {
      this.pos++;
      if (this.pos >= this.b.length) this.eof();
      if (this.b[this.pos] === 0x2b || this.b[this.pos] === 0x2d) {
        this.pos++;
        if (this.pos >= this.b.length) this.eof();
      }
      const c = this.b[this.pos];
      if (c < 0x30 || c > 0x39) this.fail(c, 'in exponent of numeric literal');
      this.digits();
    }
  }

  private literal(word: string) {
    for (let i = 0; i < word.length; i++) {
      if (this.pos >= this.b.length) this.eof();
      const c = this.b[this.pos];
      if (c !== word.charCodeAt(i)) this.fail(c, `in literal ${word} (expecting ${quoteChar(word.charCodeAt(i))})`);
      this.pos++;
    }
  }
}

/** Parses the first JSON value like Go's Decoder.Decode: what follows it is ignored. Errors carry Go's messages. */
function parseJSONValue(bytes: Uint8Array): { doc: unknown; numbers: Map<string, string> } {
  const scanner = new JsonScanner(bytes);
  let end: number;
  try {
    end = scanner.scanTop();
  } catch (e) {
    // shortcut: the recursive scanner runs out of stack before Go's 10000 levels (about 4000 on Node); report that the same way
    if (e instanceof RangeError) throw new HttpError(400, "invalid character '[' exceeded max depth");
    throw e;
  }
  return { doc: JSON.parse(new TextDecoder().decode(bytes.subarray(0, end))), numbers: scanner.numbers };
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/** Whether a JSON number literal can be stored in a Go int64 / uint64 (strconv.ParseInt / ParseUint, base 10). */
function fitsGoInteger(literal: string, unsigned: boolean): boolean {
  if (!/^-?\d+$/.test(literal)) return false;
  const n = BigInt(literal);
  return unsigned ? n >= 0n && n <= UINT64_MAX : n >= INT64_MIN && n <= INT64_MAX;
}

function bindJSON(spec: StructSpec, bytes: Uint8Array): Bound {
  const out = newBound(spec);
  const { doc, numbers } = parseJSONValue(bytes);
  if (doc === null) return out;
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new HttpError(400, `json: cannot unmarshal ${jsonKind(doc)} into Go value of type ${spec.pkg ?? 'model'}.${spec.name}`);
  }
  let firstError: string | null = null;
  const typeError = (f: FieldSpec, value: string) => {
    firstError ??= `json: cannot unmarshal ${value} into Go struct field ${spec.name}.${f.json} of type ${goTypeName(f)}`;
  };
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    // encoding/json prefers an exact key match and otherwise matches case-insensitively.
    const f = spec.fields.find((x) => x.json === key) ?? spec.fields.find((x) => x.json.toLowerCase() === key.toLowerCase());
    if (!f) continue;
    if (value === null) {
      out[f.json] = zeroValue(f);
      continue;
    }
    switch (f.type) {
      case 'string':
        if (typeof value === 'string') out[f.json] = value;
        else typeError(f, jsonKind(value));
        break;
      case 'bool':
        if (typeof value === 'boolean') out[f.json] = value;
        else typeError(f, jsonKind(value));
        break;
      case 'int':
      case 'uint':
        if (typeof value !== 'number') typeError(f, jsonKind(value));
        else {
          const literal = numbers.get(key) ?? String(value);
          if (!fitsGoInteger(literal, f.type === 'uint')) typeError(f, `number ${literal}`);
          else out[f.json] = value;
        }
        break;
      case 'object':
        if (typeof value === 'object' && !Array.isArray(value)) out[f.json] = value;
        else typeError(f, jsonKind(value));
        break;
    }
  }
  if (firstError) throw new HttpError(400, firstError);
  return out;
}

// ---- forms -----------------------------------------------------------------

export type FormValues = Array<[string, string]>;

function parseFormValue(f: FieldSpec, raw: string): unknown {
  switch (f.type) {
    case 'string':
      return raw;
    case 'int': {
      const v = raw === '' ? '0' : raw;
      if (!/^[+-]?\d+$/.test(v)) throw new HttpError(400, `strconv.ParseInt: parsing "${raw}": invalid syntax`);
      if (!fitsGoInteger(v.replace(/^\+/, ''), false)) throw new HttpError(400, `strconv.ParseInt: parsing "${raw}": value out of range`);
      return Number(v);
    }
    case 'uint': {
      const v = raw === '' ? '0' : raw;
      if (!/^\d+$/.test(v)) throw new HttpError(400, `strconv.ParseUint: parsing "${raw}": invalid syntax`);
      if (!fitsGoInteger(v, true)) throw new HttpError(400, `strconv.ParseUint: parsing "${raw}": value out of range`);
      return Number(v);
    }
    case 'bool': {
      if (raw === '') return false;
      if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(raw)) return true;
      if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(raw)) return false;
      throw new HttpError(400, `strconv.ParseBool: parsing "${raw}": invalid syntax`);
    }
    case 'object':
      return null;
  }
}

function bindForm(spec: StructSpec, values: FormValues): Bound {
  const out = newBound(spec);
  for (const f of spec.fields) {
    if (f.form === null) continue;
    const hit = values.find(([k]) => k === f.form);
    if (!hit) continue; // absent: keep the zero value (null for pointers)
    out[f.json] = parseFormValue(f, hit[1]);
  }
  return out;
}

/** Query string values, in order. */
export function queryValues(url: URL): FormValues {
  return [...url.searchParams.entries()];
}

// ---- validation --------------------------------------------------------------

function validate(spec: StructSpec, bound: Bound): void {
  const messages: string[] = [];
  for (const f of spec.fields) {
    const v = bound[f.json];
    const name = lowerFirst(f.field);
    if (f.required) {
      const empty = v === null || v === undefined || v === '' || v === 0;
      if (empty) {
        messages.push(`Field '${name}' is required`);
        continue;
      }
    }
    if (typeof v === 'number') {
      if (f.max !== undefined && v > f.max) messages.push(`Field '${name}' must be less or equal to ${f.max}`);
      else if (f.min !== undefined && v < f.min) messages.push(`Field '${name}' must be more or equal to ${f.min}`);
    }
  }
  if (messages.length > 0) throw new HttpError(400, messages.join('; '));
}

// ---- entry points --------------------------------------------------------------

export interface BindInput {
  method: string;
  url: URL;
  contentType: string | null;
  /** Reads the request body (only called when it is needed). */
  body: () => Promise<Uint8Array>;
}

/** Parses a multipart/form-data body; errors are reported like Go's mime/multipart. */
export async function parseMultipart(bytes: Uint8Array, contentType: string): Promise<FormData> {
  if (!/boundary=/i.test(contentType)) throw new Error('no multipart boundary param in Content-Type');
  try {
    return await new Response(bytes as unknown as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new Error('multipart: NextPart: EOF');
  }
}

/** Equivalent of gin's ctx.Bind(&obj), including validation. */
export async function bind(input: BindInput, spec: StructSpec): Promise<Bound> {
  const type = contentTypeOf(input.contentType);
  let bound: Bound;
  if (input.method === 'GET') {
    bound = bindForm(spec, queryValues(input.url));
  } else if (type === 'application/json') {
    bound = bindJSON(spec, await input.body());
  } else {
    const mediaType = (input.contentType ?? '').split(';')[0].trim().toLowerCase();
    const query = queryValues(input.url);
    let values: FormValues = query;
    if (mediaType === 'application/x-www-form-urlencoded' && ['POST', 'PUT', 'PATCH'].includes(input.method)) {
      const body = new TextDecoder().decode(await input.body());
      values = [...new URLSearchParams(body).entries(), ...query];
    } else if (mediaType === 'multipart/form-data') {
      let form: FormData;
      try {
        form = await parseMultipart(await input.body(), input.contentType!);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const fields: FormValues = [];
      form.forEach((value, key) => {
        if (typeof value === 'string') fields.push([key, value]);
      });
      values = [...query, ...fields];
    }
    bound = bindForm(spec, values);
  }
  validate(spec, bound);
  return bound;
}

/** Equivalent of ctx.MustBindWith(obj, binding.Query), with defaults pre-set by the caller. */
export function bindQuery(url: URL, spec: StructSpec, defaults: Bound = {}): Bound {
  const bound = { ...bindForm(spec, queryValues(url)) };
  // Keys that were absent keep their defaults (Go pre-fills the struct).
  for (const f of spec.fields) {
    if (f.form !== null && !url.searchParams.has(f.form) && f.json in defaults) bound[f.json] = defaults[f.json];
  }
  validate(spec, bound);
  return bound;
}

// ---- the request structs upstream binds ----------------------------------------

export const APPLICATION_PARAMS: StructSpec = {
  name: 'ApplicationParams',
  pkg: 'api',
  fields: [
    { field: 'Name', json: 'name', form: 'name', type: 'string', required: true },
    { field: 'Description', json: 'description', form: 'description', type: 'string' },
    { field: 'DefaultPriority', json: 'defaultPriority', form: 'defaultPriority', type: 'int' },
    { field: 'SortKey', json: 'sortKey', form: 'sortKey', type: 'string' },
  ],
};

export const CLIENT_PARAMS: StructSpec = {
  name: 'ClientParams',
  pkg: 'api',
  fields: [
    { field: 'Name', json: 'name', form: 'name', type: 'string', required: true },
    {
      field: 'ExpiresAfterInactivitySeconds',
      json: 'expiresAfterInactivitySeconds',
      form: 'expiresAfterInactivitySeconds',
      type: 'uint',
      pointer: true,
      // time.Duration holds at most 2^63 ns, about 9.22e9 seconds
      max: MAX_DURATION_SECONDS,
    },
  ],
};

export const CREATE_MESSAGE: StructSpec = {
  name: 'CreateMessage',
  fields: [
    { field: 'ApplicationID', json: 'appid', form: 'appid', type: 'uint' },
    { field: 'Message', json: 'message', form: 'message', type: 'string', required: true },
    { field: 'Title', json: 'title', form: 'title', type: 'string' },
    { field: 'Priority', json: 'priority', form: 'priority', type: 'int', pointer: true },
    { field: 'Extras', json: 'extras', form: null, type: 'object' },
  ],
};

export const CREATE_USER: StructSpec = {
  name: 'CreateUserExternal',
  fields: [
    { field: 'Name', json: 'name', form: 'name', type: 'string', required: true },
    { field: 'Admin', json: 'admin', form: 'admin', type: 'bool' },
    { field: 'Pass', json: 'pass', form: 'pass', type: 'string', required: true },
  ],
};

export const UPDATE_USER: StructSpec = {
  name: 'UpdateUserExternal',
  fields: [
    { field: 'Name', json: 'name', form: 'name', type: 'string', required: true },
    { field: 'Admin', json: 'admin', form: 'admin', type: 'bool' },
    { field: 'Pass', json: 'pass', form: 'pass', type: 'string' },
  ],
};

export const USER_PASS: StructSpec = {
  name: 'UserExternalPass',
  fields: [{ field: 'Pass', json: 'pass', form: 'pass', type: 'string', required: true }],
};

export const ELEVATE_REQUEST: StructSpec = {
  name: 'ElevateRequest',
  fields: [
    {
      field: 'DurationSeconds',
      json: 'durationSeconds',
      form: 'durationSeconds',
      type: 'int',
      required: true,
      max: MAX_DURATION_SECONDS,
      min: -MAX_DURATION_SECONDS,
    },
  ],
};

export const SECURITY_UPDATE_ACTION: StructSpec = {
  name: 'SecurityUpdateAction',
  fields: [{ field: 'RegenerateToken', json: 'regenerateToken', form: 'regenerateToken', type: 'bool' }],
};

export const PAGING_PARAMS: StructSpec = {
  name: 'pagingParams',
  pkg: 'api',
  fields: [
    { field: 'Limit', json: 'limit', form: 'limit', type: 'int', min: 1, max: 200 },
    { field: 'Since', json: 'since', form: 'since', type: 'uint', min: 0 },
  ],
};
