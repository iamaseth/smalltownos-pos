/**
 * BackStreet: the Register iPad (mini app next to the till).
 *
 * - Devices: the owner makes a link in Settings → Register iPad. The link carries a long random
 *   token; only its SHA-256 is kept (setting `mini_register_devices`). The iPad stores the token
 *   and sends it as "Authorization: Device <token>". Removing the device stops it at once.
 * - The device can only do what routes/mini.ts allows: see open tables, print a table's bill and
 *   add one of the 5 best-sellers. Those actions run as the staff account "Register iPad"
 *   (role server, no password or PIN anyone knows), so the order history says who did it.
 * - Printing: the iPad has no printer. Its print requests wait in a small queue (setting
 *   `mini_print_queue`) and the till on the computer with the printer picks them up and prints
 *   them with its normal bill / kitchen-ticket printing. This works on Railway and after the move.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { getDatabase, getSettingValue, now, upsertSettings, withTxn } from '../db';

type Db = ReturnType<typeof getDatabase>;

export const MINI_DEVICE_USER_ID = 'register-ipad';
const DEVICES = 'mini_register_devices';
const QUEUE = 'mini_print_queue';
const MAX_DEVICES = 5;
const CLAIM_SECONDS = 60;
const KEEP_DONE_SECONDS = 10 * 60;
const MAX_QUEUE = 100;

interface StoredDevice { id: string; name: string; token_hash: string; created_at: string; last_seen_at: string | null }
export interface DeviceInfo { id: string; name: string; created_at: string; last_seen_at: string | null }

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function readDevices(): StoredDevice[] {
  try {
    const parsed = JSON.parse(getSettingValue(DEVICES) || '[]');
    return Array.isArray(parsed) ? parsed.filter((d) => d && typeof d.token_hash === 'string') : [];
  } catch {
    return [];
  }
}

const publicDevice = (d: StoredDevice): DeviceInfo => ({ id: d.id, name: d.name, created_at: d.created_at, last_seen_at: d.last_seen_at });

export function listDevices(): DeviceInfo[] {
  return readDevices().map(publicDevice);
}

/** A new device link token. Returned once; only its hash is stored. */
export function createDevice(name: unknown): { device: DeviceInfo; token: string } {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Register iPad';
  const devices = readDevices();
  if (devices.length >= MAX_DEVICES) throw Object.assign(new Error(`At most ${MAX_DEVICES} devices. Remove one first.`), { statusCode: 400 });
  const token = randomBytes(32).toString('base64url');
  const device: StoredDevice = { id: randomUUID(), name: clean, token_hash: sha(token), created_at: now(), last_seen_at: null };
  upsertSettings({ [DEVICES]: JSON.stringify([...devices, device]) });
  ensureDeviceUser();
  return { device: publicDevice(device), token };
}

export function removeDevice(id: string): boolean {
  const devices = readDevices();
  const next = devices.filter((d) => d.id !== id);
  if (next.length === devices.length) return false;
  upsertSettings({ [DEVICES]: JSON.stringify(next) });
  return true;
}

/** The device for a token, or null. Constant-time compare; notes when it was last seen. */
export function authenticateDevice(token: unknown): DeviceInfo | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const hash = Buffer.from(sha(token), 'hex');
  const devices = readDevices();
  const match = devices.find((d) => {
    const stored = Buffer.from(d.token_hash, 'hex');
    return stored.length === hash.length && timingSafeEqual(stored, hash);
  });
  if (!match) return null;
  const last = match.last_seen_at ? Date.parse(`${match.last_seen_at.replace(' ', 'T')}Z`) : 0;
  if (!last || Date.now() - last > 60_000) {
    match.last_seen_at = now();
    upsertSettings({ [DEVICES]: JSON.stringify(devices) });
  }
  return publicDevice(match);
}

/** The staff account the device acts as. Made the first time; nobody can log in with it. */
export function ensureDeviceUser(db: Db = getDatabase()): string {
  const timestamp = now();
  const existing = db.prepare(`SELECT id, is_active FROM users WHERE id = ?`).get(MINI_DEVICE_USER_ID) as { id: string; is_active: number } | undefined;
  if (!existing) {
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, pin, pin_hash, is_active, created_at, updated_at)
      VALUES (?, 'Register iPad', 'register-ipad@device.local', ?, 'server', NULL, NULL, 1, ?, ?)
    `).run(MINI_DEVICE_USER_ID, `!device-only:${randomBytes(24).toString('hex')}`, timestamp, timestamp);
  } else if (!existing.is_active) {
    db.prepare(`UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?`).run(timestamp, MINI_DEVICE_USER_ID);
  }
  // A server can't make bills by default; the iPad prints them, so allow just that.
  for (const permission of ['bills.read', 'bills.generate']) {
    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES (?, ?, 'allow', ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(MINI_DEVICE_USER_ID, permission, MINI_DEVICE_USER_ID, timestamp, timestamp);
  }
  return MINI_DEVICE_USER_ID;
}

// ── Print queue ────────────────────────────────────────────────────────────

export type MiniPrintKind = 'receipt' | 'kot';
export interface MiniPrintRequest {
  id: string;
  kind: MiniPrintKind;
  label: string;
  payload: { billId?: number; orderId?: number; itemIds?: number[] };
  status: 'requested' | 'claimed' | 'done';
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
}

const age = (ts: string | null) => (ts ? (Date.now() - Date.parse(ts)) / 1000 : Number.POSITIVE_INFINITY);

function readQueue(): MiniPrintRequest[] {
  try {
    const parsed = JSON.parse(getSettingValue(QUEUE) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: MiniPrintRequest[]): void {
  const kept = queue
    .filter((r) => r.status !== 'done' || age(r.claimed_at) < KEEP_DONE_SECONDS)
    .slice(-MAX_QUEUE);
  upsertSettings({ [QUEUE]: JSON.stringify(kept) });
}

const sameTicket = (a: MiniPrintRequest['payload'], b: MiniPrintRequest['payload']) =>
  a.orderId === b.orderId && JSON.stringify(a.itemIds ?? []) === JSON.stringify(b.itemIds ?? []);

/**
 * Queue a print. A kitchen ticket for the same items is never queued twice (a repeated tap on the
 * iPad must not pour two beers); bills can be printed again on purpose.
 */
export function enqueuePrint(kind: MiniPrintKind, label: string, payload: MiniPrintRequest['payload']): MiniPrintRequest {
  return withTxn(() => {
    const queue = readQueue();
    if (kind === 'kot') {
      const existing = queue.find((r) => r.kind === 'kot' && sameTicket(r.payload, payload));
      if (existing) return existing;
    }
    const request: MiniPrintRequest = {
      id: randomUUID(), kind, label: label.slice(0, 80), payload, status: 'requested',
      created_at: new Date().toISOString(), claimed_at: null, claimed_by: null,
    };
    writeQueue([...queue, request]);
    return request;
  });
}

/** Requests waiting for the printer, oldest first. A claim older than a minute is offered again. */
export function waitingPrints(): MiniPrintRequest[] {
  return readQueue().filter((r) => r.status === 'requested' || (r.status === 'claimed' && age(r.claimed_at) > CLAIM_SECONDS));
}

/** Take one request to print. Only one till gets it; null if someone else already took it. */
export function claimPrint(id: string, claimer: string): MiniPrintRequest | null {
  return withTxn(() => {
    const queue = readQueue();
    const request = queue.find((r) => r.id === id);
    if (!request) return null;
    const free = request.status === 'requested' || (request.status === 'claimed' && age(request.claimed_at) > CLAIM_SECONDS);
    if (!free) return null;
    request.status = 'claimed';
    request.claimed_at = new Date().toISOString();
    request.claimed_by = claimer.slice(0, 80);
    writeQueue(queue);
    return request;
  });
}

export function finishPrint(id: string): boolean {
  return withTxn(() => {
    const queue = readQueue();
    const request = queue.find((r) => r.id === id);
    if (!request) return false;
    request.status = 'done';
    request.claimed_at = request.claimed_at ?? new Date().toISOString();
    writeQueue(queue);
    return true;
  });
}
