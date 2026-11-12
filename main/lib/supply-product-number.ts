import type Database from 'better-sqlite3';

const NUMBER_PATTERN = /^(.*)S(\d+)$/;

function storePrefix(db: Database.Database): string {
  const counts = new Map<string, number>();
  const rows = db.prepare(`SELECT sku FROM products WHERE sku IS NOT NULL AND sku != ''`).all() as Array<{ sku: string }>;
  for (const { sku } of rows) {
    const match = /^([A-Za-z0-9]+-)/.exec(sku);
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) { best = prefix; bestCount = count; }
  }
  return best;
}

/** Next supply product number: the existing S-series prefix if one exists, otherwise the store's menu SKU prefix. */
export function nextSupplyProductNumber(db: Database.Database): string {
  let prefix: string | null = null;
  let max = 0;
  let width = 4;
  const rows = db.prepare(`SELECT product_number FROM supplies WHERE product_number IS NOT NULL`).all() as Array<{ product_number: string }>;
  for (const { product_number } of rows) {
    const match = NUMBER_PATTERN.exec(product_number);
    if (!match) continue;
    if (prefix === null) prefix = match[1];
    if (match[1] === prefix) {
      max = Math.max(max, Number(match[2]));
      width = Math.max(width, match[2].length);
    }
  }
  const usedPrefix = prefix ?? storePrefix(db);
  return `${usedPrefix}S${String(max + 1).padStart(width, '0')}`;
}
