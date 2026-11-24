import { getSettingValue, upsertSettings } from '../db';

export const SPECIAL_PRICES_SETTING = 'special_price_events';
const MAX_EVENTS = 30;
const MAX_ITEMS_PER_EVENT = 200;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SpecialPriceItem { product_id: string; price: number }
export interface SpecialPriceEvent {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'weekly' | 'date';
  days: number[];
  date: string | null;
  start: string;
  end: string;
  items: SpecialPriceItem[];
  show_banner: boolean;
  show_on_buttons: boolean;
  manual_until: string | null;
}

export interface ActiveSpecialPrice { price: number; eventId: string; eventName: string }

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export function readSpecialPriceEvents(): SpecialPriceEvent[] {
  try {
    const parsed = JSON.parse(getSettingValue(SPECIAL_PRICES_SETTING) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Validates and normalises events sent from Settings; prices must be zero or more. */
export function normalizeSpecialPriceEvents(input: unknown, productExists: (id: string) => boolean): SpecialPriceEvent[] {
  if (!Array.isArray(input)) throw badRequest('Events must be a list');
  if (input.length > MAX_EVENTS) throw badRequest(`At most ${MAX_EVENTS} events`);
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, 40) : '';
    if (!name) throw badRequest(`Event ${index + 1} needs a name`);
    const id = typeof e.id === 'string' && /^[\w-]{1,40}$/.test(e.id) ? e.id : `ev-${Date.now().toString(36)}-${index}`;
    if (seen.has(id)) throw badRequest('Event ids must be unique');
    seen.add(id);
    const mode = e.mode === 'date' ? 'date' : 'weekly';
    const days = Array.isArray(e.days) ? [...new Set(e.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    const date = typeof e.date === 'string' && DATE_RE.test(e.date) ? e.date : null;
    if (mode === 'weekly' && days.length === 0) throw badRequest(`${name}: choose at least one day`);
    if (mode === 'date' && !date) throw badRequest(`${name}: choose a date`);
    const start = typeof e.start === 'string' && TIME_RE.test(e.start) ? e.start : '';
    const end = typeof e.end === 'string' && TIME_RE.test(e.end) ? e.end : '';
    if (!start || !end || start === end) throw badRequest(`${name}: set a start and end time`);
    const rawItems = Array.isArray(e.items) ? e.items : [];
    if (rawItems.length > MAX_ITEMS_PER_EVENT) throw badRequest(`${name}: at most ${MAX_ITEMS_PER_EVENT} drinks`);
    const itemIds = new Set<string>();
    const items = rawItems.map((rawItem) => {
      const it = (rawItem ?? {}) as Record<string, unknown>;
      const productId = typeof it.product_id === 'string' ? it.product_id : String(it.product_id ?? '');
      const price = Number(it.price);
      if (!productId || !productExists(productId)) throw badRequest(`${name}: a drink no longer exists on the menu`);
      if (!Number.isFinite(price) || price < 0 || price > 100000) throw badRequest(`${name}: enter a valid price`);
      if (itemIds.has(productId)) throw badRequest(`${name}: a drink is listed twice`);
      itemIds.add(productId);
      return { product_id: productId, price: Math.round(price * 100) / 100 };
    });
    const manualUntil = typeof e.manual_until === 'string' && Number.isFinite(Date.parse(e.manual_until)) ? new Date(e.manual_until).toISOString() : null;
    return {
      id, name, enabled: e.enabled !== false, mode, days, date, start, end, items,
      show_banner: e.show_banner !== false, show_on_buttons: e.show_on_buttons !== false, manual_until: manualUntil,
    };
  });
}

export function saveSpecialPriceEvents(events: SpecialPriceEvent[]): void {
  upsertSettings({ [SPECIAL_PRICES_SETTING]: JSON.stringify(events) });
}

function localParts(at: Date, timeZone: string): { date: string; day: number; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** True when the event runs at `at` in the store's timezone; overnight windows run into the next day. */
export function isEventActive(event: SpecialPriceEvent, at: Date, timeZone: string): boolean {
  if (!event.enabled) return false;
  if (event.manual_until && Date.parse(event.manual_until) > at.getTime()) return true;
  const { date, day, minutes } = localParts(at, timeZone);
  const start = toMinutes(event.start);
  const end = toMinutes(event.end);
  const overnight = end <= start;
  const startedToday = minutes >= start && (overnight || minutes < end);
  const carriedFromYesterday = overnight && minutes < end;
  if (event.mode === 'date') {
    return (startedToday && event.date === date) || (carriedFromYesterday && event.date === previousDate(date));
  }
  const yesterday = (day + 6) % 7;
  return (startedToday && event.days.includes(day)) || (carriedFromYesterday && event.days.includes(yesterday));
}

/** Lowest active event price per product, only where it is below the normal price. */
export function activeSpecialPrices(events: SpecialPriceEvent[], at: Date, timeZone: string, normalPrice: (productId: string) => number | null): Map<string, ActiveSpecialPrice> {
  const best = new Map<string, ActiveSpecialPrice>();
  for (const event of events) {
    if (!isEventActive(event, at, timeZone)) continue;
    for (const item of event.items) {
      const normal = normalPrice(item.product_id);
      if (normal === null || item.price >= normal) continue;
      const current = best.get(item.product_id);
      if (!current || item.price < current.price) best.set(item.product_id, { price: item.price, eventId: event.id, eventName: event.name });
    }
  }
  return best;
}
