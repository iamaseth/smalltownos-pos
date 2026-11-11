import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import {
  SupplyUnit,
  assertSupplyUnit,
  convertQuantity,
  roundQuantity,
} from './units';
import { applySupplyStockChange } from './supplies';

export class RecipeServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RecipeServiceError';
    this.statusCode = statusCode;
  }
}

export interface RecipeComponent {
  /** Set when the line means any ingredient in this group; supply_id is then the one being used now. */
  group_name: string | null;
  supply_id: string;
  supply_name: string;
  base_unit: SupplyUnit;
  quantity: number;
  unit: SupplyUnit;
  quantity_in_base: number;
  unit_cost: number | null;
}

export interface RecipeSnapshot {
  recipe_id: string;
  product_id: string;
  yield_quantity: number;
  /** Scaled amounts for this order item quantity, already in each supply's base unit. */
  components: {
    supply_id: string;
    supply_name: string;
    base_unit: SupplyUnit;
    quantity: number;
  }[];
}

export interface RecipeRecord {
  id: string;
  product_id: string;
  product_name: string | null;
  yield_quantity: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  items: RecipeComponent[];
  selling_price: number | null;
  cost_per_serving: number | null;
  cost_complete: boolean;
  missing_cost_supplies: string[];
  margin: number | null;
  margin_percent: number | null;
}

type RecipeRow = Omit<RecipeRecord, 'items' | 'selling_price' | 'cost_per_serving' | 'cost_complete' | 'missing_cost_supplies' | 'margin' | 'margin_percent'> & {
  product_name: string | null;
  selling_price: number | null;
};

export interface SaveRecipeInput {
  productId: string;
  yieldQuantity?: number;
  isActive?: boolean;
  items: { supplyId?: string; supply_id?: string; groupName?: string; group_name?: string; quantity: number; unit: string }[];
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function assertPositiveFinite(value: unknown, field: string): number {
  const quantity = typeof value === 'string' ? Number(value) : value;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    throw new RecipeServiceError(400, `${field} must be a finite number`);
  }
  if (quantity <= 0) {
    throw new RecipeServiceError(400, `${field} must be greater than zero`);
  }
  return quantity;
}

export interface GroupMember {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  unit_cost: number | null;
  stock_quantity: number;
  group_name: string;
}

/** Items in a group in the order they are used: stock on hand first, oldest delivery first. */
export function groupMembersInUseOrder(db: ReturnType<typeof getDatabase>, groupName: string): GroupMember[] {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.base_unit, s.unit_cost, s.stock_quantity, s.group_name,
      COALESCE((SELECT MAX(m.created_at) FROM supply_movements m WHERE m.supply_id = s.id AND m.movement_type = 'receive'), s.created_at) AS last_in
    FROM supplies s
    WHERE s.deleted_at IS NULL AND s.is_active = 1 AND s.group_name = ? COLLATE NOCASE
  `).all(groupName) as Array<GroupMember & { last_in: string }>;
  const byAge = (a: { last_in: string; name: string }, b: { last_in: string; name: string }) =>
    a.last_in.localeCompare(b.last_in) || a.name.localeCompare(b.name);
  const inStock = rows.filter((r) => Number(r.stock_quantity) > 0).sort(byAge);
  const empty = rows.filter((r) => Number(r.stock_quantity) <= 0).sort((a, b) => byAge(b, a));
  return [...inStock, ...empty].map(({ last_in: _lastIn, ...member }) => member);
}

function loadRecipeItems(db: ReturnType<typeof getDatabase>, recipeId: string): RecipeComponent[] {
  const rows = db.prepare(`
    SELECT
      ri.group_name,
      ri.supply_id,
      s.name AS supply_name,
      s.base_unit,
      s.unit_cost,
      ri.quantity,
      ri.unit
    FROM recipe_items ri
    JOIN supplies s ON s.id = ri.supply_id
    WHERE ri.recipe_id = ?
    ORDER BY ri.created_at, ri.id
  `).all(recipeId) as {
    group_name: string | null;
    supply_id: string;
    supply_name: string;
    base_unit: SupplyUnit;
    unit_cost: number | null;
    quantity: number;
    unit: SupplyUnit;
  }[];
  return rows.map((row) => {
    const current = row.group_name ? groupMembersInUseOrder(db, row.group_name)[0] : undefined;
    const resolved = current
      ? { ...row, supply_id: current.id, supply_name: current.name, base_unit: current.base_unit, unit_cost: current.unit_cost }
      : row;
    return {
      ...resolved,
      quantity_in_base: convertQuantity(resolved.quantity, resolved.unit, resolved.base_unit),
    };
  });
}

function withCosting(db: ReturnType<typeof getDatabase>, row: RecipeRow): RecipeRecord {
  const items = loadRecipeItems(db, row.id);
  const missing = items.filter((item) => item.unit_cost === null).map((item) => item.supply_name);
  const total = items.reduce((sum, item) => sum + (item.unit_cost === null ? 0 : item.quantity_in_base * Number(item.unit_cost)), 0);
  const complete = missing.length === 0 && items.length > 0;
  const costPerServing = items.length === 0 ? null : Number((total / row.yield_quantity).toFixed(6));
  const price = row.selling_price === null || row.selling_price === undefined ? null : Number(row.selling_price);
  const margin = complete && costPerServing !== null && price !== null ? Number((price - costPerServing).toFixed(6)) : null;
  const marginPercent = margin !== null && price !== null && price > 0 ? Number(((margin / price) * 100).toFixed(2)) : null;
  return {
    ...row,
    items,
    selling_price: price,
    cost_per_serving: costPerServing,
    cost_complete: complete,
    missing_cost_supplies: missing,
    margin,
    margin_percent: marginPercent,
  };
}

export function getRecipeByProduct(db: ReturnType<typeof getDatabase>, productId: string): RecipeRecord | null {
  const row = db.prepare(`
    SELECT r.*, p.name AS product_name, p.price AS selling_price
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.product_id = ?
  `).get(productId) as RecipeRow | undefined;
  if (!row) return null;
  return withCosting(db, row);
}

export function getRecipe(db: ReturnType<typeof getDatabase>, id: string): RecipeRecord | null {
  const row = db.prepare(`
    SELECT r.*, p.name AS product_name, p.price AS selling_price
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.id = ?
  `).get(id) as RecipeRow | undefined;
  if (!row) return null;
  return withCosting(db, row);
}

export function listRecipes(db: ReturnType<typeof getDatabase>): RecipeRecord[] {
  const rows = db.prepare(`
    SELECT r.*, p.name AS product_name, p.price AS selling_price
    FROM recipes r
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY p.name COLLATE NOCASE
  `).all() as RecipeRow[];
  return rows.map((row) => withCosting(db, row));
}

export function saveRecipe(db: ReturnType<typeof getDatabase>, input: SaveRecipeInput): RecipeRecord {
  const productId = String(input.productId || '').trim();
  if (!productId) throw new RecipeServiceError(400, 'product_id is required');
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) throw new RecipeServiceError(404, 'Product not found');

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new RecipeServiceError(400, 'items must contain at least one supply');
  }

  const seenSupplies = new Set<string>();
  const normalizedItems: { supplyId: string; groupName: string | null; quantity: number; unit: SupplyUnit }[] = [];
  for (const item of input.items) {
    const requestedGroup = String(item?.group_name || item?.groupName || '').trim();
    let supplyId: string;
    let groupName: string | null = null;
    let baseUnit: SupplyUnit;
    if (requestedGroup) {
      const members = groupMembersInUseOrder(db, requestedGroup);
      if (members.length === 0) throw new RecipeServiceError(404, `Group ${requestedGroup} has no ingredients`);
      groupName = members[0].group_name;
      supplyId = members[0].id;
      baseUnit = members[0].base_unit;
    } else {
      supplyId = String(item?.supply_id || item?.supplyId || '').trim();
      if (!supplyId) throw new RecipeServiceError(400, 'each item requires a supply_id');
      const supply = db.prepare('SELECT id, base_unit FROM supplies WHERE id = ? AND deleted_at IS NULL').get(supplyId) as
        | { id: string; base_unit: SupplyUnit }
        | undefined;
      if (!supply) throw new RecipeServiceError(404, `Supply ${supplyId} not found`);
      baseUnit = supply.base_unit;
    }
    const dedupeKey = groupName ? `group:${groupName.toLowerCase()}` : supplyId;
    if (seenSupplies.has(dedupeKey)) {
      throw new RecipeServiceError(400, groupName ? 'duplicate group in recipe' : 'duplicate supply_id in recipe');
    }
    seenSupplies.add(dedupeKey);
    const quantity = assertPositiveFinite(item.quantity, 'item.quantity');
    const unit = assertSupplyUnit(item.unit, 'item.unit');
    // Validate convertibility at save time so depletion cannot fail later.
    convertQuantity(quantity, unit, baseUnit);
    normalizedItems.push({ supplyId, groupName, quantity, unit });
  }

  const yieldQuantity = input.yieldQuantity === undefined ? 1 : assertPositiveFinite(input.yieldQuantity, 'yield_quantity');
  const isActive = input.isActive === false ? 0 : 1;
  const timestamp = now();

  const recipeId = withTxn(() => {
    const existing = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId) as { id: string } | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE recipes SET yield_quantity = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(yieldQuantity, isActive, timestamp, id);
      db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(id);
    } else {
      id = newId('rcp');
      db.prepare(`
        INSERT INTO recipes (id, product_id, yield_quantity, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, productId, yieldQuantity, isActive, timestamp, timestamp);
    }

    const insertItem = db.prepare(`
      INSERT INTO recipe_items (id, recipe_id, supply_id, group_name, quantity, unit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of normalizedItems) {
      insertItem.run(newId('rci'), id, item.supplyId, item.groupName, item.quantity, item.unit, timestamp);
    }
    return id;
  });

  const recipe = getRecipe(db, recipeId);
  if (!recipe) throw new RecipeServiceError(500, 'Failed to save recipe');
  return recipe;
}

export function deleteRecipe(db: ReturnType<typeof getDatabase>, productId: string): void {
  const existing = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(productId) as { id: string } | undefined;
  if (!existing) throw new RecipeServiceError(404, 'Recipe not found');
  withTxn(() => {
    db.prepare('DELETE FROM recipe_items WHERE recipe_id = ?').run(existing.id);
    db.prepare('DELETE FROM recipes WHERE id = ?').run(existing.id);
  });
}

/**
 * Build an immutable per-order-item snapshot of the recipe scaled to the
 * ordered quantity. Returns null when the product has no active recipe.
 */
export function buildRecipeSnapshot(
  db: ReturnType<typeof getDatabase>,
  productId: string,
  orderQuantity: number,
): RecipeSnapshot | null {
  const recipe = getRecipeByProduct(db, productId);
  if (!recipe || recipe.is_active !== 1 || recipe.items.length === 0) return null;
  if (!Number.isFinite(orderQuantity) || orderQuantity <= 0) return null;

  const scale = orderQuantity / recipe.yield_quantity;
  const components: RecipeSnapshot['components'] = [];
  for (const item of recipe.items) {
    const needed = item.quantity_in_base * scale;
    const members = item.group_name ? groupMembersInUseOrder(db, item.group_name) : [];
    if (members.length === 0) {
      components.push({
        supply_id: item.supply_id,
        supply_name: item.supply_name,
        base_unit: item.base_unit,
        quantity: roundQuantity(needed),
      });
      continue;
    }
    let remaining = needed;
    const taken: Array<{ member: GroupMember; quantity: number }> = [];
    for (const member of members) {
      if (remaining <= 0 || Number(member.stock_quantity) <= 0) continue;
      const take = Math.min(remaining, Number(member.stock_quantity));
      taken.push({ member, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) {
      if (taken.length === 0) taken.push({ member: members[0], quantity: 0 });
      taken[taken.length - 1].quantity += remaining;
    }
    for (const { member, quantity } of taken) {
      components.push({
        supply_id: member.id,
        supply_name: member.name,
        base_unit: member.base_unit,
        quantity: roundQuantity(quantity),
      });
    }
  }

  return {
    recipe_id: recipe.id,
    product_id: recipe.product_id,
    yield_quantity: recipe.yield_quantity,
    components,
  };
}

export function parseRecipeSnapshot(raw: unknown): RecipeSnapshot | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as RecipeSnapshot;
    if (!parsed || !Array.isArray(parsed.components)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Apply snapshot component deltas to supply stock. Positive deltas restore,
 * negative deltas deplete. Callers must already be inside a transaction.
 */
export function applyRecipeSnapshot(
  db: ReturnType<typeof getDatabase>,
  snapshot: RecipeSnapshot,
  options: {
    direction: 'deplete' | 'restore';
    actorUserId: string;
    referenceId: string | number;
    createdAt?: string;
  },
): void {
  const movementType = options.direction === 'deplete' ? 'recipe_depletion' : 'recipe_restore';
  const sign = options.direction === 'deplete' ? -1 : 1;
  for (const component of snapshot.components) {
    const magnitude = roundQuantity(Math.abs(component.quantity));
    if (magnitude === 0) continue;
    applySupplyStockChange(db, {
      supplyId: component.supply_id,
      quantityDelta: sign * magnitude,
      movementType,
      unit: component.base_unit,
      reason: options.direction === 'deplete' ? 'Recipe depletion' : 'Recipe restore',
      actorUserId: options.actorUserId,
      referenceType: 'order_item',
      referenceId: options.referenceId,
      createdAt: options.createdAt,
    });
  }
}

export interface ImportRecipeRow {
  productName: unknown;
  ingredientName: unknown;
  quantity: unknown;
  unit: unknown;
}

export interface ImportRecipesResult {
  dry_run: boolean;
  to_create: Array<{ product_name: string; items: number }>;
  already_have_recipe: string[];
  skipped: Array<{ product_name: string; reason: string }>;
}

const MAX_IMPORT_RECIPE_ROWS = 2000;

function nameKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function importRecipes(
  db: ReturnType<typeof getDatabase>,
  input: { rows: ImportRecipeRow[]; dryRun: boolean },
): ImportRecipesResult {
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new RecipeServiceError(400, 'rows is required');
  if (input.rows.length > MAX_IMPORT_RECIPE_ROWS) throw new RecipeServiceError(400, `at most ${MAX_IMPORT_RECIPE_ROWS} rows per import`);

  const products = new Map<string, string>();
  for (const row of db.prepare('SELECT id, name FROM products').all() as Array<{ id: string; name: string }>) {
    const key = nameKey(row.name);
    products.set(products.has(key) ? `${key}\u0000dup` : key, row.id);
  }
  const supplies = new Map<string, { id: string; baseUnit: SupplyUnit }>();
  for (const row of db.prepare('SELECT id, name, base_unit FROM supplies WHERE deleted_at IS NULL').all() as Array<{ id: string; name: string; base_unit: SupplyUnit }>) {
    supplies.set(nameKey(row.name), { id: row.id, baseUnit: row.base_unit });
  }
  const groups = new Map<string, { groupName: string; baseUnit: SupplyUnit }>();
  for (const row of db.prepare('SELECT group_name, base_unit FROM supplies WHERE deleted_at IS NULL AND is_active = 1 AND group_name IS NOT NULL').all() as Array<{ group_name: string; base_unit: SupplyUnit }>) {
    groups.set(nameKey(row.group_name), { groupName: row.group_name, baseUnit: row.base_unit });
  }
  const haveRecipe = new Set(
    (db.prepare('SELECT product_id FROM recipes').all() as Array<{ product_id: string }>).map((r) => r.product_id),
  );

  const grouped = new Map<string, { name: string; lines: Array<{ ingredient: string; quantity: number; unit: string }>; problems: string[] }>();
  for (const row of input.rows) {
    const productName = String(row.productName ?? '').trim();
    if (!productName) continue;
    const key = nameKey(productName);
    let entry = grouped.get(key);
    if (!entry) {
      entry = { name: productName, lines: [], problems: [] };
      grouped.set(key, entry);
    }
    const ingredient = String(row.ingredientName ?? '').trim();
    const quantity = Number(String(row.quantity ?? '').trim());
    const unit = String(row.unit ?? '').trim().toLowerCase();
    if (!ingredient) { entry.problems.push('ingredient name is missing'); continue; }
    if (!Number.isFinite(quantity) || quantity <= 0) { entry.problems.push(`quantity for ${ingredient} must be greater than zero`); continue; }
    entry.lines.push({ ingredient, quantity, unit });
  }

  const result: ImportRecipesResult = { dry_run: input.dryRun, to_create: [], already_have_recipe: [], skipped: [] };
  const ready: Array<{ productId: string; name: string; items: { supplyId?: string; groupName?: string; quantity: number; unit: string }[] }> = [];
  for (const [key, entry] of grouped) {
    if (products.has(`${key}\u0000dup`)) { result.skipped.push({ product_name: entry.name, reason: 'more than one product has this name' }); continue; }
    const productId = products.get(key);
    if (!productId) { result.skipped.push({ product_name: entry.name, reason: 'no product with this name' }); continue; }
    if (haveRecipe.has(productId)) { result.already_have_recipe.push(entry.name); continue; }
    if (entry.problems.length > 0) { result.skipped.push({ product_name: entry.name, reason: entry.problems[0] }); continue; }
    const missing = entry.lines.filter((l) => !supplies.has(nameKey(l.ingredient)) && !groups.has(nameKey(l.ingredient))).map((l) => l.ingredient);
    if (missing.length > 0) { result.skipped.push({ product_name: entry.name, reason: `no ingredient named ${missing.join(', ')}` }); continue; }
    const seen = new Set<string>();
    const items: { supplyId?: string; groupName?: string; quantity: number; unit: string }[] = [];
    let problem = '';
    for (const l of entry.lines) {
      const supply = supplies.get(nameKey(l.ingredient));
      const group = supply ? undefined : groups.get(nameKey(l.ingredient));
      const lineKey = supply ? supply.id : `group:${nameKey(l.ingredient)}`;
      if (seen.has(lineKey)) { problem = 'an ingredient is listed twice'; break; }
      seen.add(lineKey);
      try {
        convertQuantity(l.quantity, assertSupplyUnit(l.unit, 'unit'), (supply?.baseUnit ?? group?.baseUnit) as SupplyUnit);
      } catch (error: unknown) {
        problem = `${l.ingredient}: ${error instanceof Error ? error.message : 'invalid unit'}`;
        break;
      }
      items.push(supply
        ? { supplyId: supply.id, quantity: l.quantity, unit: l.unit }
        : { groupName: group?.groupName, quantity: l.quantity, unit: l.unit });
    }
    if (problem) { result.skipped.push({ product_name: entry.name, reason: problem }); continue; }
    ready.push({ productId, name: entry.name, items });
  }

  if (!input.dryRun) {
    withTxn(() => {
      for (const recipe of ready) saveRecipe(db, { productId: recipe.productId, isActive: false, items: recipe.items });
    });
  }
  result.to_create = ready.map((r) => ({ product_name: r.name, items: r.items.length }));
  return result;
}
