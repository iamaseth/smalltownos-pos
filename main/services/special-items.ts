/**
 * BackStreet: Special items. The cashier taps "Special", types what it is and the price, and
 * picks Kitchen or Bar. Behind the scenes each choice is a hidden menu item ("Special (kitchen)",
 * "Special (bar)") placed in a category the owner picks, so the ticket prints at the station
 * that category goes to and reports count it under that category.
 *
 * - Only these hidden items accept a typed name and price. A typed price on any other item is
 *   ignored by the server.
 * - Who may add one is the `orders.special-item` permission (on for owner, manager and cashier;
 *   change it in Staff → permissions).
 * - The hidden items carry the tag `special_item` and are left out of the menu grid.
 */
import { randomUUID } from 'crypto';
import { getDatabase, getSettingValue, now, upsertSettings } from '../db';

type Db = ReturnType<typeof getDatabase>;

export const SPECIAL_ITEM_TAG = 'special_item';
export const SPECIAL_ITEM_PERMISSION = 'orders.special-item';
export const SPECIAL_ITEM_MAX_PRICE = 10000;
export const SPECIAL_ITEM_MAX_NAME = 60;
const SETTING = 'special_items';
const NAMES = { kitchen: 'Special (kitchen)', bar: 'Special (bar)' } as const;

export type SpecialStation = 'kitchen' | 'bar';

interface StoredConfig {
  kitchen_category_id?: string | null;
  bar_category_id?: string | null;
  kitchen_product_id?: string | null;
  bar_product_id?: string | null;
}

export interface SpecialItemConfig {
  enabled: boolean;
  kitchen: { categoryId: string; productId: string; categoryName: string } | null;
  bar: { categoryId: string; productId: string; categoryName: string } | null;
}

function readStored(): StoredConfig {
  try {
    const parsed = JSON.parse(getSettingValue(SETTING) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function activeCategory(db: Db, id: unknown): { id: string; name: string } | null {
  if (typeof id !== 'string' || !id) return null;
  return (db.prepare(`SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL AND is_active = 1`).get(id) as { id: string; name: string } | undefined) ?? null;
}

function liveProduct(db: Db, id: unknown): { id: string; category_id: string | null } | null {
  if (typeof id !== 'string' || !id) return null;
  return (db.prepare(`SELECT id, category_id FROM products WHERE id = ? AND deleted_at IS NULL AND is_active = 1`).get(id) as { id: string; category_id: string | null } | undefined) ?? null;
}

export function getSpecialItemConfig(db: Db = getDatabase()): SpecialItemConfig {
  const stored = readStored();
  const side = (station: SpecialStation) => {
    const product = liveProduct(db, stored[`${station}_product_id`]);
    const category = product ? activeCategory(db, product.category_id) : null;
    return product && category ? { categoryId: category.id, productId: product.id, categoryName: category.name } : null;
  };
  const kitchen = side('kitchen');
  const bar = side('bar');
  return { enabled: Boolean(kitchen || bar), kitchen, bar };
}

/**
 * Put the hidden Special items in the chosen categories (making them the first time).
 * An empty category turns that side off.
 */
export function saveSpecialItemConfig(db: Db, input: { kitchen_category_id?: unknown; bar_category_id?: unknown }): SpecialItemConfig {
  const stored = readStored();
  const next: StoredConfig = { ...stored };
  const timestamp = now();
  for (const station of ['kitchen', 'bar'] as const) {
    const raw = input[`${station}_category_id`];
    const productKey = `${station}_product_id` as const;
    const existingId = typeof stored[productKey] === 'string' ? stored[productKey] : null;
    if (raw === undefined) continue;
    if (raw === null || raw === '') {
      if (existingId) db.prepare(`UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?`).run(timestamp, existingId);
      next[`${station}_category_id`] = null;
      continue;
    }
    const category = activeCategory(db, raw);
    if (!category) throw Object.assign(new Error('That category does not exist'), { statusCode: 400 });
    const existing = existingId
      ? db.prepare(`SELECT id FROM products WHERE id = ? AND deleted_at IS NULL`).get(existingId) as { id: string } | undefined
      : undefined;
    if (existing) {
      db.prepare(`UPDATE products SET category_id = ?, is_active = 1, updated_at = ? WHERE id = ?`).run(category.id, timestamp, existing.id);
    } else {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO products (id, category_id, name, description, price, cost, is_active, sort_order, track_inventory, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, 0, 1, 9999, 0, ?, ?, ?)
      `).run(id, category.id, NAMES[station], 'Used by the Special button. The cashier types the name and price.', JSON.stringify([SPECIAL_ITEM_TAG]), timestamp, timestamp);
      next[productKey] = id;
    }
    next[`${station}_category_id`] = category.id;
  }
  upsertSettings({ [SETTING]: JSON.stringify(next) });
  return getSpecialItemConfig(db);
}

export function isSpecialItemProduct(product: { tags?: unknown } | null | undefined): boolean {
  if (!product || product.tags == null) return false;
  try {
    const tags = typeof product.tags === 'string' ? JSON.parse(product.tags) : product.tags;
    return Array.isArray(tags) && tags.includes(SPECIAL_ITEM_TAG);
  } catch {
    return false;
  }
}

/**
 * The name and price typed for a Special item, or null for a normal line.
 * Throws a 400/403 error when the typed values are not allowed.
 */
export function specialItemOverride(
  product: { tags?: unknown },
  item: { custom_name?: unknown; custom_price?: unknown },
  canAdd: () => boolean,
): { name: string; price: number } | null {
  if (!isSpecialItemProduct(product)) return null;
  if (!canAdd()) throw Object.assign(new Error('You are not allowed to add special items'), { statusCode: 403 });
  const name = String(item?.custom_name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw Object.assign(new Error('Write what the special item is'), { statusCode: 400 });
  if (name.length > SPECIAL_ITEM_MAX_NAME) throw Object.assign(new Error(`Keep the name under ${SPECIAL_ITEM_MAX_NAME} letters`), { statusCode: 400 });
  const price = Number(item?.custom_price);
  if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('Enter a price for the special item'), { statusCode: 400 });
  if (price > SPECIAL_ITEM_MAX_PRICE) throw Object.assign(new Error('That price is too high for a special item'), { statusCode: 400 });
  return { name, price: Math.round(price * 100) / 100 };
}
