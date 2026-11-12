import type { getDatabase } from '../db';

export interface SupplyCostInUse {
  current: number | null;
  next: number | null;
}

const EPSILON = 1e-9;

/**
 * First-in, first-out cost worked out from delivery history: stock on hand is assigned to the newest
 * deliveries first, and the oldest delivery still holding stock sets the price in use. Stock older than
 * the recorded deliveries is priced at the supply's stored cost.
 */
export function supplyCostInUse(
  db: ReturnType<typeof getDatabase>,
  supplyId: string,
  stockQuantity: number,
  storedCost: number | null,
): SupplyCostInUse {
  const deliveries = db.prepare(`
    SELECT quantity_delta AS quantity, unit_cost AS cost
    FROM supply_movements
    WHERE supply_id = ? AND movement_type = 'receive' AND quantity_delta > 0
    ORDER BY created_at DESC, id DESC
  `).all(supplyId) as Array<{ quantity: number; cost: number | null }>;

  const stock = Number(stockQuantity);
  if (!(stock > EPSILON)) {
    const latest = deliveries.find((delivery) => delivery.cost !== null);
    return { current: latest ? Number(latest.cost) : storedCost, next: null };
  }

  const holding: Array<number | null> = [];
  let remaining = stock;
  for (const delivery of deliveries) {
    holding.push(delivery.cost === null ? null : Number(delivery.cost));
    remaining -= Number(delivery.quantity);
    if (remaining <= EPSILON) break;
  }
  const oldestFirst = holding.reverse();
  if (remaining > EPSILON) oldestFirst.unshift(storedCost);
  const costs = oldestFirst.filter((cost): cost is number => cost !== null);
  const current = costs.length > 0 ? costs[0] : storedCost;
  const next = costs.find((cost) => cost !== current) ?? null;
  return { current, next };
}
