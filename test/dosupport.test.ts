import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_ALARM_AHEAD_MS, closeSocket, schemaIsCurrent, syncAlarm, warnOnce, type AlarmStorage } from '../src/dosupport.ts';
import { migrate } from '../src/storage.ts';
import { NodeSql } from './harness.ts';

test('closeSocket only sends valid close codes', () => {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const ws = { close: (c?: number, r?: string) => void closed.push([c, r]) };
  for (const code of [1000, 3000, 4000, 4999]) closeSocket(ws, code, 'r');
  assert.deepEqual(closed.map((c) => c[0]), [1000, 3000, 4000, 4999]);
  closed.length = 0;
  for (const code of [1005, 1006, 1015, 1001, 1011, 999, 2999, 5000, 0, -1, 1.5 * 1000, NaN]) closeSocket(ws, code, 'r');
  assert.deepEqual(closed.map((c) => c[0]), Array(12).fill(1000));
  assert.equal(closed[0]![1], 'r');
});

test('closeSocket retries once with 1000 and never throws', () => {
  const codes: number[] = [];
  const failsOnce = {
    close(c?: number) {
      codes.push(c!);
      if (codes.length === 1) throw new Error('invalid code');
    },
  };
  closeSocket(failsOnce, 4001, 'x');
  assert.deepEqual(codes, [4001, 1000]);
  const alwaysFails = {
    close(c?: number) {
      codes.push(c!);
      throw new Error('closed');
    },
  };
  codes.length = 0;
  assert.doesNotThrow(() => closeSocket(alwaysFails, 4001, 'x'));
  assert.deepEqual(codes, [4001, 1000]);
});

test('schemaIsCurrent: false before the migration, true after, false for another version', () => {
  const sql = new NodeSql();
  assert.equal(schemaIsCurrent(sql), false);
  migrate(sql);
  assert.equal(schemaIsCurrent(sql), true);
  sql.run('UPDATE settings SET value = ? WHERE key = ?', 'older', 'schema_version');
  assert.equal(schemaIsCurrent(sql), false);
  migrate(sql);
  assert.equal(schemaIsCurrent(sql), true);
});

test('warnOnce logs a key once', () => {
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  warnOnce('k1', 'first', log);
  warnOnce('k1', 'again', log);
  warnOnce('k2', 'other', log);
  assert.deepEqual(logs, ['first', 'other']);
});

function fakeStorage(initial: number | null, fail?: 'get' | 'set') {
  const calls: string[] = [];
  const st = {
    alarm: initial,
    calls,
    async getAlarm() {
      if (fail === 'get') throw new Error('boom');
      return st.alarm;
    },
    async setAlarm(t: number) {
      if (fail === 'set') throw new Error('Invalid time');
      calls.push(`set ${t}`);
      st.alarm = t;
    },
    async deleteAlarm() {
      calls.push('delete');
      st.alarm = null;
    },
  } satisfies AlarmStorage & { alarm: number | null; calls: string[] };
  return st;
}

test('syncAlarm clamps far-away times to 30 days ahead', async () => {
  const now = 1_700_000_000_000;
  const st = fakeStorage(null);
  await syncAlarm(st, now + 5000, now);
  assert.deepEqual(st.calls, [`set ${now + 5000}`]);
  const far = fakeStorage(null);
  await syncAlarm(far, 8.64e15, now);
  assert.deepEqual(far.calls, [`set ${now + MAX_ALARM_AHEAD_MS}`]);
  const inf = fakeStorage(null);
  await syncAlarm(inf, Infinity, now);
  assert.deepEqual(inf.calls, [`set ${now + MAX_ALARM_AHEAD_MS}`]);
});

test('syncAlarm keeps an earlier alarm, moves a later one, deletes when nothing is wanted', async () => {
  const now = 1_700_000_000_000;
  const earlier = fakeStorage(now + 1000);
  await syncAlarm(earlier, now + 9000, now);
  assert.deepEqual(earlier.calls, []);
  const later = fakeStorage(now + 9000);
  await syncAlarm(later, now + 1000, now);
  assert.deepEqual(later.calls, [`set ${now + 1000}`]);
  const none = fakeStorage(now + 1000);
  await syncAlarm(none, null, now);
  assert.deepEqual(none.calls, ['delete']);
  const nothing = fakeStorage(null);
  await syncAlarm(nothing, null, now);
  assert.deepEqual(nothing.calls, []);
});

test('syncAlarm never throws', async () => {
  const origError = console.error;
  const errors: unknown[][] = [];
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    await assert.doesNotReject(syncAlarm(fakeStorage(null, 'set'), Date.now() + 1000, Date.now()));
    await assert.doesNotReject(syncAlarm(fakeStorage(null, 'get'), Date.now() + 1000, Date.now()));
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 2);
});
