// Small helpers of the Durable Object (worker.ts) that do not depend on the Workers runtime,
// so that they can be tested in Node.

import { SCHEMA_VERSION, type Sql } from './storage.ts';

/** Longest time an alarm is scheduled ahead; it only makes the maintenance run, which then reschedules. */
export const MAX_ALARM_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

/**
 * Closes a socket. Only 1000 and 3000-4999 are passed on (the other codes are reserved or may
 * not be sent in a close frame); anything else becomes 1000. If closing throws, 1000 is tried once more.
 */
export function closeSocket(ws: ClosableSocket, code: number, reason: string): void {
  const safe = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
  try {
    ws.close(safe, reason);
  } catch {
    try {
      ws.close(1000, reason);
    } catch {
      // already closed
    }
  }
}

/** Whether the tables of this schema version exist already (a cheap read instead of seven CREATE statements). */
export function schemaIsCurrent(sql: Sql): boolean {
  try {
    return sql.first<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'schema_version')?.value === SCHEMA_VERSION;
  } catch {
    return false; // the settings table does not exist yet
  }
}

const warned = new Set<string>();

/** Logs a warning once per isolate (the object is woken up often). */
export function warnOnce(key: string, message: string, log: (m: string) => void = console.warn): void {
  if (warned.has(key)) return;
  warned.add(key);
  log(message);
}

export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/**
 * Brings the alarm in line with the wanted time (null: none). The wanted time is at most 30 days ahead.
 * An alarm that is already earlier is kept, it will run the maintenance and schedule the next one itself.
 * Never throws: a scheduling problem must not fail a request or the start of the object.
 */
export async function syncAlarm(storage: AlarmStorage, wanted: number | null, now: number): Promise<void> {
  try {
    const current = await storage.getAlarm();
    if (wanted === null) {
      if (current !== null) await storage.deleteAlarm();
      return;
    }
    const next = Math.min(wanted, now + MAX_ALARM_AHEAD_MS);
    if (current === null || current > next) await storage.setAlarm(next);
  } catch (e) {
    console.error('could not schedule the maintenance alarm:', e instanceof Error ? e.message : String(e));
  }
}
