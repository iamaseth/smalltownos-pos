/**
 * BackStreet: "popular first" menu order. Items are ranked by how many were sold in the last
 * 30 days. The ranking is worked out once a week (from Monday, restaurant time) and kept in
 * settings, so buttons don't move around every day and staff can remember where things are.
 */
import { getDatabase, getSettingValue, upsertSettings } from '../db';

type Db = ReturnType<typeof getDatabase>;

export const POPULARITY_SETTING = 'menu_popularity';
export const POPULARITY_DAYS = 30;
const REMOVED_ITEM_STATUSES = ['cancelled', 'voided', 'void_adjustment', 'refunded'];

export interface MenuPopularity {
  /** Monday (restaurant time) of the week this ranking is for, YYYY-MM-DD. */
  week: string;
  computedAt: string;
  days: number;
  /** Quantity sold per product id in the 30 days before computedAt; unsold items are absent. */
  sold: Record<string, number>;
}

/** Monday of the week containing `at`, in the given time zone, as YYYY-MM-DD. */
export function weekStart(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const offsets: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(local - (offsets[parts.weekday] ?? 0) * 86_400_000).toISOString().slice(0, 10);
}

function sqlTime(at: Date): string {
  return at.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/** Quantity sold per product in the `days` before `at`. Cancelled orders and removed items don't count. */
export function soldInLastDays(db: Db, at: Date, days = POPULARITY_DAYS): Record<string, number> {
  const from = sqlTime(new Date(at.getTime() - days * 86_400_000));
  const placeholders = REMOVED_ITEM_STATUSES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT oi.product_id AS id, SUM(oi.quantity) AS qty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.created_at >= ? AND oi.created_at <= ?
      AND o.status <> 'cancelled'
      AND COALESCE(oi.status, '') NOT IN (${placeholders})
    GROUP BY oi.product_id
  `).all(from, sqlTime(at), ...REMOVED_ITEM_STATUSES) as { id: string; qty: number }[];
  const sold: Record<string, number> = {};
  for (const row of rows) if (Number(row.qty) > 0) sold[String(row.id)] = Number(row.qty);
  return sold;
}

/** This week's ranking: the stored one if it is for this week, otherwise worked out now and stored. */
export function getMenuPopularity(db: Db, at: Date, timeZone: string): MenuPopularity {
  const week = weekStart(at, timeZone);
  try {
    const stored = JSON.parse(getSettingValue(POPULARITY_SETTING) || 'null') as MenuPopularity | null;
    if (stored && stored.week === week && stored.sold && typeof stored.sold === 'object') return stored;
  } catch { /* recompute below */ }
  const fresh: MenuPopularity = { week, computedAt: at.toISOString(), days: POPULARITY_DAYS, sold: soldInLastDays(db, at) };
  upsertSettings({ [POPULARITY_SETTING]: JSON.stringify(fresh) });
  return fresh;
}
