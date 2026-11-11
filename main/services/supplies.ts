import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import {
  SupplyUnit,
  assertSupplyUnit,
  convertQuantity,
  roundQuantity,
} from './units';

export type SupplyMovementType = 'receive' | 'count' | 'adjustment' | 'waste' | 'recipe_depletion' | 'recipe_restore';

export class SupplyServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'SupplyServiceError';
    this.statusCode = statusCode;
  }
}

export interface SupplyRecord {
  id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  low_stock_threshold: number | null;
  unit_cost: number | null;
  pack_size: number | null;
  pack_label: string | null;
  pour_size: number | null;
  order_up_to: number | null;
  vendor_id: string | null;
  is_active: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  is_low_stock?: number;
}

export interface SupplyCostingInput {
  unitCost?: number | null;
  packSize?: number | null;
  packLabel?: string | null;
  pourSize?: number | null;
  orderUpTo?: number | null;
  vendorId?: string | null;
}

export interface SupplyMovement {
  id: number;
  supply_id: string;
  supply_name: string | null;
  quantity_delta: number;
  movement_type: SupplyMovementType;
  unit: SupplyUnit;
  stock_after: number;
  unit_cost: number | null;
  reason: string | null;
  actor_user_id: string;
  actor_name: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface CreateSupplyInput extends SupplyCostingInput {
  id?: string;
  name: string;
  baseUnit: string;
  stockQuantity?: number;
  lowStockThreshold?: number | null;
  isActive?: boolean;
  actorUserId?: string;
}

export interface RecordMovementInput {
  supplyId: string;
  movementType: 'receive' | 'count' | 'adjustment' | 'waste';
  quantity: number;
  unit?: string;
  reason?: string | null;
  actorUserId: string;
  referenceType?: string | null;
  referenceId?: string | number | null;
  createdAt?: string;
}

function newId(): string {
  return `sup_${randomBytes(12).toString('hex')}`;
}

function assertReason(input: RecordMovementInput): string | null {
  const reason = input.reason === undefined || input.reason === null ? null : String(input.reason).trim();
  if ((input.movementType === 'adjustment' || input.movementType === 'waste') && !reason) {
    throw new SupplyServiceError(400, 'reason is required for adjustment and waste movements');
  }
  if (reason && reason.length > 500) {
    throw new SupplyServiceError(400, 'reason is too long');
  }
  return reason || null;
}

function normalizeQuantity(value: unknown, field = 'quantity'): number {
  const quantity = typeof value === 'string' ? Number(value) : value;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    throw new SupplyServiceError(400, `${field} must be a finite number`);
  }
  return quantity;
}

function optionalNonNegative(value: unknown, field: string, mustBePositive = false): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = normalizeQuantity(value, field);
  if (parsed < 0 || (mustBePositive && parsed === 0)) {
    throw new SupplyServiceError(400, `${field} must be ${mustBePositive ? 'greater than zero' : 'non-negative'}`);
  }
  return roundQuantity(parsed);
}

function resolveCosting(
  input: SupplyCostingInput,
  current: Partial<SupplyRecord> | null,
): {
  unit_cost: number | null;
  pack_size: number | null;
  pack_label: string | null;
  pour_size: number | null;
  order_up_to: number | null;
  vendor_id: string | null;
} {
  const pick = <T>(next: T | undefined, existing: T | null | undefined): T | null =>
    next === undefined ? (existing ?? null) : next;
  const packLabel = input.packLabel === undefined
    ? (current?.pack_label ?? null)
    : (input.packLabel === null || String(input.packLabel).trim() === '' ? null : String(input.packLabel).trim().slice(0, 60));
  const vendorId = input.vendorId === undefined
    ? (current?.vendor_id ?? null)
    : (input.vendorId === null || String(input.vendorId).trim() === '' ? null : String(input.vendorId).trim());
  return {
    unit_cost: pick(optionalNonNegative(input.unitCost, 'unit_cost'), current?.unit_cost),
    pack_size: pick(optionalNonNegative(input.packSize, 'pack_size', true), current?.pack_size),
    pack_label: packLabel,
    pour_size: pick(optionalNonNegative(input.pourSize, 'pour_size', true), current?.pour_size),
    order_up_to: pick(optionalNonNegative(input.orderUpTo, 'order_up_to'), current?.order_up_to),
    vendor_id: vendorId,
  };
}

function assertVendorExists(db: ReturnType<typeof getDatabase>, vendorId: string | null): void {
  if (vendorId === null) return;
  const vendor = db.prepare('SELECT 1 FROM vendors WHERE id = ? AND deleted_at IS NULL').get(vendorId);
  if (!vendor) throw new SupplyServiceError(400, 'vendor_id does not match a vendor');
}

export function getSupply(db: ReturnType<typeof getDatabase>, id: string): SupplyRecord {
  const row = db.prepare('SELECT * FROM supplies WHERE id = ? AND deleted_at IS NULL').get(id) as SupplyRecord | undefined;
  if (!row) throw new SupplyServiceError(404, 'Supply not found');
  return row;
}

export function listSupplies(
  db: ReturnType<typeof getDatabase>,
  filters: { includeInactive?: boolean; search?: string; lowStockOnly?: boolean } = {},
): SupplyRecord[] {
  const conditions = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (!filters.includeInactive) conditions.push('is_active = 1');
  if (filters.search) {
    conditions.push('name LIKE ?');
    params.push(`%${filters.search}%`);
  }
  let sql = `
    SELECT *,
      CASE
        WHEN low_stock_threshold IS NOT NULL AND stock_quantity <= low_stock_threshold THEN 1
        ELSE 0
      END AS is_low_stock
    FROM supplies
    WHERE ${conditions.join(' AND ')}
    ORDER BY name COLLATE NOCASE
  `;
  if (filters.lowStockOnly) {
    sql = `
      SELECT *,
        CASE
          WHEN low_stock_threshold IS NOT NULL AND stock_quantity <= low_stock_threshold THEN 1
          ELSE 0
        END AS is_low_stock
      FROM supplies
      WHERE ${conditions.join(' AND ')}
        AND low_stock_threshold IS NOT NULL
        AND stock_quantity <= low_stock_threshold
      ORDER BY name COLLATE NOCASE
    `;
  }
  return db.prepare(sql).all(...params) as SupplyRecord[];
}

export function createSupply(db: ReturnType<typeof getDatabase>, input: CreateSupplyInput): SupplyRecord {
  const name = String(input.name || '').trim();
  if (!name) throw new SupplyServiceError(400, 'name is required');
  if (name.length > 200) throw new SupplyServiceError(400, 'name is too long');
  const baseUnit = assertSupplyUnit(input.baseUnit, 'base_unit');
  const stockQuantity = input.stockQuantity === undefined ? 0 : roundQuantity(normalizeQuantity(input.stockQuantity, 'stock_quantity'));
  if (input.lowStockThreshold !== undefined && input.lowStockThreshold !== null) {
    const threshold = normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold');
    if (threshold < 0) throw new SupplyServiceError(400, 'low_stock_threshold must be non-negative');
  }
  const lowStockThreshold = input.lowStockThreshold === undefined || input.lowStockThreshold === null
    ? null
    : roundQuantity(normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold'));
  const id = input.id || newId();
  const timestamp = now();
  const isActive = input.isActive === false ? 0 : 1;
  const costing = resolveCosting(input, null);
  assertVendorExists(db, costing.vendor_id);

  withTxn(() => {
    db.prepare(`
      INSERT INTO supplies (
        id, name, base_unit, stock_quantity, low_stock_threshold,
        unit_cost, pack_size, pack_label, pour_size, order_up_to, vendor_id,
        is_active, created_at, updated_at
      )
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, baseUnit, lowStockThreshold,
      costing.unit_cost, costing.pack_size, costing.pack_label, costing.pour_size, costing.order_up_to, costing.vendor_id,
      isActive, timestamp, timestamp,
    );

    if (stockQuantity !== 0) {
      if (!input.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required for opening stock');
      applySupplyStockChange(db, {
        supplyId: id,
        quantityDelta: stockQuantity,
        movementType: 'adjustment',
        unit: baseUnit,
        reason: 'Opening balance',
        actorUserId: input.actorUserId,
        referenceType: 'opening_balance',
        referenceId: id,
        createdAt: timestamp,
      });
    }
  });

  return getSupply(db, id);
}

export function updateSupply(
  db: ReturnType<typeof getDatabase>,
  id: string,
  input: { name?: string; isActive?: boolean; lowStockThreshold?: number | null } & SupplyCostingInput,
): SupplyRecord {
  const supply = getSupply(db, id);
  const name = input.name === undefined ? supply.name : String(input.name).trim();
  if (!name) throw new SupplyServiceError(400, 'name is required');
  if (name.length > 200) throw new SupplyServiceError(400, 'name is too long');
  let lowStockThreshold: number | null = supply.low_stock_threshold;
  if (input.lowStockThreshold !== undefined) {
    if (input.lowStockThreshold === null) {
      lowStockThreshold = null;
    } else {
      const threshold = normalizeQuantity(input.lowStockThreshold, 'low_stock_threshold');
      if (threshold < 0) throw new SupplyServiceError(400, 'low_stock_threshold must be non-negative');
      lowStockThreshold = roundQuantity(threshold);
    }
  }
  const isActive = input.isActive === undefined ? supply.is_active : (input.isActive ? 1 : 0);
  const costing = resolveCosting(input, supply);
  assertVendorExists(db, costing.vendor_id);
  db.prepare(`
    UPDATE supplies SET
      name = ?, low_stock_threshold = ?, is_active = ?,
      unit_cost = ?, pack_size = ?, pack_label = ?, pour_size = ?, order_up_to = ?, vendor_id = ?,
      updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(
    name, lowStockThreshold, isActive,
    costing.unit_cost, costing.pack_size, costing.pack_label, costing.pour_size, costing.order_up_to, costing.vendor_id,
    now(), id,
  );
  return getSupply(db, id);
}

export function softDeleteSupply(db: ReturnType<typeof getDatabase>, id: string): void {
  getSupply(db, id);
  const linkedRecipe = db.prepare('SELECT 1 FROM recipe_items WHERE supply_id = ? LIMIT 1').get(id);
  if (linkedRecipe) throw new SupplyServiceError(409, 'Cannot delete a supply used by a recipe');
  const timestamp = now();
  db.prepare('UPDATE supplies SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(timestamp, timestamp, id);
}

export function applySupplyStockChange(
  db: ReturnType<typeof getDatabase>,
  options: {
    supplyId: string;
    quantityDelta: number;
    movementType: SupplyMovementType;
    unit?: string;
    reason?: string | null;
    actorUserId: string;
    referenceType?: string | null;
    referenceId?: string | number | null;
    createdAt?: string;
    unitCost?: number | null;
  },
): { stockBefore: number; stockAfter: number; movementId: number } {
  const supply = db.prepare('SELECT * FROM supplies WHERE id = ?').get(options.supplyId) as
    | SupplyRecord
    | undefined;
  if (!supply) throw new SupplyServiceError(404, 'Supply not found');
  if (!options.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');

  const unit = options.unit === undefined ? supply.base_unit : assertSupplyUnit(options.unit, 'unit');
  const deltaInBase = convertQuantity(options.quantityDelta, unit, supply.base_unit);
  if (deltaInBase === 0 && options.movementType !== 'count') {
    throw new SupplyServiceError(400, 'quantity_delta is too small to change stock');
  }

  const stockBefore = Number(supply.stock_quantity);
  const stockAfter = roundQuantity(stockBefore + deltaInBase);
  const timestamp = options.createdAt || now();

  db.prepare('UPDATE supplies SET stock_quantity = ?, updated_at = ? WHERE id = ?')
    .run(stockAfter, timestamp, options.supplyId);

  const movement = db.prepare(`
    INSERT INTO supply_movements (
      supply_id, quantity_delta, movement_type, unit, stock_after,
      reason, actor_user_id, reference_type, reference_id, created_at, unit_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.supplyId,
    deltaInBase,
    options.movementType,
    supply.base_unit,
    stockAfter,
    options.reason ?? null,
    options.actorUserId,
    options.referenceType ?? null,
    options.referenceId === null || options.referenceId === undefined ? null : String(options.referenceId),
    timestamp,
    options.unitCost ?? null,
  );

  return { stockBefore, stockAfter, movementId: Number(movement.lastInsertRowid) };
}

function recordSupplyMovementInTxn(db: ReturnType<typeof getDatabase>, input: RecordMovementInput): SupplyMovement | null {
  const supply = getSupply(db, input.supplyId);
  if (!input.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');
  const quantity = normalizeQuantity(input.quantity);
  const unit = input.unit === undefined ? supply.base_unit : assertSupplyUnit(input.unit, 'unit');
  const reason = assertReason(input);
  const timestamp = input.createdAt || now();

  let delta: number;
  switch (input.movementType) {
    case 'receive':
      if (quantity <= 0) throw new SupplyServiceError(400, 'receive quantity must be positive');
      delta = convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'waste':
      if (quantity <= 0) throw new SupplyServiceError(400, 'waste quantity must be positive');
      delta = -convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'adjustment':
      if (quantity === 0) throw new SupplyServiceError(400, 'adjustment quantity must be non-zero');
      delta = convertQuantity(quantity, unit, supply.base_unit);
      break;
    case 'count': {
      if (quantity < 0) throw new SupplyServiceError(400, 'count quantity must be non-negative');
      const target = convertQuantity(quantity, unit, supply.base_unit);
      delta = roundQuantity(target - Number(supply.stock_quantity));
      break;
    }
    default:
      throw new SupplyServiceError(400, `movement_type ${input.movementType} is not allowed via this path`);
  }

  const { movementId } = applySupplyStockChange(db, {
    supplyId: input.supplyId,
    quantityDelta: delta,
    movementType: input.movementType,
    unit: supply.base_unit,
    reason,
    actorUserId: input.actorUserId,
    referenceType: input.referenceType ?? null,
    referenceId: input.referenceId ?? null,
    createdAt: timestamp,
  });

  const row = db.prepare(`
    SELECT
      m.id, m.supply_id, s.name AS supply_name, m.quantity_delta, m.movement_type, m.unit,
      m.stock_after, m.unit_cost, m.reason, m.actor_user_id, u.name AS actor_name,
      m.reference_type, m.reference_id, m.created_at
    FROM supply_movements m
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    WHERE m.id = ?
  `).get(movementId) as SupplyMovement | undefined;
  return row || null;
}

export function recordSupplyMovement(db: ReturnType<typeof getDatabase>, input: RecordMovementInput): SupplyMovement | null {
  return withTxn(() => recordSupplyMovementInTxn(db, input));
}

export function listSupplyMovements(
  db: ReturnType<typeof getDatabase>,
  filters: {
    supplyId?: string;
    movementType?: SupplyMovementType;
    beforeId?: number;
    perPage?: number;
  } = {},
): { movements: SupplyMovement[]; nextCursor: number | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.supplyId) {
    conditions.push('m.supply_id = ?');
    params.push(filters.supplyId);
  }
  if (filters.movementType) {
    conditions.push('m.movement_type = ?');
    params.push(filters.movementType);
  }
  if (filters.beforeId !== undefined) {
    const cursor = db.prepare('SELECT created_at FROM supply_movements WHERE id = ?').get(filters.beforeId) as
      | { created_at: string }
      | undefined;
    if (cursor) {
      conditions.push('(m.created_at, m.id) < (?, ?)');
      params.push(cursor.created_at, filters.beforeId);
    }
  }
  const perPage = filters.perPage ?? 50;
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      m.id, m.supply_id, s.name AS supply_name, m.quantity_delta, m.movement_type, m.unit,
      m.stock_after, m.unit_cost, m.reason, m.actor_user_id, u.name AS actor_name,
      m.reference_type, m.reference_id, m.created_at
    FROM supply_movements m
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN users u ON u.id = m.actor_user_id
    ${whereSql}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as SupplyMovement[];

  const hasMore = rows.length > perPage;
  const movements = hasMore ? rows.slice(0, perPage) : rows;
  return {
    movements,
    nextCursor: hasMore ? movements[movements.length - 1].id : null,
  };
}

export interface DeliveryLineInput {
  supplyId: string;
  packs?: number;
  packPrice?: number;
  quantity?: number;
  unit?: string;
  totalCost?: number;
}

export interface ReceiveDeliveryInput {
  vendorId?: string | null;
  reference?: string | null;
  lines: DeliveryLineInput[];
  actorUserId: string;
  createdAt?: string;
}

export interface DeliveryLineResult {
  supply_id: string;
  received_quantity: number;
  unit_cost: number | null;
  stock_after: number;
  average_cost: number | null;
}

export function receiveDelivery(
  db: ReturnType<typeof getDatabase>,
  input: ReceiveDeliveryInput,
): { delivery_id: string; lines: DeliveryLineResult[] } {
  if (!input.actorUserId) throw new SupplyServiceError(400, 'actor_user_id is required');
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SupplyServiceError(400, 'lines must contain at least one item');
  }
  if (input.lines.length > 200) throw new SupplyServiceError(400, 'too many lines in one delivery');
  const vendorId = input.vendorId === undefined || input.vendorId === null || String(input.vendorId).trim() === ''
    ? null
    : String(input.vendorId).trim();
  assertVendorExists(db, vendorId);
  const reference = input.reference ? String(input.reference).trim().slice(0, 120) : null;
  const deliveryId = `del_${randomBytes(8).toString('hex')}`;
  const timestamp = input.createdAt || now();

  return withTxn(() => {
    const results: DeliveryLineResult[] = [];
    for (const line of input.lines) {
      const supply = getSupply(db, String(line.supplyId));
      let baseQuantity: number;
      let totalCost: number | null = null;

      if (line.packs !== undefined && line.packs !== null) {
        const packs = normalizeQuantity(line.packs, 'packs');
        if (packs <= 0) throw new SupplyServiceError(400, 'packs must be greater than zero');
        if (!supply.pack_size) throw new SupplyServiceError(400, `${supply.name} has no pack size set`);
        baseQuantity = roundQuantity(packs * Number(supply.pack_size));
        if (line.packPrice !== undefined && line.packPrice !== null) {
          const packPrice = normalizeQuantity(line.packPrice, 'pack_price');
          if (packPrice < 0) throw new SupplyServiceError(400, 'pack_price must be non-negative');
          totalCost = packs * packPrice;
        }
      } else {
        const quantity = normalizeQuantity(line.quantity, 'quantity');
        if (quantity <= 0) throw new SupplyServiceError(400, 'quantity must be greater than zero');
        const unit = line.unit === undefined ? supply.base_unit : assertSupplyUnit(line.unit, 'unit');
        baseQuantity = convertQuantity(quantity, unit, supply.base_unit);
        if (line.totalCost !== undefined && line.totalCost !== null) {
          totalCost = normalizeQuantity(line.totalCost, 'total_cost');
          if (totalCost < 0) throw new SupplyServiceError(400, 'total_cost must be non-negative');
        }
      }
      if (baseQuantity <= 0) throw new SupplyServiceError(400, 'received quantity is too small to change stock');

      const lineUnitCost = totalCost === null ? null : Number((totalCost / baseQuantity).toFixed(6));
      const onHand = Math.max(Number(supply.stock_quantity), 0);
      let averageCost: number | null = supply.unit_cost;
      if (lineUnitCost !== null) {
        averageCost = supply.unit_cost === null || onHand === 0
          ? lineUnitCost
          : Number(((onHand * Number(supply.unit_cost) + baseQuantity * lineUnitCost) / (onHand + baseQuantity)).toFixed(6));
      }

      const change = applySupplyStockChange(db, {
        supplyId: supply.id,
        quantityDelta: baseQuantity,
        movementType: 'receive',
        unit: supply.base_unit,
        reason: reference ? `Delivery ${reference}` : 'Delivery',
        actorUserId: input.actorUserId,
        referenceType: 'delivery',
        referenceId: deliveryId,
        createdAt: timestamp,
        unitCost: lineUnitCost,
      });

      db.prepare('UPDATE supplies SET unit_cost = ?, vendor_id = COALESCE(vendor_id, ?), updated_at = ? WHERE id = ?')
        .run(averageCost, vendorId, timestamp, supply.id);

      results.push({
        supply_id: supply.id,
        received_quantity: baseQuantity,
        unit_cost: lineUnitCost,
        stock_after: change.stockAfter,
        average_cost: averageCost,
      });
    }
    return { delivery_id: deliveryId, lines: results };
  });
}

export interface ImportSupplyRow {
  name: unknown;
  baseUnit: unknown;
  packSize?: unknown;
  packLabel?: unknown;
  packPrice?: unknown;
  pourSize?: unknown;
  parLevel?: unknown;
  orderUpTo?: unknown;
}

export interface ImportSuppliesResult {
  dry_run: boolean;
  vendor_id: string | null;
  vendor_created: boolean;
  to_create: Array<{ name: string; base_unit: SupplyUnit; pack_size: number | null; pack_label: string | null; pack_price: number | null; unit_cost: number | null; pour_size: number | null; par_level: number | null; order_up_to: number | null }>;
  already_exist: string[];
  errors: Array<{ row: number; name: string; error: string }>;
}

const MAX_IMPORT_ROWS = 500;

export interface OrderListItem {
  supply_id: string;
  name: string;
  base_unit: SupplyUnit;
  stock_quantity: number;
  order_up_to: number | null;
  pack_size: number | null;
  pack_label: string | null;
  packs: number | null;
  order_quantity: number | null;
  unit_cost: number | null;
  estimated_cost: number | null;
}

export interface OrderListGroup {
  vendor_id: string | null;
  vendor_name: string | null;
  items: OrderListItem[];
  estimated_cost: number;
  missing_cost_count: number;
}

export function buildOrderList(db: ReturnType<typeof getDatabase>): { groups: OrderListGroup[] } {
  const rows = db.prepare(`
    SELECT s.*, v.name AS vendor_name
    FROM supplies s
    LEFT JOIN vendors v ON v.id = s.vendor_id AND v.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND s.is_active = 1
      AND s.low_stock_threshold IS NOT NULL
      AND s.stock_quantity <= s.low_stock_threshold
    ORDER BY s.name COLLATE NOCASE
  `).all() as Array<SupplyRecord & { vendor_name: string | null }>;

  const groups = new Map<string, OrderListGroup>();
  for (const row of rows) {
    const onHand = Math.max(row.stock_quantity, 0);
    const need = row.order_up_to !== null && row.order_up_to > onHand
      ? roundQuantity(row.order_up_to - onHand)
      : null;
    let packs: number | null = null;
    let orderQuantity = need;
    if (need !== null && row.pack_size !== null && row.pack_size > 0) {
      packs = Math.ceil(roundQuantity(need / row.pack_size));
      orderQuantity = roundQuantity(packs * row.pack_size);
    }
    const estimatedCost = orderQuantity !== null && row.unit_cost !== null
      ? Math.round(orderQuantity * row.unit_cost * 100) / 100
      : null;
    const key = row.vendor_name ? (row.vendor_id as string) : '';
    let group = groups.get(key);
    if (!group) {
      group = {
        vendor_id: row.vendor_name ? row.vendor_id : null,
        vendor_name: row.vendor_name,
        items: [],
        estimated_cost: 0,
        missing_cost_count: 0,
      };
      groups.set(key, group);
    }
    group.items.push({
      supply_id: row.id,
      name: row.name,
      base_unit: row.base_unit,
      stock_quantity: row.stock_quantity,
      order_up_to: row.order_up_to,
      pack_size: row.pack_size,
      pack_label: row.pack_label,
      packs,
      order_quantity: orderQuantity,
      unit_cost: row.unit_cost,
      estimated_cost: estimatedCost,
    });
    if (estimatedCost === null) group.missing_cost_count += 1;
    else group.estimated_cost = Math.round((group.estimated_cost + estimatedCost) * 100) / 100;
  }
  return {
    groups: [...groups.values()].sort((a, b) => {
      if (!a.vendor_name) return 1;
      if (!b.vendor_name) return -1;
      return a.vendor_name.localeCompare(b.vendor_name);
    }),
  };
}


export function importSupplies(
  db: ReturnType<typeof getDatabase>,
  input: { rows: ImportSupplyRow[]; vendorName?: string | null; dryRun: boolean; actorUserId: string },
): ImportSuppliesResult {
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new SupplyServiceError(400, 'rows is required');
  if (input.rows.length > MAX_IMPORT_ROWS) throw new SupplyServiceError(400, `at most ${MAX_IMPORT_ROWS} rows per import`);
  const vendorName = input.vendorName === undefined || input.vendorName === null ? '' : String(input.vendorName).trim();
  if (vendorName.length > 200) throw new SupplyServiceError(400, 'vendor name is too long');

  const existingNames = new Set(
    (db.prepare('SELECT name FROM supplies WHERE deleted_at IS NULL').all() as Array<{ name: string }>)
      .map((row) => row.name.toLowerCase()),
  );
  const seen = new Set<string>();
  const result: ImportSuppliesResult = {
    dry_run: input.dryRun,
    vendor_id: null,
    vendor_created: false,
    to_create: [],
    already_exist: [],
    errors: [],
  };

  input.rows.forEach((row, index) => {
    const name = String(row.name ?? '').trim();
    try {
      if (!name) throw new SupplyServiceError(400, 'name is required');
      if (name.length > 200) throw new SupplyServiceError(400, 'name is too long');
      const baseUnit = assertSupplyUnit(String(row.baseUnit ?? '').trim().toLowerCase(), 'base_unit');
      const sizeText = row.packSize === undefined || row.packSize === null ? '' : String(row.packSize).trim();
      const packSize = sizeText === '' ? null : optionalNonNegative(Number(sizeText), 'pack_size', true) ?? null;
      const packLabel = String(row.packLabel ?? '').trim().slice(0, 60) || null;
      const priceText = row.packPrice === undefined || row.packPrice === null ? '' : String(row.packPrice).trim();
      const packPrice = priceText === '' ? null : optionalNonNegative(Number(priceText), 'pack_price') ?? null;
      if (packPrice !== null && packSize === null && baseUnit !== 'each') {
        throw new SupplyServiceError(400, 'pack_price needs a pack_size');
      }
      const optionalLevel = (value: unknown, field: string): number | null => {
        const text = value === undefined || value === null ? '' : String(value).trim();
        return text === '' ? null : optionalNonNegative(Number(text), field, field === 'pour_size') ?? null;
      };
      const pourSize = optionalLevel(row.pourSize, 'pour_size');
      const parLevel = optionalLevel(row.parLevel, 'par_level');
      const orderUpTo = optionalLevel(row.orderUpTo, 'order_up_to');
      const unitCost = packPrice === null ? null : (packSize === null ? packPrice : Number((packPrice / packSize).toFixed(8)));
      const key = name.toLowerCase();
      if (existingNames.has(key) || seen.has(key)) {
        result.already_exist.push(name);
        return;
      }
      seen.add(key);
      result.to_create.push({ name, base_unit: baseUnit, pack_size: packSize, pack_label: packLabel, pack_price: packPrice, unit_cost: unitCost, pour_size: pourSize, par_level: parLevel, order_up_to: orderUpTo });
    } catch (error: unknown) {
      result.errors.push({ row: index + 1, name, error: error instanceof Error ? error.message : 'invalid row' });
    }
  });

  if (input.dryRun) return result;
  if (result.errors.length > 0) throw new SupplyServiceError(400, `${result.errors.length} row(s) have errors; nothing was imported`);

  withTxn(() => {
    let vendorId: string | null = null;
    if (vendorName) {
      const found = db.prepare('SELECT id FROM vendors WHERE deleted_at IS NULL AND name = ? COLLATE NOCASE').get(vendorName) as { id: string } | undefined;
      if (found) {
        vendorId = found.id;
      } else {
        vendorId = `ven_${randomBytes(8).toString('hex')}`;
        const timestamp = now();
        db.prepare('INSERT INTO vendors (id, name, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(vendorId, vendorName, timestamp, timestamp);
        result.vendor_created = true;
      }
    }
    result.vendor_id = vendorId;
    for (const item of result.to_create) {
      createSupply(db, {
        name: item.name,
        baseUnit: item.base_unit,
        packSize: item.pack_size ?? undefined,
        packLabel: item.pack_label ?? undefined,
        unitCost: item.unit_cost ?? undefined,
        pourSize: item.pour_size ?? undefined,
        lowStockThreshold: item.par_level ?? undefined,
        orderUpTo: item.order_up_to ?? undefined,
        vendorId: vendorId ?? undefined,
        actorUserId: input.actorUserId,
      });
    }
  });
  return result;
}
