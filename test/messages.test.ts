// Ported from api/message_test.go.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp, createUser, makeServer, T0 } from './harness.ts';

async function send(h: Awaited<ReturnType<typeof makeServer>>, token: string, n: number, prefix = 'm') {
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) {
    const res = await h.call('POST', '/message', { key: token, json: { message: `${prefix}${i}` } });
    assert.equal(res.status, 200);
    ids.push(res.json.id);
  }
  return ids;
}

test('create: JSON, the exact response shape', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'Application name');
  h.clock.now = Date.UTC(2017, 0, 2);
  const res = await h.call('POST', '/message', { key: app.token, json: { message: 'mymessage', title: 'msg title', priority: 3 } });
  assert.equal(res.status, 200);
  assert.equal(res.text, `{"id":1,"appid":${app.id},"message":"mymessage","title":"msg title","priority":3,"date":"2017-01-02T00:00:00Z"}`);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('create: title and priority defaults', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'Application name', { defaultPriority: 4 });
  let res = await h.call('POST', '/message', { key: app.token, json: { message: 'm' } });
  assert.equal(res.json.title, 'Application name');
  assert.equal(res.json.priority, 4);
  res = await h.call('POST', '/message', { key: app.token, json: { message: 'm', title: '   ' } });
  assert.equal(res.json.title, 'Application name');
  res = await h.call('POST', '/message', { key: app.token, json: { message: 'm', title: ' kept ', priority: 0 } });
  assert.equal(res.json.title, ' kept '); // only checked for blankness
  assert.equal(res.json.priority, 0); // an explicit 0 beats the default
  res = await h.call('POST', '/message', { key: app.token, json: { message: 'm', priority: -2 } });
  assert.equal(res.json.priority, -2);
  // the id can not be chosen
  res = await h.call('POST', '/message', { key: app.token, json: { message: 'm', id: 99 } });
  assert.equal(res.json.id, 5);
});

test('create: extras are stored and returned with sorted keys', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const body = '{"message": "mymessage", "title": "msg with extras", "extras": {"gotify::test":{"string":"test","int":1,"float":0.5,"array":[1,2,3]},"a::b":{"z":1,"b":{"y":true,"x":null}}}}';
  const res = await h.call('POST', '/message', { key: app.token, body, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 200);
  assert.match(
    res.text,
    /"extras":\{"a::b":\{"b":\{"x":null,"y":true\},"z":1\},"gotify::test":\{"array":\[1,2,3\],"float":0\.5,"int":1,"string":"test"\}\},"date":/,
  );
  // the listing has the same representation
  const list = await h.call('GET', '/message', h.admin);
  assert.match(list.text, /"extras":\{"a::b":\{"b":\{"x":null,"y":true\},"z":1\},"gotify::test":\{"array":\[1,2,3\],"float":0\.5,"int":1,"string":"test"\}\}/);
  // empty extras are left out
  const empty = await h.call('POST', '/message', { key: app.token, json: { message: 'm', extras: {} } });
  assert.ok(!empty.text.includes('extras'));
  // HTML characters are escaped like Go does
  const html = await h.call('POST', '/message', { key: app.token, json: { message: '<b>&</b>', extras: { 'x::y': '<>' } } });
  assert.ok(html.text.includes('"message":"\\u003cb\\u003e\\u0026\\u003c/b\\u003e"'));
  assert.ok(html.text.includes('"x::y":"\\u003c\\u003e"'));
});

test('create: query and form data', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  h.clock.now = Date.UTC(2017, 0, 2);
  let res = await h.call('POST', '/message?title=mytitle&message=mymessage&priority=1', {
    key: app.token,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { id: 1, appid: app.id, message: 'mymessage', title: 'mytitle', priority: 1, date: '2017-01-02T00:00:00Z' });
  res = await h.call('POST', '/message', { key: app.token, form: { title: 'mytitle', message: 'mymessage', priority: '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.priority, 1);
  // multipart form
  const form = new FormData();
  form.append('message', 'from multipart');
  form.append('title', 't');
  res = await h.call('POST', '/message', { key: app.token, body: form });
  assert.equal(res.status, 200);
  assert.equal(res.json.message, 'from multipart');
  // the token can be in the query too
  res = await h.call('POST', `/message?token=${encodeURIComponent(app.token)}`, { form: { message: 'tq' } });
  assert.equal(res.status, 200);
});

test('create: failures', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  let res = await h.call('POST', '/message', { key: app.token, json: { title: 'no message' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: 'Bad Request', errorCode: 400, errorDescription: "Field 'message' is required" });
  res = await h.call('POST', '/message', { key: app.token, json: { message: '' } });
  assert.equal(res.status, 400);
  res = await h.call('POST', '/message', { key: app.token, json: { message: 'm', priority: 'high' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'json: cannot unmarshal string into Go struct field CreateMessage.priority of type int');
  res = await h.call('POST', '/message', { key: app.token, form: { message: 'm', priority: 'abc' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'strconv.ParseInt: parsing "abc": invalid syntax');
  res = await h.call('POST', '/message', { key: app.token, json: { message: 'm', extras: 'nope' } });
  assert.equal(res.status, 400);
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM messages')!.n, 0);
});

test('create: extras nested thousands of levels deep are a 400, nothing is stored', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const n = 3000;
  const body = '{"message":"m","extras":' + '{"a":'.repeat(n) + '1' + '}'.repeat(n) + '}';
  const res = await h.call('POST', '/message', { key: app.token, body, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM messages')!.n, 0);
});

test('list: newest first, paging with next links', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  await send(h, app.token, 12);

  let res = await h.call('GET', '/message', h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.json.messages.length, 12);
  assert.deepEqual(res.json.paging, { size: 12, since: 0, limit: 100 });
  assert.deepEqual(res.json.messages.map((m: any) => m.id), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.ok(res.text.startsWith('{"paging":{"size":12,"since":0,"limit":100},"messages":[{"id":12,'));

  res = await h.call('GET', '/message?limit=5', h.admin);
  assert.deepEqual(res.json.paging, { next: '/message?limit=5&since=8', size: 5, since: 8, limit: 5 });
  assert.deepEqual(res.json.messages.map((m: any) => m.id), [12, 11, 10, 9, 8]);
  // Go's encoding/json escapes & as \u0026 (same value once parsed)
  assert.ok(res.text.startsWith('{"paging":{"next":"/message?limit=5\\u0026since=8","size":5,"since":8,"limit":5},'));

  res = await h.call('GET', '/message?limit=5&since=8', h.admin);
  assert.deepEqual(res.json.paging, { next: '/message?limit=5&since=3', size: 5, since: 3, limit: 5 });
  assert.deepEqual(res.json.messages.map((m: any) => m.id), [7, 6, 5, 4, 3]);

  res = await h.call('GET', '/message?limit=5&since=3', h.admin);
  assert.deepEqual(res.json.paging, { size: 2, since: 0, limit: 5 });
  assert.deepEqual(res.json.messages.map((m: any) => m.id), [2, 1]);

  // exactly a full last page has no next link
  res = await h.call('GET', '/message?limit=2&since=3', h.admin);
  assert.deepEqual(res.json.paging, { size: 2, since: 0, limit: 2 });
  res = await h.call('GET', '/message?limit=12', h.admin);
  assert.equal(res.json.paging.next, undefined);
  assert.equal(res.json.messages.length, 12);

  // empty
  res = await h.call('GET', '/message?since=1', h.admin);
  assert.equal(res.text, '{"paging":{"size":0,"since":0,"limit":100},"messages":[]}');
});

test('list: bad paging parameters', async () => {
  const h = await makeServer();
  for (const [query, description] of [
    ['limit=555', "Field 'limit' must be less or equal to 200"],
    ['limit=-5', "Field 'limit' must be more or equal to 1"],
    ['limit=0', "Field 'limit' must be more or equal to 1"],
    ['limit=abc', 'strconv.ParseInt: parsing "abc": invalid syntax'],
    ['since=-1', 'strconv.ParseUint: parsing "-1": invalid syntax'],
  ]) {
    for (const path of ['/message', '/application/1/message']) {
      await createApp(h, h.admin, 'x' + Math.random());
      const res = await h.call('GET', `${path}?${query}`, h.admin);
      assert.equal(res.status, 400, `${path}?${query}`);
      assert.equal(res.json.errorDescription, description);
    }
  }
});

test('list: only the user\'s own messages, across applications', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const a = await createApp(h, h.admin, 'a');
  const b = await createApp(h, h.admin, 'b');
  const theirs = await createApp(h, { basic: other.basic }, 'theirs');
  await send(h, a.token, 2, 'a');
  await send(h, theirs.token, 2, 'x');
  await send(h, b.token, 2, 'b');
  const mine = await h.call('GET', '/message', h.admin);
  assert.deepEqual(mine.json.messages.map((m: any) => m.message), ['b2', 'b1', 'a2', 'a1']);
  const others = await h.call('GET', '/message', { basic: other.basic });
  assert.deepEqual(others.json.messages.map((m: any) => m.message), ['x2', 'x1']);
});

test('per application: list and delete', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const a = await createApp(h, h.admin, 'a');
  const b = await createApp(h, h.admin, 'b');
  for (let i = 0; i < 3; i++) {
    await send(h, a.token, 1, 'a');
    await send(h, b.token, 1, 'b');
  }
  let res = await h.call('GET', `/application/${a.id}/message?limit=2`, h.admin);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.messages.map((m: any) => m.message), ['a1', 'a1']);
  assert.ok(res.json.messages.every((m: any) => m.appid === a.id));
  assert.equal(res.json.paging.next, `/application/${a.id}/message?limit=2&since=${res.json.messages[1].id}`);
  assert.equal(res.json.paging.size, 2);

  res = await h.call('GET', `/application/${a.id}/message`, { basic: other.basic });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, 'application does not exist');
  res = await h.call('GET', '/application/99/message', h.admin);
  assert.equal(res.status, 404);
  res = await h.call('GET', '/application/abc/message', h.admin);
  assert.equal(res.status, 400);

  res = await h.call('DELETE', `/application/${a.id}/message`, { basic: other.basic });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, 'application does not exists');
  res = await h.call('DELETE', '/application/99/message', h.admin);
  assert.equal(res.status, 404);
  res = await h.call('DELETE', `/application/${a.id}/message`, h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  const left = await h.call('GET', '/message', h.admin);
  assert.deepEqual(left.json.messages.map((m: any) => m.message), ['b1', 'b1', 'b1']);
});

test('delete one', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const app = await createApp(h, h.admin, 'a');
  const [one, two] = await send(h, app.token, 2);
  let res = await h.call('DELETE', `/message/${one}`, { basic: other.basic });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, 'message does not exist');
  res = await h.call('DELETE', '/message/abc', h.admin);
  assert.equal(res.status, 400);
  res = await h.call('DELETE', '/message/999', h.admin);
  assert.equal(res.status, 404);
  res = await h.call('DELETE', `/message/${one}`, h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(h.store.getMessageById(one), null);
  assert.ok(h.store.getMessageById(two));
  assert.equal((await h.call('DELETE', `/message/${one}`, h.admin)).status, 404);
});

test('delete all of a user', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const mine = await createApp(h, h.admin, 'mine');
  const theirs = await createApp(h, { basic: other.basic }, 'theirs');
  await send(h, mine.token, 3);
  await send(h, theirs.token, 2);
  const res = await h.call('DELETE', '/message', h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal((await h.call('GET', '/message', h.admin)).json.messages.length, 0);
  assert.equal((await h.call('GET', '/message', { basic: other.basic })).json.messages.length, 2);
});

test('message ids keep increasing after deletes', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const [one] = await send(h, app.token, 1);
  await h.call('DELETE', `/message/${one}`, h.admin);
  const [two] = await send(h, app.token, 1);
  assert.equal(two, one + 1);
});

test('dates are the server clock, in RFC 3339 with trimmed fractions', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  for (const [ms, text] of [
    [T0, '2026-01-15T12:00:00Z'],
    [T0 + 500, '2026-01-15T12:00:00.5Z'],
    [T0 + 120, '2026-01-15T12:00:00.12Z'],
    [T0 + 7, '2026-01-15T12:00:00.007Z'],
  ] as const) {
    h.clock.now = ms;
    const res = await h.call('POST', '/message', { key: app.token, json: { message: 'm' } });
    assert.equal(res.json.date, text);
  }
});
