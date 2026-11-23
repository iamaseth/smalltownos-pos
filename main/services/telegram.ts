import { randomInt } from 'crypto';
import { getDatabase, now, upsertSettings } from '../db';
import type { TelegramReport, TelegramReportType } from './telegram-reports';

type Db = ReturnType<typeof getDatabase>;

export interface TelegramSchedule { weeklyDay: number; weeklyTime: string; dailyFallbackTime: string; pdf: boolean; csv: boolean }
export interface TelegramRecipient { id: number; chat_id: string; display_name: string; username: string | null; reports: TelegramReportType[]; is_active: number; created_at: string; approver_user_id: string | null }
export interface TelegramStatus { tokenConfigured: boolean; enabled: boolean; connected: boolean; botUsername: string | null; error: string | null; schedule: TelegramSchedule }

const DEFAULT_SCHEDULE: TelegramSchedule = { weeklyDay: 1, weeklyTime: '08:00', dailyFallbackTime: '10:00', pdf: true, csv: true };
const DEFAULT_REPORTS: TelegramReportType[] = ['daily', 'weekly'];
const VALID_REPORTS = new Set<TelegramReportType>(['daily', 'shift', 'weekly', 'low_stock', 'purchasing']);
const LINK_CODE_MINUTES = 15;
const MAX_ATTEMPTS = 4;
const RETRY_MINUTES = [1, 5, 15];
const TICK_MS = 60_000;
const MESSAGE_LIMIT = 4000;

function log(event: string, details: Record<string, unknown> = {}): void {
  console.info(`[Telegram] ${JSON.stringify({ event, ...details })}`);
}

function botToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? token : null;
}

function apiBase(): string {
  return (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
}

function setting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function redact(text: string): string {
  const token = botToken();
  return (token ? text.split(token).join('[token]') : text).slice(0, 300);
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function callApi<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs = 20_000): Promise<T> {
  const token = botToken();
  if (!token) throw new TelegramApiError('TELEGRAM_BOT_TOKEN is not set', false);
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: 'POST',
      ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TelegramApiError(redact(error instanceof Error ? error.message : 'network error'), true);
  }
  const data = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !data?.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new TelegramApiError(redact(data?.description || `HTTP ${response.status}`), retryable);
  }
  return data.result as T;
}

export function getSchedule(db: Db = getDatabase()): TelegramSchedule {
  try {
    const stored = JSON.parse(setting(db, 'telegram_schedule') || '{}') as Partial<TelegramSchedule>;
    return { ...DEFAULT_SCHEDULE, ...stored };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function saveSchedule(input: Partial<TelegramSchedule>, db: Db = getDatabase()): TelegramSchedule {
  const current = getSchedule(db);
  const next: TelegramSchedule = {
    weeklyDay: input.weeklyDay === undefined ? current.weeklyDay : Number(input.weeklyDay),
    weeklyTime: input.weeklyTime === undefined ? current.weeklyTime : String(input.weeklyTime),
    dailyFallbackTime: input.dailyFallbackTime === undefined ? current.dailyFallbackTime : String(input.dailyFallbackTime),
    pdf: input.pdf === undefined ? current.pdf : Boolean(input.pdf),
    csv: input.csv === undefined ? current.csv : Boolean(input.csv),
  };
  if (!Number.isInteger(next.weeklyDay) || next.weeklyDay < 0 || next.weeklyDay > 6) throw Object.assign(new Error('weeklyDay must be 0-6'), { statusCode: 400 });
  if (!TIME_RE.test(next.weeklyTime) || !TIME_RE.test(next.dailyFallbackTime)) throw Object.assign(new Error('times must be HH:MM'), { statusCode: 400 });
  upsertSettings({ telegram_schedule: JSON.stringify(next) });
  return next;
}

export function isEnabled(db: Db = getDatabase()): boolean {
  return setting(db, 'telegram_enabled') === 'true';
}

let lastStatus: { connected: boolean; botUsername: string | null; error: string | null } = { connected: false, botUsername: null, error: null };

export async function refreshStatus(db: Db = getDatabase()): Promise<TelegramStatus> {
  if (botToken() && isEnabled(db)) {
    try {
      const me = await callApi<{ username?: string }>('getMe', {});
      lastStatus = { connected: true, botUsername: me.username ?? null, error: null };
      upsertSettings({ telegram_bot_username: me.username ?? '' });
    } catch (error) {
      lastStatus = { connected: false, botUsername: setting(db, 'telegram_bot_username') || null, error: error instanceof Error ? error.message : 'unknown error' };
    }
  } else {
    lastStatus = { connected: false, botUsername: setting(db, 'telegram_bot_username') || null, error: null };
  }
  return { tokenConfigured: Boolean(botToken()), enabled: isEnabled(db), ...lastStatus, schedule: getSchedule(db) };
}

export async function setEnabled(enabled: boolean, db: Db = getDatabase()): Promise<TelegramStatus> {
  if (enabled && !botToken()) throw Object.assign(new Error('Add TELEGRAM_BOT_TOKEN to the server environment first'), { statusCode: 400 });
  upsertSettings({ telegram_enabled: enabled ? 'true' : 'false' });
  const status = await refreshStatus(db);
  if (enabled && !status.connected) {
    upsertSettings({ telegram_enabled: 'false' });
    throw Object.assign(new Error(`Could not reach the bot: ${status.error ?? 'unknown error'}`), { statusCode: 502 });
  }
  if (enabled) startTelegram(); else stopTelegram();
  return { ...status, enabled };
}

function parseRecipient(row: Omit<TelegramRecipient, 'reports'> & { reports: string }): TelegramRecipient {
  let reports: TelegramReportType[] = [];
  try { reports = (JSON.parse(row.reports) as string[]).filter((r): r is TelegramReportType => VALID_REPORTS.has(r as TelegramReportType)); } catch { reports = []; }
  return { ...row, reports };
}

export function listRecipients(db: Db = getDatabase()): TelegramRecipient[] {
  return (db.prepare('SELECT id, chat_id, display_name, username, reports, is_active, created_at, approver_user_id FROM telegram_recipients ORDER BY created_at').all() as Array<Omit<TelegramRecipient, 'reports'> & { reports: string }>).map(parseRecipient);
}

export function updateRecipient(id: number, input: { reports?: unknown; is_active?: unknown; display_name?: unknown; approver_user_id?: unknown }, db: Db = getDatabase()): TelegramRecipient {
  const current = listRecipients(db).find((r) => r.id === id);
  if (!current) throw Object.assign(new Error('Recipient not found'), { statusCode: 404 });
  const reports = Array.isArray(input.reports) ? [...new Set(input.reports.map(String))].filter((r): r is TelegramReportType => VALID_REPORTS.has(r as TelegramReportType)) : current.reports;
  const isActive = input.is_active === undefined ? current.is_active : (input.is_active ? 1 : 0);
  const name = typeof input.display_name === 'string' && input.display_name.trim() ? input.display_name.trim().slice(0, 80) : current.display_name;
  let approver = current.approver_user_id;
  if (input.approver_user_id !== undefined) {
    approver = input.approver_user_id ? String(input.approver_user_id) : null;
    const { isApprover } = require('./item-approvals') as typeof import('./item-approvals');
    if (approver && !isApprover(db, approver, 'void')) throw Object.assign(new Error('Only an active owner or manager can approve'), { statusCode: 400 });
  }
  db.prepare('UPDATE telegram_recipients SET reports = ?, is_active = ?, display_name = ?, approver_user_id = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(reports), isActive, name, approver, now(), id);
  return listRecipients(db).find((r) => r.id === id)!;
}

export function removeRecipient(id: number, db: Db = getDatabase()): void {
  const result = db.prepare('DELETE FROM telegram_recipients WHERE id = ?').run(id);
  if (result.changes === 0) throw Object.assign(new Error('Recipient not found'), { statusCode: 404 });
}

export function createLinkCode(createdBy: string, db: Db = getDatabase()): { code: string; expiresAt: string; botUsername: string | null } {
  const created = now();
  const expires = new Date(Date.now() + LINK_CODE_MINUTES * 60_000).toISOString();
  db.prepare('DELETE FROM telegram_link_codes WHERE expires_at < ? OR used_at IS NOT NULL').run(created);
  for (let i = 0; i < 5; i += 1) {
    const code = String(randomInt(100000, 1000000));
    const inserted = db.prepare('INSERT OR IGNORE INTO telegram_link_codes (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)').run(code, createdBy, created, expires);
    if (inserted.changes) return { code, expiresAt: expires, botUsername: setting(db, 'telegram_bot_username') || null };
  }
  throw new Error('Could not create a link code');
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number | string; type: string; first_name?: string; last_name?: string; title?: string; username?: string } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number | string } } };
}

// ---- Void / comp approvals ----

/** Sends Approve / Reject buttons to every active recipient linked to an approving manager. */
export async function sendApprovalRequest(requestId: number, db: Db = getDatabase()): Promise<number> {
  const approvals = require('./item-approvals') as typeof import('./item-approvals');
  const row = approvals.getRequest(db, requestId);
  if (!row || row.status !== 'pending' || !botToken() || !isEnabled(db)) return 0;
  const targets = listRecipients(db).filter((r) => r.is_active && approvals.isApprover(db, r.approver_user_id, row.action));
  const text = approvals.describeRequest(db, row);
  const sent: { chat_id: string; message_id: number }[] = [];
  for (const target of targets) {
    try {
      const msg = await callApi<{ message_id: number }>('sendMessage', {
        chat_id: target.chat_id, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `ap:${row.id}:y` }, { text: '❌ Reject', callback_data: `ap:${row.id}:n` }]] },
      });
      sent.push({ chat_id: target.chat_id, message_id: msg.message_id });
    } catch (error) {
      log('approval_send_failed', { error: error instanceof Error ? redact(error.message) : 'unknown' });
    }
  }
  db.prepare('UPDATE item_approval_requests SET telegram_messages = ? WHERE id = ?').run(JSON.stringify(sent), row.id);
  return sent.length;
}

export function approverCount(action: 'void' | 'comp', db: Db = getDatabase()): number {
  if (!botToken() || !isEnabled(db)) return 0;
  const { isApprover } = require('./item-approvals') as typeof import('./item-approvals');
  return listRecipients(db).filter((r) => r.is_active && isApprover(db, r.approver_user_id, action)).length;
}

/** Updates the manager messages once a request is decided, cancelled or used. */
export async function closeApprovalMessages(requestId: number, outcome: string, db: Db = getDatabase()): Promise<void> {
  const approvals = require('./item-approvals') as typeof import('./item-approvals');
  const row = approvals.getRequest(db, requestId);
  if (!row || !botToken()) return;
  let messages: { chat_id: string; message_id: number }[] = [];
  try { messages = JSON.parse(row.telegram_messages || '[]'); } catch { messages = []; }
  const text = `${approvals.describeRequest(db, row)}\n\n${outcome}`;
  for (const m of messages) {
    await callApi('editMessageText', { chat_id: m.chat_id, message_id: m.message_id, text, parse_mode: 'HTML' }).catch(() => undefined);
  }
}

async function handleApprovalCallback(query: NonNullable<TelegramUpdate['callback_query']>, db: Db): Promise<'ignored' | 'rejected' | 'linked'> {
  const match = /^ap:(\d+):([yn])$/.exec(query.data || '');
  const chatId = query.message ? String(query.message.chat.id) : '';
  if (!match || !chatId) return 'ignored';
  const approvals = require('./item-approvals') as typeof import('./item-approvals');
  const recipient = listRecipients(db).find((r) => r.chat_id === chatId && r.is_active);
  const approve = match[2] === 'y';
  const result = recipient?.approver_user_id
    ? approvals.decideRequest(db, Number(match[1]), recipient.approver_user_id, approve)
    : { ok: false, reason: 'not allowed' as string | undefined };
  if (!result.ok) {
    await callApi('answerCallbackQuery', { callback_query_id: query.id, text: result.reason === 'not allowed' ? 'You are not set up to approve.' : `This request is ${result.reason}.` }).catch(() => undefined);
    return 'rejected';
  }
  const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(recipient!.approver_user_id) as { name?: string } | undefined)?.name || 'manager';
  const stamp = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: (require('../routes/cash-closures') as typeof import('../routes/cash-closures')).tenantTimezone() }).format(new Date());
  await callApi('answerCallbackQuery', { callback_query_id: query.id, text: approve ? 'Approved' : 'Rejected' }).catch(() => undefined);
  await closeApprovalMessages(Number(match[1]), approve ? `✅ Approved by ${name} · ${stamp}` : `❌ Rejected by ${name} · ${stamp}`, db);
  log(approve ? 'approval_granted' : 'approval_rejected');
  return 'linked';
}

export async function handleUpdate(update: TelegramUpdate, db: Db = getDatabase()): Promise<'linked' | 'rejected' | 'ignored'> {
  if (update.callback_query) return handleApprovalCallback(update.callback_query, db);
  const message = update.message;
  if (!message?.text || !message.chat) return 'ignored';
  const chatId = String(message.chat.id);
  const match = /^\/start(?:@\w+)?\s+(\d{6})\s*$/.exec(message.text.trim());
  if (!match) {
    if (message.text.trim().startsWith('/')) {
      await callApi('sendMessage', { chat_id: chatId, text: 'This bot only sends reports to staff registered in the POS. Ask an administrator for a link code.' }).catch(() => undefined);
      return 'rejected';
    }
    return 'ignored';
  }
  const code = db.prepare('SELECT code, created_by, expires_at, used_at FROM telegram_link_codes WHERE code = ?').get(match[1]) as { code: string; created_by: string | null; expires_at: string; used_at: string | null } | undefined;
  if (!code || code.used_at || code.expires_at < now()) {
    await callApi('sendMessage', { chat_id: chatId, text: 'That code is not valid or has expired. Ask an administrator for a new one.' }).catch(() => undefined);
    return 'rejected';
  }
  const name = [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || message.chat.title || message.chat.username || `Chat ${chatId}`;
  const timestamp = now();
  db.transaction(() => {
    db.prepare('UPDATE telegram_link_codes SET used_at = ?, used_chat_id = ? WHERE code = ?').run(timestamp, chatId, code.code);
    db.prepare(`
      INSERT INTO telegram_recipients (chat_id, display_name, username, reports, is_active, linked_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET is_active = 1, display_name = excluded.display_name, username = excluded.username, updated_at = excluded.updated_at
    `).run(chatId, name.slice(0, 80), message.chat.username ?? null, JSON.stringify(DEFAULT_REPORTS), code.created_by, timestamp, timestamp);
  })();
  await callApi('sendMessage', { chat_id: chatId, text: 'Connected. You will receive the reports chosen for you in the POS settings.' }).catch(() => undefined);
  log('recipient_linked');
  return 'linked';
}

// ---- Delivery queue ----

function localNow(at: Date): { date: string; time: string; weekday: number } {
  const tz = (require('../routes/cash-closures') as typeof import('../routes/cash-closures')).tenantTimezone();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(at).reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

export function enqueueReport(reportType: TelegramReportType, params: Record<string, unknown>, dedupeBase: string, title: string, db: Db = getDatabase()): number {
  if (!isEnabled(db) || !botToken()) return 0;
  const recipients = listRecipients(db).filter((r) => r.is_active && r.reports.includes(reportType));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO telegram_deliveries (recipient_id, chat_id, report_type, dedupe_key, title, params, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  let queued = 0;
  const timestamp = now();
  for (const r of recipients) queued += insert.run(r.id, r.chat_id, reportType, `${dedupeBase}|${r.chat_id}`, title, JSON.stringify(params), timestamp, timestamp).changes;
  if (queued) scheduleProcessing();
  return queued;
}

function buildReport(db: Db, reportType: string, params: Record<string, unknown>): TelegramReport {
  const reports = require('./telegram-reports') as typeof import('./telegram-reports');
  const schedule = getSchedule(db);
  const options = { pdf: schedule.pdf, csv: schedule.csv };
  switch (reportType) {
    case 'daily': return reports.buildDailyReport(db, String(params.businessDate), options);
    case 'weekly': return reports.buildWeeklyManagementReport(db, String(params.weekStart), options);
    case 'shift': return reports.buildShiftReport(db, Number(params.sessionId), params.event === 'open' ? 'open' : params.event === 'envelope' ? 'envelope' : 'close');
    case 'low_stock': return reports.buildLowStockAlert(db, (params.names as string[]) ?? []);
    case 'purchasing': return reports.buildPurchasingReport(db, String(params.startDate), String(params.endDate), options);
    case 'period': return reports.buildPeriodReport(db, String(params.startDate), String(params.endDate), options);
    case 'test': return { title: 'Test message', attachments: [], html: '<b>Test message</b>\nTelegram reports are connected to the POS.' };
    case 'printout': return buildPrintout(params);
    default: throw new Error(`unknown report type ${reportType}`);
  }
}

function splitMessage(html: string): string[] {
  if (html.length <= MESSAGE_LIMIT) return [html];
  const parts: string[] = [];
  let current = '';
  for (const block of html.split('\n')) {
    if ((current + '\n' + block).length > MESSAGE_LIMIT && current) { parts.push(current); current = ''; }
    current = current ? `${current}\n${block}` : block;
  }
  if (current) parts.push(current);
  return parts;
}

async function sendReport(chatId: string, report: TelegramReport): Promise<void> {
  for (const part of report.parts ?? splitMessage(report.html)) {
    await callApi('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true });
  }
  for (const file of report.attachments) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.filename);
    await callApi('sendDocument', form, 60_000);
  }
}

let processing: Promise<void> | null = null;
let processTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleProcessing(): void {
  if (processTimer || stopped) return;
  processTimer = setTimeout(() => { processTimer = null; void processQueue().catch(() => undefined); }, 0);
  processTimer.unref?.();
}

export function processQueue(db: Db = getDatabase()): Promise<void> {
  if (processing) return processing;
  processing = (async () => {
    const due = db.prepare(`SELECT id, chat_id, report_type, params, attempts FROM telegram_deliveries WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 20`)
      .all(now()) as { id: number; chat_id: string; report_type: string; params: string; attempts: number }[];
    const cache = new Map<string, TelegramReport>();
    for (const delivery of due) {
      if (stopped && !testMode) break;
      try {
        const key = `${delivery.report_type}|${delivery.params}`;
        let report = cache.get(key);
        if (!report) { report = buildReport(db, delivery.report_type, JSON.parse(delivery.params || '{}')); cache.set(key, report); }
        await sendReport(delivery.chat_id, report);
        db.prepare(`UPDATE telegram_deliveries SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL, title = ? WHERE id = ?`).run(now(), report.title, delivery.id);
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const retryable = !(error instanceof TelegramApiError) || error.retryable;
        const message = error instanceof Error ? redact(error.message) : 'unknown error';
        if (retryable && attempts < MAX_ATTEMPTS) {
          const next = new Date(Date.now() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60_000).toISOString();
          db.prepare(`UPDATE telegram_deliveries SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, message, next, delivery.id);
        } else {
          db.prepare(`UPDATE telegram_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`).run(attempts, message, delivery.id);
        }
        log('delivery_failed', { id: delivery.id, attempts, retryable, error: message });
      }
    }
  })().finally(() => { processing = null; });
  return processing;
}

export function listDeliveries(limit = 20, db: Db = getDatabase()) {
  return db.prepare(`
    SELECT d.id, d.report_type, d.title, d.status, d.attempts, d.last_error, d.created_at, d.sent_at, COALESCE(r.display_name, d.chat_id) AS recipient
    FROM telegram_deliveries d LEFT JOIN telegram_recipients r ON r.id = d.recipient_id
    ORDER BY d.id DESC LIMIT ?
  `).all(limit);
}

export async function sendTest(recipientId: number | null, db: Db = getDatabase()): Promise<number> {
  const targets = listRecipients(db).filter((r) => r.is_active && (recipientId === null || r.id === recipientId));
  if (!targets.length) throw Object.assign(new Error('No active recipients'), { statusCode: 400 });
  const insert = db.prepare(`INSERT INTO telegram_deliveries (recipient_id, chat_id, report_type, dedupe_key, title, params, status, created_at, next_attempt_at) VALUES (?, ?, 'test', ?, 'Test message', '{}', 'pending', ?, ?)`);
  const timestamp = now();
  for (const t of targets) insert.run(t.id, t.chat_id, `test|${Date.now()}|${randomInt(1e9)}|${t.chat_id}`, timestamp, timestamp);
  await processQueue(db);
  return targets.length;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OnDemandKind = 'daily' | 'weekly' | 'period';

export function onDemandKind(startDate: string, endDate: string): OnDemandKind {
  if (startDate === endDate) return 'daily';
  const isMonday = new Date(`${startDate}T12:00:00Z`).getUTCDay() === 1;
  return isMonday && endDate === shiftIso(startDate, 6) ? 'weekly' : 'period';
}

export async function sendReportNow(startDate: string, endDate: string, recipientIds: number[], db: Db = getDatabase()) {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || startDate > endDate) throw Object.assign(new Error('Choose a valid date range'), { statusCode: 400 });
  if ((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 > 366) throw Object.assign(new Error('The range cannot be longer than a year'), { statusCode: 400 });
  if (!isEnabled(db) || !botToken()) throw Object.assign(new Error('Telegram is not connected'), { statusCode: 400 });
  const ids = new Set(recipientIds.map(Number));
  const targets = listRecipients(db).filter((r) => r.is_active && ids.has(r.id));
  if (!targets.length) throw Object.assign(new Error('Choose at least one active recipient'), { statusCode: 400 });
  const kind = onDemandKind(startDate, endDate);
  const params = kind === 'daily' ? { businessDate: startDate } : kind === 'weekly' ? { weekStart: startDate } : { startDate, endDate };
  const insert = db.prepare(`INSERT INTO telegram_deliveries (recipient_id, chat_id, report_type, dedupe_key, title, params, status, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
  const timestamp = now();
  const batch = `manual|${kind}|${startDate}|${endDate}|${Date.now()}|${randomInt(1e9)}`;
  const deliveryIds = targets.map((t) => Number(insert.run(t.id, t.chat_id, kind, `${batch}|${t.chat_id}`, `${kind} ${startDate} ${endDate}`, JSON.stringify(params), timestamp, timestamp).lastInsertRowid));
  await processQueue(db);
  const rows = db.prepare(`SELECT status, title FROM telegram_deliveries WHERE id IN (${deliveryIds.map(() => '?').join(',')})`).all(...deliveryIds) as { status: string; title: string }[];
  return {
    kind,
    title: rows[0]?.title ?? '',
    sent: rows.filter((r) => r.status === 'sent').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    failed: rows.filter((r) => r.status === 'failed').length,
  };
}

/** X/Z/daily printouts as monospace blocks, laid out exactly like the 80 mm paper copy. */
function buildPrintout(params: Record<string, unknown>): TelegramReport {
  const text = require('../../shared/print/shift-report-text') as typeof import('../../shared/print/shift-report-text');
  const data = require('./shift-report') as typeof import('./shift-report');
  const tz = (require('../routes/cash-closures') as typeof import('../routes/cash-closures')).tenantTimezone();
  const lines = params.kind === 'daily'
    ? text.renderDailyReport(data.buildDailyReport(String(params.businessDate)), 42, tz)
    : text.renderShiftReport(data.buildShiftReport(Number(params.sessionId)), 42, tz);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts: string[] = [];
  let block: string[] = [];
  for (const line of lines) {
    if (block.join('\n').length + line.length > 3500) { parts.push(`<pre>${esc(block.join('\n'))}</pre>`); block = []; }
    block.push(line);
  }
  if (block.length) parts.push(`<pre>${esc(block.join('\n'))}</pre>`);
  return { title: String(params.title || 'Report'), attachments: [], html: parts.join('\n'), parts };
}

/** Sends a printout to every active recipient now (manual send; not a scheduled subscription). */
export async function sendPrintoutNow(params: { kind: 'shift'; sessionId: number } | { kind: 'daily'; businessDate: string }, title: string, db: Db = getDatabase()) {
  if (!isEnabled(db) || !botToken()) throw Object.assign(new Error('Telegram is not connected'), { statusCode: 400 });
  const targets = listRecipients(db).filter((r) => r.is_active);
  if (!targets.length) throw Object.assign(new Error('No active Telegram recipients'), { statusCode: 400 });
  const insert = db.prepare(`INSERT INTO telegram_deliveries (recipient_id, chat_id, report_type, dedupe_key, title, params, status, created_at, next_attempt_at) VALUES (?, ?, 'printout', ?, ?, ?, 'pending', ?, ?)`);
  const timestamp = now();
  const batch = `printout|${params.kind}|${'sessionId' in params ? params.sessionId : params.businessDate}|${Date.now()}|${randomInt(1e9)}`;
  const ids = targets.map((t) => Number(insert.run(t.id, t.chat_id, `${batch}|${t.chat_id}`, title, JSON.stringify({ ...params, title }), timestamp, timestamp).lastInsertRowid));
  await processQueue(db);
  const rows = db.prepare(`SELECT status FROM telegram_deliveries WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { status: string }[];
  return { sent: rows.filter((r) => r.status === 'sent').length, pending: rows.filter((r) => r.status === 'pending').length, failed: rows.filter((r) => r.status === 'failed').length };
}

// ---- Events and schedule ----

export function notifyTelegram(event: 'day_close' | 'shift_open' | 'shift_close' | 'shift_envelope', params: { businessDate?: string; sessionId?: number }): void {
  try {
    const db = getDatabase();
    if (!isEnabled(db) || !botToken()) return;
    if (event === 'day_close' && params.businessDate) {
      enqueueReport('daily', { businessDate: params.businessDate }, `daily|${params.businessDate}`, `Daily summary ${params.businessDate}`, db);
    } else if (event === 'shift_envelope' && params.sessionId) {
      // Only needed when the closing report already went out without the photo.
      const sent = db.prepare(`SELECT 1 FROM telegram_deliveries WHERE dedupe_key LIKE ? AND status = 'sent' LIMIT 1`)
        .get(`shift|${params.sessionId}|close%`);
      if (sent) enqueueReport('shift', { sessionId: params.sessionId, event: 'envelope' }, `shift|${params.sessionId}|envelope`, 'Envelope photo', db);
    } else if ((event === 'shift_open' || event === 'shift_close') && params.sessionId) {
      const kind = event === 'shift_open' ? 'open' : 'close';
      enqueueReport('shift', { sessionId: params.sessionId, event: kind }, `shift|${params.sessionId}|${kind}`, `Shift ${kind}`, db);
    }
  } catch (error) {
    log('notify_failed', { event, error: error instanceof Error ? redact(error.message) : 'unknown' });
  }
}

function shiftIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `now` is injectable so schedule tests do not depend on the real day and time. */
export function runScheduledChecks(db: Db = getDatabase(), now: Date = new Date()): void {
  if (!isEnabled(db) || !botToken()) return;
  const schedule = getSchedule(db);
  const local = localNow(now);
  const reports = require('./telegram-reports') as typeof import('./telegram-reports');
  const businessToday = reports.currentBusinessDate(db, now);

  if (local.time >= schedule.dailyFallbackTime) {
    const yesterday = shiftIso(businessToday, -1);
    const closed = db.prepare(`SELECT 1 FROM cash_closures WHERE scope = 'day' AND business_date = ?`).get(yesterday);
    if (!closed) enqueueReport('daily', { businessDate: yesterday }, `daily|${yesterday}`, `Daily summary ${yesterday}`, db);
  }
  if (local.weekday === schedule.weeklyDay && local.time >= schedule.weeklyTime) {
    const thisMonday = shiftIso(local.date, -((local.weekday + 6) % 7));
    const lastWeekStart = shiftIso(thisMonday, -7);
    enqueueReport('weekly', { weekStart: lastWeekStart }, `weekly|${lastWeekStart}`, `Weekly report ${lastWeekStart}`, db);
    enqueueReport('purchasing', { startDate: lastWeekStart, endDate: shiftIso(lastWeekStart, 6) }, `purchasing|${lastWeekStart}`, `Purchasing ${lastWeekStart}`, db);
  }

  const low = (require('./supplies') as typeof import('./supplies')).listSupplies(db, { lowStockOnly: true });
  let alerted: { date: string; ids: string[] } = { date: '', ids: [] };
  try { alerted = JSON.parse(setting(db, 'telegram_low_stock_alerted') || '{"date":"","ids":[]}'); } catch { alerted = { date: '', ids: [] }; }
  const already = new Set(alerted.date === businessToday ? alerted.ids : []);
  const fresh = low.filter((s) => !already.has(s.id));
  if (fresh.length) {
    const ids = fresh.map((s) => s.id).sort();
    enqueueReport('low_stock', { names: fresh.map((s) => s.name) }, `low|${businessToday}|${ids.join(',')}`, `Low stock (${fresh.length})`, db);
    upsertSettings({ telegram_low_stock_alerted: JSON.stringify({ date: businessToday, ids: [...already, ...ids] }) });
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let pollAbort: AbortController | null = null;
let stopped = true;
let testMode = false;

export function setTelegramTestMode(on: boolean): void { testMode = on; }

async function pollLoop(): Promise<void> {
  while (!stopped) {
    const db = getDatabase();
    const offset = Number(setting(db, 'telegram_update_offset') || 0);
    try {
      pollAbort = new AbortController();
      const token = botToken();
      if (!token) return;
      const response = await fetch(`${apiBase()}/bot${token}/getUpdates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }),
        signal: AbortSignal.any([pollAbort.signal, AbortSignal.timeout(35_000)]),
      });
      const data = await response.json() as { ok: boolean; result?: TelegramUpdate[] };
      for (const update of data.result ?? []) {
        upsertSettings({ telegram_update_offset: String(update.update_id + 1) });
        await handleUpdate(update, db).catch(() => undefined);
      }
    } catch {
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 15_000).unref?.());
    }
  }
}

export function startTelegram(): void {
  try {
    const db = getDatabase();
    if (!botToken() || !isEnabled(db) || !stopped) return;
    stopped = false;
    tickTimer = setInterval(() => {
      try { runScheduledChecks(); } catch (error) { log('schedule_failed', { error: error instanceof Error ? redact(error.message) : 'unknown' }); }
      void processQueue().catch(() => undefined);
    }, TICK_MS);
    tickTimer.unref?.();
    void pollLoop();
    void refreshStatus(db).catch(() => undefined);
    log('started');
  } catch (error) {
    log('start_failed', { error: error instanceof Error ? redact(error.message) : 'unknown' });
  }
}

export function stopTelegram(): void {
  stopped = true;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  if (processTimer) clearTimeout(processTimer);
  processTimer = null;
  pollAbort?.abort();
  pollAbort = null;
}
