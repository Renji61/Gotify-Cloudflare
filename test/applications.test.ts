// Ported from api/application_test.go (and the image serving from router.go).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp, createUser, makeServer, multipartBody, PNG, T0 } from './harness.ts';

test('create: only the name is required', async () => {
  const h = await makeServer();
  const res = await h.call('POST', '/application', { ...h.admin, json: { name: 'custom_name' } });
  assert.equal(res.status, 200);
  assert.match(res.text, /^\{"id":1,"token":"gtfya\.[A-Za-z0-9_-]{43}","name":"custom_name","description":"","internal":false,"image":"static\/defaultapp\.png","defaultPriority":0,"createdAt":"2026-01-15T12:00:00Z","lastUsed":null,"sortKey":"a0"\}$/);
});

test('create: all parameters, as JSON, form data and query', async () => {
  const h = await makeServer();
  let res = await h.call('POST', '/application', {
    ...h.admin,
    json: { name: 'n', description: 'd', defaultPriority: 5, sortKey: 'a5', internal: true, id: 77, token: 'x', image: 'y', createdAt: '2000-01-01T00:00:00Z' },
  });
  assert.equal(res.status, 200);
  // read only properties are ignored
  assert.equal(res.json.id, 1);
  assert.notEqual(res.json.token, 'x');
  assert.equal(res.json.internal, false);
  assert.equal(res.json.image, 'static/defaultapp.png');
  assert.equal(res.json.createdAt, '2026-01-15T12:00:00Z');
  assert.equal(res.json.description, 'd');
  assert.equal(res.json.defaultPriority, 5);
  assert.equal(res.json.sortKey, 'a5');

  res = await h.call('POST', '/application', { ...h.admin, form: { name: 'custom_name', description: 'description_text', sortKey: 'a6' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.sortKey, 'a6');
  res = await h.call('POST', '/application?name=viaquery&defaultPriority=3', h.admin);
  // no content type: gin binds req.Form, which includes the URL query
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'viaquery');
  assert.equal(res.json.defaultPriority, 3);
});

test('create: validation', async () => {
  const h = await makeServer();
  let res = await h.call('POST', '/application', { ...h.admin, json: { name: '' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, { error: 'Bad Request', errorCode: 400, errorDescription: "Field 'name' is required" });
  res = await h.call('POST', '/application', { ...h.admin, json: {} });
  assert.equal(res.status, 400);
  res = await h.call('POST', '/application', { ...h.admin, json: { name: 'x', defaultPriority: 'high' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'json: cannot unmarshal string into Go struct field ApplicationParams.defaultPriority of type int');
  res = await h.call('POST', '/application', { ...h.admin, form: { name: 'x', defaultPriority: 'high' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'strconv.ParseInt: parsing "high": invalid syntax');
});

test('sort keys: new applications get increasing keys, updating re-orders', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  for (const name of ['one', 'two', 'three']) await h.call('POST', '/application', { ...h.admin, form: { name } });
  // another user does not influence the sequence
  await h.call('POST', '/application', { basic: other.basic, form: { name: 'theirs' } });

  let apps = (await h.call('GET', '/application', h.admin)).json;
  assert.deepEqual(apps.map((a: any) => [a.name, a.sortKey]), [['one', 'a0'], ['two', 'a1'], ['three', 'a2']]);
  assert.equal((await h.call('GET', '/application', { basic: other.basic })).json[0].sortKey, 'a0');

  const res = await h.call('PUT', `/application/${apps[0].id}`, { ...h.admin, form: { name: 'one', description: '', sortKey: 'a1V' } });
  assert.equal(res.status, 200);
  apps = (await h.call('GET', '/application', h.admin)).json;
  assert.deepEqual(apps.map((a: any) => [a.name, a.sortKey]), [['two', 'a1'], ['one', 'a1V'], ['three', 'a2']]);

  // the next one goes after the last
  const created = await h.call('POST', '/application', { ...h.admin, form: { name: 'four' } });
  assert.equal(created.json.sortKey, 'a3');
});

test('sort keys: duplicates are rejected', async () => {
  const h = await makeServer();
  const a = await createApp(h, h.admin, 'a');
  const b = await createApp(h, h.admin, 'b');
  assert.deepEqual([a.sortKey, b.sortKey], ['a0', 'a1']);
  let res = await h.call('PUT', `/application/${b.id}`, { ...h.admin, form: { name: 'new_name', sortKey: 'a0' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'sort key is not unique');
  res = await h.call('POST', '/application', { ...h.admin, json: { name: 'c', sortKey: 'a1' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'sort key is not unique');
});

test('list: own applications only, no tokens, resolved image', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  await createApp(h, h.admin, 'mine');
  await createApp(h, { basic: other.basic }, 'theirs');
  const res = await h.call('GET', '/application', h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 1);
  assert.equal(res.json[0].name, 'mine');
  assert.equal(res.json[0].token, undefined);
  assert.equal(res.json[0].image, 'static/defaultapp.png');
  assert.equal((await h.call('GET', '/application', { basic: ['nobody', 'x'] })).status, 401);
  // nothing: an empty array
  const empty = await h.call('GET', '/application', { basic: other.basic });
  assert.equal(empty.text, empty.text.startsWith('[') ? empty.text : '[]');
  await h.call('DELETE', `/application/${empty.json[0].id}`, { basic: other.basic });
  assert.equal((await h.call('GET', '/application', { basic: other.basic })).text, '[]');
});

test('update: name, description, default priority; keeps image and sort key', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'old', { description: 'olddesc', sortKey: 'a5' });
  const up = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('i.png', PNG) });
  assert.equal(up.status, 200);

  let res = await h.call('PUT', `/application/${app.id}`, { ...h.admin, json: { name: 'new', description: 'newdesc', defaultPriority: 4 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'new');
  assert.equal(res.json.description, 'newdesc');
  assert.equal(res.json.defaultPriority, 4);
  assert.equal(res.json.sortKey, 'a5'); // empty sortKey: unchanged
  assert.equal(res.json.image, up.json.image);
  assert.equal(res.json.token, h.store.getApplicationById(app.id)!.token); // the update response has the stored token

  res = await h.call('PUT', `/application/${app.id}`, { ...h.admin, json: { name: 'new', description: '' } });
  assert.equal(res.json.description, '');
  assert.equal(res.json.defaultPriority, 0);

  res = await h.call('PUT', `/application/${app.id}`, { ...h.admin, json: { description: 'x' } });
  assert.equal(res.status, 400);
  res = await h.call('PUT', '/application/999', { ...h.admin, json: { name: 'x' } });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, "app with id 999 doesn't exists");
});

test('update and delete need ownership', async () => {
  const h = await makeServer();
  const other = await createUser(h, 'other');
  const app = await createApp(h, h.admin, 'mine');
  for (const [method, path, extra] of [
    ['PUT', `/application/${app.id}`, { json: { name: 'x' } }],
    ['DELETE', `/application/${app.id}`, {}],
    ['PUT', `/application/${app.id}/security`, { json: { regenerateToken: true } }],
    ['POST', `/application/${app.id}/image`, { body: multipartBody('i.png', PNG) }],
    ['DELETE', `/application/${app.id}/image`, {}],
  ] as const) {
    const res = await h.call(method, path, { basic: other.basic, ...extra });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(h.store.getApplicationById(app.id)!.name, 'mine');
});

test('delete', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  await h.call('POST', '/message', { key: app.token, json: { message: 'x' } });
  const res = await h.call('DELETE', `/application/${app.id}`, h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.text, '');
  assert.equal(h.store.getApplicationById(app.id), null);
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM messages')!.n, 0);
  assert.equal((await h.call('DELETE', `/application/${app.id}`, h.admin)).status, 404);
  assert.equal((await h.call('DELETE', '/application/abc', h.admin)).status, 400);
});

test('delete: internal applications are protected', async () => {
  const h = await makeServer();
  const app = h.store.createApplication({
    token: 'Ainternal', userId: 1, name: 'plugin-ish', description: '', internal: true, image: '', defaultPriority: 0, sortKey: '',
  });
  const res = await h.call('DELETE', `/application/${app.id}`, h.admin);
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'cannot delete internal application');
});

test('security: regenerate token', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  let res = await h.call('PUT', `/application/${app.id}/security`, { ...h.admin, json: { regenerateToken: true } });
  assert.equal(res.status, 200);
  const fresh = res.json.regenerateToken.token;
  assert.match(fresh, /^gtfya\./);
  assert.notEqual(fresh, app.token);
  // the old token stops working, the new one works
  assert.equal((await h.call('POST', '/message', { key: app.token, json: { message: 'x' } })).status, 401);
  assert.equal((await h.call('POST', '/message', { key: fresh, json: { message: 'x' } })).status, 200);
  // no-op without the action
  res = await h.call('PUT', `/application/${app.id}/security`, { ...h.admin, json: {} });
  assert.equal(res.status, 200);
  assert.equal(res.text, '{}');
  res = await h.call('PUT', `/application/${app.id}/security`, { ...h.admin, json: { regenerateToken: false } });
  assert.equal(res.text, '{}');
  assert.equal((await h.call('POST', '/message', { key: fresh, json: { message: 'x' } })).status, 200);
});

test('images: upload, serve, replace, remove', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  let res = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('image.png', PNG) });
  assert.equal(res.status, 200);
  assert.match(res.json.image, /^image\/[A-Za-z0-9_-]{25}\.png$/);
  assert.equal(res.json.token, h.store.getApplicationById(app.id)!.token);
  const first = res.json.image;

  // served without authentication
  let img = await h.call('GET', `/${first}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('content-length'), String(PNG.length));
  // no CORS and no JSON content type for images
  assert.equal(img.headers.get('access-control-allow-origin'), null);
  const head = await h.call('HEAD', `/${first}`);
  assert.equal(head.status, 200);
  assert.equal(head.text, '');

  // If-Modified-Since
  const lm = img.headers.get('last-modified')!;
  assert.equal(lm, new Date(T0).toUTCString());
  img = await h.call('GET', `/${first}`, { headers: { 'if-modified-since': lm } });
  assert.equal(img.status, 304);

  // the listing shows the same path
  assert.equal((await h.call('GET', '/application', h.admin)).json[0].image, first);

  // a replacement removes the old file
  res = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('other.JPG', PNG) });
  assert.equal(res.status, 200);
  assert.match(res.json.image, /\.JPG$/);
  assert.equal((await h.call('GET', `/${first}`)).status, 404);
  const second = res.json.image;
  img = await h.call('GET', `/${second}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM application_images')!.n, 1);

  // remove
  res = await h.call('DELETE', `/application/${app.id}/image`, h.admin);
  assert.equal(res.status, 200);
  assert.equal(res.json.image, 'static/defaultapp.png');
  assert.equal((await h.call('GET', `/${second}`)).status, 404);
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM application_images')!.n, 0);
  res = await h.call('DELETE', `/application/${app.id}/image`, h.admin);
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, `app with id ${app.id} does not have a customized image`);
});

test('images: deleting the application deletes its image', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('image.gif', Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])) });
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM application_images')!.n, 1);
  await h.call('DELETE', `/application/${app.id}`, h.admin);
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM application_images')!.n, 0);
});

test('images: upload errors', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const up = (body: BodyInit | undefined, headers?: Record<string, string>) =>
    h.call('POST', `/application/${app.id}/image`, { ...h.admin, body, headers });

  // no file part
  const empty = new FormData();
  empty.append('other', 'x');
  let res = await up(empty);
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, "file with key 'file' must be present");

  // not multipart at all
  res = await up('plain', { 'content-type': 'text/plain' });
  assert.equal(res.status, 500);
  res = await up(undefined, { 'content-type': 'multipart/form-data; boundary=xyz' });
  assert.equal(res.status, 500);
  assert.equal(res.json.errorDescription, 'multipart: NextPart: EOF');

  // text file
  res = await up(multipartBody('text.txt', new TextEncoder().encode('just text, not an image at all')));
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'file must be an image');

  // an HTML file that starts with an image header: the extension decides
  const html = new Uint8Array([...PNG.subarray(0, 8), ...new TextEncoder().encode('<html><script>alert(1)</script></html>')]);
  res = await up(multipartBody('image.html', html));
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'invalid file extension');
  res = await up(multipartBody('noextension', PNG));
  assert.equal(res.status, 400);
  assert.equal(res.json.errorDescription, 'invalid file extension');

  // unknown application
  res = await h.call('POST', '/application/55/image', { ...h.admin, body: multipartBody('i.png', PNG) });
  assert.equal(res.status, 404);
  assert.equal(res.json.errorDescription, "app with id 55 doesn't exists");
  assert.equal(h.sql.first('SELECT COUNT(*) AS n FROM application_images')!.n, 0);
});

test('images: size limit answers 400 with a message the UI can show', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const tooLarge = { error: 'Bad Request', errorCode: 400, errorDescription: 'image is too large (max 1.5 MiB)' };
  const big = new Uint8Array(1.5 * 1024 * 1024 + 1);
  big.set(PNG);
  let res = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('big.png', big) });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, tooLarge);
  const ok = new Uint8Array(1.5 * 1024 * 1024);
  ok.set(PNG);
  res = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('ok.png', ok) });
  assert.equal(res.status, 200);
  // far over the limit: refused while reading, not after (still 400, not 413)
  const huge = new Uint8Array(3 * 1024 * 1024);
  huge.set(PNG);
  res = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('huge.png', huge) });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, tooLarge);
  // with the limit switched off globally the image cap still applies
  const unlimited = await makeServer({ maxBodyBytes: 0 });
  const app2 = await createApp(unlimited, unlimited.admin, 'a');
  res = await unlimited.call('POST', `/application/${app2.id}/image`, { ...unlimited.admin, body: multipartBody('huge.png', huge) });
  assert.deepEqual(res.json, tooLarge);
  // a global limit below the image cap is the one that answers
  const small = await makeServer({ maxBodyBytes: 1000 });
  const app3 = await createApp(small, small.admin, 'a');
  res = await small.call('POST', `/application/${app3.id}/image`, { ...small.admin, body: multipartBody('ok.png', ok) });
  assert.equal(res.status, 413);
});

test('image URLs: only the allowed extensions are served, everything else is the JSON 404', async () => {
  const h = await makeServer();
  for (const path of ['/image/', '/image/nothing.png', '/image/x.txt', '/image/x', '/image/../etc.png', '/image/%zz.png']) {
    const res = await h.call('GET', path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.json, { error: 'Not Found', errorCode: 404, errorDescription: 'page not found' });
  }
  h.store.putImage('manual.svg', new TextEncoder().encode('<svg/>'));
  assert.equal((await h.call('GET', '/image/manual.svg')).status, 404);
});

test('images: the stored bytes are served unchanged', async () => {
  const h = await makeServer();
  const app = await createApp(h, h.admin, 'a');
  const bytes = new Uint8Array(5000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  bytes.set(PNG.subarray(0, 8));
  const up = await h.call('POST', `/application/${app.id}/image`, { ...h.admin, body: multipartBody('bin.png', bytes) });
  assert.equal(up.status, 200);
  const res = await h.server.handle(new Request(`https://gotify.example.com/${up.json.image}`));
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});
