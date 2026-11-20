import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import {
  dayBoundsInTimezone, getDatabase, getSettingValue, localDateInTimezone, parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../db';
import { hasPermission, requirePermission } from '../services/authorization';
import { listRecipes } from '../services/recipes';
import { getOrdersWithItemsForBills } from './bills';
import { aggregateTaxComponents } from '../services/tax-components';
import { getTenantCurrency } from '../services/refund';
import { getCurrencyMinorUnitFactor, resolveRegionalSnapshot } from '../countries';
import { computeDayAggregates, paymentMethodBreakdown } from './cash-closures';
import { getCurrencyFractionDigits } from '../countries';
import { buildDailySalesExportDataset } from '../services/daily-sales-export';
import { buildDailyReport, buildShiftReport } from '../services/shift-report';
import { sendPrintoutNow } from '../services/telegram';
import {
  dailySalesExportFilename,
  serializeDailySalesExportCsv,
  serializeDailySalesExportXlsx,
} from '../services/daily-sales-export-files';

const router = Router();

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Mirrors main/routes/tables.ts's ACTIVE_ORDER_STATUS_SQL — an order still
// "occupying" its table until it's completed or cancelled.
const ACTIVE_ORDER_STATUS_SQL = "o.status NOT IN ('completed', 'cancelled')";

// Resolves through the country profile when the stored timezone is missing
// or invalid, matching resolveRegionalSnapshot's own contract, instead of
// letting bucketByLocalHourAndWeekday()/dayBoundsInTimezone() silently fall
// back to UTC — reporting a tenant-local day or hour bucket in the wrong
// zone produces incorrect report data. Only throws RegionalNotConfiguredError
// when the country itself is unresolvable.
function tenantTimezone(): string {
  return resolveRegionalSnapshot({
    country: getSettingValue('country') ?? undefined,
    currency: getSettingValue('currency') ?? undefined,
    timezone: getSettingValue('timezone') ?? undefined,
  }).timezone;
}

function tenantStartTime(): string {
  return tenantBusinessDayStartTime();
}

export function reportToday(): string {
  return localDateInTimezone(new Date(), tenantTimezone(), tenantStartTime());
}

function reportDayBounds(date: string): [string, string] {
  return dayBoundsInTimezone(date, tenantTimezone(), tenantStartTime());
}

function reportDate(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

/**
 * Buckets order timestamps into local hour-of-day (0-23) and local
 * day-of-week (0=Sunday..6=Saturday), using the tenant's configured
 * timezone rather than server/UTC time — otherwise "busiest hour" would
 * reflect UTC, not when the restaurant is actually busy. SQLite has no
 * IANA timezone support (only fixed offsets), so this bucketing happens
 * in JS via Intl instead of in SQL.
 */
function bucketByLocalHourAndWeekday(timestamps: string[], timeZone: string, startTime?: string): { hourCounts: number[]; dayCounts: number[] } {
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });

  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0);

  for (const ts of timestamps) {
    const d = parseDbTimestamp(ts);
    if (isNaN(d.getTime())) continue;
    const hour = parseInt(hourFmt.format(d), 10);
    if (hour >= 0 && hour <= 23) hourCounts[hour]++;
    const businessDate = localDateInTimezone(d, timeZone, startTime);
    const dayIdx = new Date(`${businessDate}T12:00:00Z`).getUTCDay();
    if (dayIdx >= 0 && dayIdx < 7) dayCounts[dayIdx]++;
  }

  return { hourCounts, dayCounts };
}

/** argmax/argmin over counts, restricted to indices where include(count) is true. Returns null if nothing qualifies. */
function pickExtreme(counts: number[], mode: 'max' | 'min', include: (count: number) => boolean): { index: number; count: number } | null {
  let best: { index: number; count: number } | null = null;
  counts.forEach((count, index) => {
    if (!include(count)) return;
    if (!best || (mode === 'max' ? count > best.count : count < best.count)) {
      best = { index, count };
    }
  });
  return best;
}

router.get('/daily-stats', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const today = reportToday();
    const [start, end] = reportDayBounds(today);
    const salesToday = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(paid_amount) FROM bills WHERE paid_at >= ? AND paid_at < ?), 0)
        - COALESCE((SELECT SUM(CAST(amount_cents AS REAL)) / ? FROM refunds WHERE created_at >= ? AND created_at < ?), 0) AS sales
    `).get(start, end, minorFactor, start, end) as { sales: number };
    const paymentMethodsToday = paymentMethodBreakdown(db, { startDate: today }) as { total: number }[];

    const runningOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'preparing')
    `).get() as { count: number };

    const pendingOrders = db.prepare(`
      SELECT COUNT(*) as count FROM orders WHERE status = 'pending'
    `).get() as { count: number };

    const tablesOccupied = db.prepare(`
      SELECT COUNT(*) as count FROM tables WHERE status = 'occupied'
    `).get() as { count: number };

    // Avg Table Turn: how long dine-in tables took to turn over today, for
    // orders that finished today (mirrors /insights' avgPrepTimeMinutes idiom).
    const tableTurn = db.prepare(`
      SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM orders
      WHERE type = 'dine_in' AND status = 'completed' AND completed_at IS NOT NULL
        AND completed_at >= ? AND completed_at < ?
    `).get(start, end) as { avgMinutes: number | null; sampleSize: number };

    // Avg Current Occupancy: how long tables occupied right now have been seated.
    const currentOccupancy = db.prepare(`
      SELECT AVG((julianday('now') - julianday(o.created_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM tables t
      JOIN orders o ON o.table_id = t.id AND ${ACTIVE_ORDER_STATUS_SQL}
      WHERE t.status = 'occupied'
    `).get() as { avgMinutes: number | null; sampleSize: number };

    res.json({
      sales: salesToday.sales,
      runningOrders: runningOrders.count,
      pendingOrders: pendingOrders.count,
      tablesOccupied: tablesOccupied.count,
      avgTableTurnMinutes: tableTurn.sampleSize > 0 && tableTurn.avgMinutes !== null ? Math.round(tableTurn.avgMinutes) : null,
      avgCurrentOccupancyMinutes: currentOccupancy.sampleSize > 0 && currentOccupancy.avgMinutes !== null ? Math.round(currentOccupancy.avgMinutes) : null,
      paymentMethods: paymentMethodsToday,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.get('/summary', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    // #208: an explicit date param is a tenant-local `YYYY-MM-DD`; resolve
    // it to the corresponding half-open UTC range. `reportDate` validates the param shape.
    const date = reportDate(req.query.date, reportToday());
    const [start, end] = reportDayBounds(date);

    const ordersToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total
      FROM orders WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number; total: number };

    const billsToday = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total,
        COALESCE((SELECT SUM(paid_amount) FROM bills WHERE paid_at >= ? AND paid_at < ?), 0)
        - COALESCE((SELECT SUM(CAST(amount_cents AS REAL)) / ? FROM refunds WHERE created_at >= ? AND created_at < ?), 0) as collected
      FROM bills WHERE created_at >= ? AND created_at < ?
    `).get(start, end, minorFactor, start, end, start, end) as { count: number; total: number; collected: number };
    const paymentMethodsToday = paymentMethodBreakdown(db, { startDate: date });

    const customersToday = db.prepare(`
      SELECT COUNT(*) as count FROM customers WHERE created_at >= ? AND created_at < ?
    `).get(start, end) as { count: number };

    const ordersByStatus = db.prepare(`
      SELECT status, COUNT(*) as count FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status
    `).all(start, end);

    res.json({
      summary: {
        date,
        orders: { count: ordersToday.count, total: ordersToday.total },
        bills: { count: billsToday.count, total: billsToday.total, collected: billsToday.collected },
        customers: { new: customersToday.count },
        ordersByStatus,
        paymentMethods: paymentMethodsToday,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.get('/financial-summary', requirePermission('reports.financial.view'), (req: Request, res: Response) => {
  try {
    const today = reportToday();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, startDate);
    if ((req.query.start_date !== undefined && reportDate(req.query.start_date, '') === '')
      || (req.query.end_date !== undefined && reportDate(req.query.end_date, '') === '')) {
      return res.status(400).json({ error: 'start_date and end_date must use YYYY-MM-DD format' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const [start] = reportDayBounds(startDate);
    const [, end] = reportDayBounds(endDate);
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const collections = db.prepare(`
      SELECT COUNT(*) AS bill_count, COALESCE(SUM(paid_amount), 0) AS gross_collected
      FROM bills WHERE paid_at >= ? AND paid_at < ?
    `).get(start, end) as { bill_count: number; gross_collected: number };
    const refundTotals = db.prepare(`
      SELECT COUNT(*) AS refund_count, COALESCE(SUM(CAST(r.amount_cents AS REAL)) / ?, 0) AS refunded
      FROM refunds r JOIN bills b ON b.id = r.bill_id
      WHERE b.paid_at >= ? AND b.paid_at < ?
    `).get(minorFactor, start, end) as { refund_count: number; refunded: number };
    const refunds = db.prepare(`
      SELECT r.id, CAST(r.amount_cents AS REAL) / ? AS amount, r.method, r.reason,
        r.created_at, b.bill_number, b.paid_at, o.order_number,
        COALESCE(approver.name, creator.name, 'Unknown') AS approved_by_name
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
      JOIN orders o ON o.id = b.order_id
      LEFT JOIN users approver ON approver.id = r.approved_by
      LEFT JOIN users creator ON creator.id = r.created_by
      WHERE b.paid_at >= ? AND b.paid_at < ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 50
    `).all(minorFactor, start, end);
    const grossCollected = Number(collections.gross_collected || 0);
    const refunded = Number(refundTotals.refunded || 0);

    res.json({
      financialSummary: {
        startDate,
        endDate,
        grossCollected,
        refunded,
        netCollected: grossCollected - refunded,
        billCount: Number(collections.bill_count || 0),
        refundCount: Number(refundTotals.refund_count || 0),
        averageOrderValue: collections.bill_count ? (grossCollected - refunded) / collections.bill_count : 0,
        paymentMethods: paymentMethodBreakdown(db, { startDate, endDate, paidOnly: true, attributeRefundsToBillDate: true }),
        refunds,
      },
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

// Dynamic tax-component report for receipt/report consumers. Components are
// derived item by item so mixed legacy + categorized bills cannot double-count
// the categorized portion already present in the bill-level tax_breakdown.
router.get('/tax-components', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = reportToday();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const windowStart = reportDayBounds(startDate)[0];
    const windowEnd = reportDayBounds(endDate)[1];

    const bills = db.prepare(`
      SELECT b.*
      FROM bills b
      JOIN orders o ON o.id = b.order_id
      WHERE b.created_at >= ? AND b.created_at < ?
        AND o.status != 'cancelled'
      ORDER BY b.created_at, b.id
    `).all(windowStart, windowEnd) as any[];

    const orders = getOrdersWithItemsForBills(db, bills);
    const documents = bills.map((bill) => ({
      tax_amount: bill.tax_amount,
      tax_snapshot: bill.tax_snapshot,
      tax_breakdown: bill.tax_breakdown,
      items: orders.get(Number(bill.id))?.items || [],
    }));
    const taxAmount = bills.reduce(
      (sum, bill) => sum.plus(bill.tax_amount || 0),
      new Decimal(0),
    );

    res.json({
      taxComponents: {
        startDate,
        endDate,
        billCount: bills.length,
        taxAmount: taxAmount.toDecimalPlaces(6).toNumber(),
        components: aggregateTaxComponents(documents),
      },
    });
  } catch (error: any) {
    console.error('[API] Tax component report failed:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.get('/sales', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = reportToday();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    // #208: half-open UTC ranges so the orders/bills indexes apply instead
    // of `date(...)` on every row. The bounds represent tenant business days.
    const windowStart = reportDayBounds(startDate)[0];
    const windowEnd = reportDayBounds(endDate)[1];

    // Daily series is grouped by the tenant business date rather than
    // the UTC date stored in SQLite.
    const dailyRows = db.prepare(`
      SELECT created_at, total
      FROM orders
      WHERE created_at >= ? AND created_at < ?
    `).all(windowStart, windowEnd) as { created_at: string; total: number }[];
    const dailyByDate = new Map<string, { orders: number; sales: number }>();
    const timeZone = tenantTimezone();
    const startTime = tenantStartTime();
    for (const row of dailyRows) {
      const date = localDateInTimezone(parseDbTimestamp(row.created_at), timeZone, startTime);
      const bucket = dailyByDate.get(date) || { orders: 0, sales: 0 };
      bucket.orders += 1;
      bucket.sales += Number(row.total || 0);
      dailyByDate.set(date, bucket);
    }
    const dailySales = [...dailyByDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, totals]) => ({ date, ...totals }));

    const byPaymentMethod = paymentMethodBreakdown(db, { startDate, endDate, paidOnly: true }) as { method: string; count: number; total: number }[];

    const byOrderType = db.prepare(`
      SELECT type, COUNT(*) as count, SUM(total) as total
      FROM orders
      WHERE created_at >= ? AND created_at < ?
      GROUP BY type
    `).all(windowStart, windowEnd);

    res.json({
      sales: {
        startDate,
        endDate,
        dailySales,
        byPaymentMethod,
        byOrderType,
      }
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.get('/topProducts', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = reportToday();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 10;
    const windowStart = reportDayBounds(startDate)[0];
    const windowEnd = reportDayBounds(endDate)[1];

    const topProducts = db.prepare(`
      SELECT oi.product_id, oi.product_name,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.subtotal) as total_revenue,
        COUNT(DISTINCT oi.order_id) as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at >= ? AND o.created_at < ?
      GROUP BY oi.product_id
      ORDER BY total_quantity DESC
      LIMIT ?
    `).all(windowStart, windowEnd, limit);

    res.json({ topProducts });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.get('/recentOrders', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
    const date = req.query.date === undefined ? undefined : reportDate(req.query.date, '');
    const startDate = req.query.start_date === undefined ? undefined : reportDate(req.query.start_date, '');
    const endDate = req.query.end_date === undefined ? undefined : reportDate(req.query.end_date, '');
    if (req.query.date !== undefined && !date) {
      return res.status(400).json({ error: 'date must use YYYY-MM-DD format' });
    }
    if ((req.query.start_date !== undefined && !startDate) || (req.query.end_date !== undefined && !endDate)) {
      return res.status(400).json({ error: 'start_date and end_date must use YYYY-MM-DD format' });
    }
    if (date && (startDate || endDate)) {
      return res.status(400).json({ error: 'date cannot be combined with start_date or end_date' });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }

    // Without a date, "most recent overall" (dashboard live view). With one,
    // scoped to that day — lets the dashboard show a past day's orders
    // instead of always the latest regardless of which date is selected.
    // #208: range filter hits idx_orders_created_at instead of full scan.
    const params: any[] = [];
    let where = '';
    if (date) {
      const [s, e] = reportDayBounds(date);
      where = 'WHERE o.created_at >= ? AND o.created_at < ?';
      params.push(s, e);
    } else if (startDate || endDate) {
      const effectiveStart = startDate || endDate!;
      const effectiveEnd = endDate || startDate!;
      const [s] = reportDayBounds(effectiveStart);
      const [, e] = reportDayBounds(effectiveEnd);
      where = 'WHERE o.created_at >= ? AND o.created_at < ?';
      params.push(s, e);
    }

    const recentOrders = db.prepare(`
      SELECT o.*, t.number as table_name, c.name as customer_name
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN customers c ON o.customer_id = c.id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT ?
    `).all(...params, limit);

    // #208: batch all items in one IN() query instead of per-order N+1.
    const orderIds = recentOrders.map((o: any) => o.id);
    const itemsByOrder = new Map<number, any[]>();
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, id`).all(...orderIds);
      for (const item of items as any[]) {
        const list = itemsByOrder.get(item.order_id) || [];
        list.push(item);
        itemsByOrder.set(item.order_id, list);
      }
    }
    const ordersWithItems = recentOrders.map((order: any) => ({
      ...order,
      items: itemsByOrder.get(order.id) || [],
    }));

    res.json({ recentOrders: ordersWithItems });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

router.get('/tables', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const [start, end] = reportDayBounds(reportToday());

    const tableStats = db.prepare(`
      SELECT t.*,
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as total_revenue,
        MAX(o.created_at) as last_order_at
      FROM tables t
      LEFT JOIN orders o ON t.id = o.table_id
        AND o.created_at >= ? AND o.created_at < ?
      GROUP BY t.id
    `).all(start, end);

    const tableUtilization = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) as reserved,
        SUM(CASE WHEN status = 'cleaning' THEN 1 ELSE 0 END) as cleaning,
        COUNT(*) as total
      FROM tables
    `).get();

    res.json({
      tableStats,
      tableUtilization
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

// ── GET /insights — dashboard metrics beyond today's snapshot ──────────────
// AOV, top staff, top categories, busiest/idlest hour & day-of-week, and
// average kitchen prep time, aggregated over a trailing window (default 30
// days) so hour/day patterns reflect a consistent trend rather than one day.
router.get('/insights', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
    // #208: "N days back" in the tenant's local calendar, with a UTC range
    // so the window filters on the index. The same timezone drives the
    // hour/day-of-week bucketing below.
    const timeZone = tenantTimezone();
    const today = reportToday();
    const startDateValue = new Date(`${today}T00:00:00Z`);
    startDateValue.setUTCDate(startDateValue.getUTCDate() - days);
    const startDate = startDateValue.toISOString().slice(0, 10);
    const [windowStart] = reportDayBounds(startDate);

    // AOV — same revenue basis ("paid bills") as the existing daily-stats tile.
    const revenue = db.prepare(`
      SELECT COUNT(*) as billCount,
        COALESCE(SUM(paid_amount), 0)
        - COALESCE((SELECT SUM(CAST(amount_cents AS REAL)) / ? FROM refunds WHERE created_at >= ?), 0) as total
      FROM bills
      WHERE paid_at >= ?
    `).get(minorFactor, windowStart, windowStart) as { billCount: number; total: number };
    const aov = revenue.billCount > 0 ? revenue.total / revenue.billCount : 0;

    // Kitchen velocity — substitutes for "best cook", which isn't derivable:
    // order_items has no per-chef attribution (marking an item ready doesn't
    // record who did it), so there's no data to rank individual cooks by.
    // Average prep time is the closest real signal for kitchen performance.
    const prepTime = db.prepare(`
      SELECT AVG((julianday(ready_at) - julianday(cooking_started_at)) * 24 * 60) as avgMinutes,
        COUNT(*) as sampleSize
      FROM orders
      WHERE cooking_started_at IS NOT NULL AND ready_at IS NOT NULL
        AND created_at >= ? AND status != 'cancelled'
    `).get(windowStart) as { avgMinutes: number | null; sampleSize: number };

    // Top staff by revenue — covers whoever creates orders (owner/manager/
    // cashier/server, per POST /orders' own role gate), i.e. "best cashier".
    const topStaff = db.prepare(`
      SELECT u.id as user_id, u.name, u.role,
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(o.id) as orderCount
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.created_at >= ? AND o.status != 'cancelled'
      GROUP BY u.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(windowStart);

    // Top categories by revenue.
    const topCategories = db.prepare(`
      SELECT c.id as category_id, COALESCE(c.name, 'Uncategorized') as name,
        COALESCE(SUM(oi.quantity), 0) as quantity,
        COALESCE(SUM(oi.subtotal), 0) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.created_at >= ? AND oi.status != 'cancelled'
      GROUP BY c.id
      ORDER BY revenue DESC
      LIMIT 5
    `).all(windowStart);

    // Busiest/idlest hour & day-of-week, bucketed in the tenant's local timezone.
    const orderTimestamps = (db.prepare(
      `SELECT created_at FROM orders WHERE created_at >= ? AND status != 'cancelled'`
    ).all(windowStart) as { created_at: string }[]).map((r) => r.created_at);

    const { hourCounts, dayCounts } = bucketByLocalHourAndWeekday(orderTimestamps, timeZone, tenantStartTime());

    // Hours with zero orders are excluded from busiest/idlest — almost
    // certainly "closed overnight" rather than a meaningful idle signal,
    // and would otherwise trivially always "win" idlest hour.
    const busiestHour = pickExtreme(hourCounts, 'max', (c) => c > 0);
    const idlestHour = pickExtreme(hourCounts, 'min', (c) => c > 0);

    // Day-of-week zero counts ARE kept — "closed Mondays" is a real,
    // useful signal, unlike an overnight hour with no foot traffic.
    const busiestDay = pickExtreme(dayCounts, 'max', () => true);
    const idlestDay = pickExtreme(dayCounts, 'min', () => true);

    res.json({
      windowDays: days,
      aov,
      ordersAnalyzed: orderTimestamps.length,
      avgPrepTimeMinutes: prepTime.sampleSize > 0 && prepTime.avgMinutes !== null ? Math.round(prepTime.avgMinutes) : null,
      topStaff,
      topCategories,
      busiestHour: busiestHour ? { hour: busiestHour.index, orderCount: busiestHour.count } : null,
      idlestHour: idlestHour ? { hour: idlestHour.index, orderCount: idlestHour.count } : null,
      busiestDayOfWeek: busiestDay ? { dayIndex: busiestDay.index, orderCount: busiestDay.count } : null,
      idlestDayOfWeek: idlestDay ? { dayIndex: idlestDay.index, orderCount: idlestDay.count } : null,
    });
  } catch (error: any) {
    console.error("[API] Internal error:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

// ── GET /x-report — live day report (cierre de caja, issue #649) ──────
// Reuses the snapshot pipeline from `cash-closures.ts` so the X read and
// the stored Z snapshot never drift apart. Same role gate as the other
// owner/manager reports. Refund attribution matches financial-summary
// (paid_at) for display totals; the cash-only expected figure includes active
// movements and uses refunds by `refunds.created_at` for drawer reality. The
// opening float is reported separately and intentionally excluded from X's
// expected figure.
//
// UNIT CONVENTIONS for the X envelope (do not rename fields):
//   * grossCollected, refunded, netCollected, paymentMethods[].total,
//     staffSales[].revenue, taxComponents are DISPLAY MAJOR UNITS
//     (minorFactor-divided, matching financial-summary / tax-components).
//   * expectedCashCents is INTEGER CENTS (drawer math; the consuming
//     client must convert the counted input to cents before subtracting).
//
// X vs Z expected (deliberate gap, not a bug):
//   X's expectedCashCents excludes the opening float, which is reported
//   separately. Same-day X and Z expected values therefore differ by exactly
//   opening_float_cents. Consumers must not compare them directly; X is the
//   live drawer expectation, Z is the point-in-time snapshot that bakes in the
//   float.
router.get('/x-report', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const today = reportToday();
    const date = reportDate(req.query.date, today);
    const db = getDatabase();
    const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
    const [periodStart, periodEnd] = reportDayBounds(date);

    const aggregates = computeDayAggregates(db, date);

    const closedRow = db.prepare(
      `SELECT z_number FROM cash_closures WHERE business_date = ? AND scope = 'day' LIMIT 1`
    ).get(date) as { z_number: number } | undefined;

    // F3: most recent prior closed day for this business date, used by the
    // modal to prefill the opening float (server-side one-shot query; the
    // frontend no longer walks back day-by-day).
    const priorRow = db.prepare(
      `SELECT business_date, counted_cash_cents FROM cash_closures
         WHERE business_date < ? AND scope = 'day'
         ORDER BY business_date DESC LIMIT 1`
    ).get(date) as { business_date: string; counted_cash_cents: number } | undefined;

    res.json({
      xReport: {
        businessDate: date,
        periodStart,
        periodEnd,
        grossCollected: aggregates.grossCollectedCents / minorFactor,
        refunded: aggregates.refundedCents / minorFactor,
        netCollected: aggregates.netCollectedCents / minorFactor,
        billCount: aggregates.billCount,
        refundCount: aggregates.refundCount,
        paymentMethods: aggregates.paymentMethods.map((row) => ({
          method: row.method,
          count: row.count,
          total: row.total_cents / minorFactor,
        })),
        staffSales: aggregates.staffSales.map((row) => ({
          user_id: row.user_id,
          name: row.name,
          role: row.role,
          revenue: row.revenue_cents / minorFactor,
          orderCount: row.orderCount,
        })),
        taxComponents: aggregates.taxComponents,
        openingFloatCents: aggregates.cashMovements.find((movement) => movement.movement_type === 'opening_float')?.amount_cents ?? null,
        payInCents: aggregates.payInCents,
        payOutCents: aggregates.payOutCents,
        safeDropCents: aggregates.safeDropCents,
        cashMovements: aggregates.cashMovements,
        expectedCashCents: aggregates.cashSalesCents
          + aggregates.payInCents
          - aggregates.payOutCents
          - aggregates.safeDropCents
          - aggregates.cashRefundsByCreatedAtCents,
        // F3: server-resolved prior close; null fields when no prior close
        // exists. The frontend only shows the "no prior close" hint when
        // this is genuinely null (never on transport error).
        priorClosedCashCents: priorRow?.counted_cash_cents ?? null,
        priorBusinessDate: priorRow?.business_date ?? null,
        alreadyClosed: !!closedRow,
        zNumber: closedRow?.z_number,
      },
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

// ── GET /z-report — stored day-close snapshot (cierre de caja, issue #649) ──────
// Reads the immutable `cash_closures` row for the requested business date.
// 404 with `{ alreadyClosed: false }` when no day-close row exists yet.
// Same role gate as /x-report.
router.get('/z-report', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const today = reportToday();
    const date = reportDate(req.query.date, today);
    const db = getDatabase();
    const row = db.prepare(
      `SELECT * FROM cash_closures WHERE business_date = ? AND scope = 'day' LIMIT 1`
    ).get(date) as any;
    if (!row) {
      return res.status(404).json({ error: 'Day not closed', alreadyClosed: false, businessDate: date });
    }
    // F6: resolve the operator's display name (id -> name) for the response.
    // Falls back to the raw id when the user row is missing.
    const userRow = db.prepare(`SELECT name FROM users WHERE id = ?`).get(row.closed_by) as { name: string } | undefined;
    res.json({
      zReport: {
        id: row.id,
        scope: row.scope,
        business_date: row.business_date,
        period_start: row.period_start,
        period_end: row.period_end,
        opening_float_cents: row.opening_float_cents,
        expected_cash_cents: row.expected_cash_cents,
        counted_cash_cents: row.counted_cash_cents,
        variance_cents: row.variance_cents,
        pay_in_cents: row.pay_in_cents,
        pay_out_cents: row.pay_out_cents,
        safe_drop_cents: row.safe_drop_cents,
        gross_collected_cents: row.gross_collected_cents,
        refunded_cents: row.refunded_cents,
        net_collected_cents: row.net_collected_cents,
        bill_count: row.bill_count,
        refund_count: row.refund_count,
        payment_methods: JSON.parse(row.payment_methods_json || '[]'),
        staff_sales: JSON.parse(row.staff_sales_json || '[]'),
        tax_components: JSON.parse(row.tax_components_json || '[]'),
        cash_movements: JSON.parse(row.cash_movements_json || '[]'),
        z_number: row.z_number,
        closed_by: row.closed_by,
        closed_by_name: userRow?.name ?? row.closed_by,
        notes: row.notes,
        created_at: row.created_at,
      },
    });
  } catch (error: any) {
    console.error('[API] Internal error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Internal server error" });
  }
});

// Owner-only daily sales export (xlsx workbook or summary/items CSV pair).
// Accounting lives in buildDailySalesExportDataset; serializers only encode.
router.get('/daily-sales/export', requirePermission('reports.daily-sales.export'), async (req: Request, res: Response) => {
  try {
    const date = reportDate(req.query.date, reportToday());
    const format = req.query.format === 'csv' ? 'csv' : req.query.format === 'xlsx' ? 'xlsx' : null;
    if (!format) {
      return res.status(400).json({ error: 'format must be xlsx or csv' });
    }
    const part = req.query.part === 'summary' || req.query.part === 'items' ? req.query.part : undefined;
    if (format === 'csv' && !part) {
      return res.status(400).json({ error: 'CSV export requires part=summary or part=items' });
    }

    const dataset = buildDailySalesExportDataset(date);
    const filename = dailySalesExportFilename(date, format, part);

    if (format === 'xlsx') {
      const buffer = await serializeDailySalesExportXlsx(dataset, {
        fractionDigits: getCurrencyFractionDigits(dataset.summary.currency),
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }

    const csv = serializeDailySalesExportCsv(dataset, part!);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (error: unknown) {
    const statusCode = typeof error === 'object' && error !== null
      ? (error as { statusCode?: number }).statusCode
      : undefined;
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (statusCode === 409) {
      return res.status(409).json({ error: message });
    }
    console.error('[API] Daily sales export error:', error);
    res.status(statusCode || 500).json({ error: statusCode ? message : 'Internal server error' });
  }
});

const REPORT_MAX_DAYS = 366;

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86_400_000) + 1;
}

interface PeriodOrderRow { id: string; created_at: string; subtotal: number; discount_amount: number; total: number }

function periodRefunds(db: ReturnType<typeof getDatabase>, startDate: string, endDate: string) {
  const minorFactor = getCurrencyMinorUnitFactor(getTenantCurrency(db));
  return (db.prepare('SELECT created_at, amount_cents FROM refunds WHERE created_at >= ? AND created_at < ?')
    .all(reportDayBounds(startDate)[0], reportDayBounds(endDate)[1]) as { created_at: string; amount_cents: number }[])
    .map((r) => ({ created_at: r.created_at, amount: new Decimal(r.amount_cents || 0).div(minorFactor) }));
}

export function periodSummary(db: ReturnType<typeof getDatabase>, startDate: string, endDate: string) {
  const orders = db.prepare(`
    SELECT id, created_at, subtotal, discount_amount, total
    FROM orders
    WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'
  `).all(reportDayBounds(startDate)[0], reportDayBounds(endDate)[1]) as PeriodOrderRow[];
  const refunds = periodRefunds(db, startDate, endDate);
  const refundTotal = refunds.reduce((sum, r) => sum.plus(r.amount), new Decimal(0));
  const netSales = orders.reduce((sum, o) => sum.plus(o.total || 0), new Decimal(0)).minus(refundTotal).toNumber();
  const discounts = orders.reduce((sum, o) => sum.plus(o.discount_amount || 0), new Decimal(0)).toNumber();
  return {
    orders,
    refunds,
    summary: {
      orders: orders.length,
      netSales,
      refunds: refundTotal.toNumber(),
      discounts,
      discountedOrders: orders.filter((o) => Number(o.discount_amount || 0) > 0).length,
      averageBill: orders.length ? new Decimal(netSales).div(orders.length).toNumber() : 0,
    },
  };
}

router.get('/period', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = reportToday();
    const startDate = reportDate(req.query.start_date, today);
    const endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) {
      return res.status(400).json({ error: 'start_date must be on or before end_date' });
    }
    const dayCount = daysBetween(startDate, endDate);
    if (dayCount > REPORT_MAX_DAYS) {
      return res.status(400).json({ error: `Report period cannot exceed ${REPORT_MAX_DAYS} days` });
    }
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    const canViewFinancials = hasPermission(userId, 'reports.financial.view');
    const timeZone = tenantTimezone();
    const startTime = tenantStartTime();
    const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });

    const current = periodSummary(db, startDate, endDate);
    const previousStart = shiftDate(startDate, -dayCount);
    const previousEnd = shiftDate(startDate, -1);
    const previous = periodSummary(db, previousStart, previousEnd).summary;

    const daily = new Map<string, { orders: number; sales: Decimal }>();
    for (let i = 0; i < dayCount; i++) daily.set(shiftDate(startDate, i), { orders: 0, sales: new Decimal(0) });
    const hourly = Array.from({ length: 24 }, () => ({ orders: 0, sales: new Decimal(0) }));
    for (const order of current.orders) {
      const at = parseDbTimestamp(order.created_at);
      const day = daily.get(localDateInTimezone(at, timeZone, startTime));
      if (day) { day.orders += 1; day.sales = day.sales.plus(order.total || 0); }
      const hour = parseInt(hourFmt.format(at), 10);
      if (hour >= 0 && hour <= 23) { hourly[hour].orders += 1; hourly[hour].sales = hourly[hour].sales.plus(order.total || 0); }
    }
    for (const refund of current.refunds) {
      const day = daily.get(localDateInTimezone(parseDbTimestamp(refund.created_at), timeZone, startTime));
      if (day) day.sales = day.sales.minus(refund.amount);
    }

    const itemRows = db.prepare(`
      SELECT oi.product_id, oi.product_name, p.category_id, p.cost AS unit_cost, p.id AS current_product_id,
        SUM(oi.quantity) AS quantity, SUM(oi.total) AS net, COUNT(DISTINCT oi.order_id) AS order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND oi.voided_at IS NULL
      GROUP BY oi.product_id, oi.product_name
      ORDER BY net DESC
    `).all(reportDayBounds(startDate)[0], reportDayBounds(endDate)[1]) as {
      product_id: string; product_name: string; category_id: string | null; unit_cost: number | null;
      current_product_id: string | null; quantity: number; net: number; order_count: number;
    }[];

    const categories = db.prepare('SELECT id, name, parent_id FROM categories').all() as { id: string; name: string; parent_id: string | null }[];
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const topCategoryName = (categoryId: string | null): string | null => {
      let category = categoryId ? categoryById.get(categoryId) : undefined;
      const seen = new Set<string>();
      while (category?.parent_id && categoryById.has(category.parent_id) && !seen.has(category.id)) {
        seen.add(category.id);
        category = categoryById.get(category.parent_id);
      }
      return category?.name ?? null;
    };

    const unitCosts = menuUnitCosts(db);
    const byCategory = new Map<string, { name: string | null; quantity: number; net: Decimal }>();
    const items = itemRows.map((row) => {
      const onMenu = row.current_product_id !== null;
      const categoryName = onMenu ? topCategoryName(row.category_id) : null;
      const key = categoryName ?? '';
      const bucket = byCategory.get(key) || { name: categoryName, quantity: 0, net: new Decimal(0) };
      bucket.quantity += Number(row.quantity || 0);
      bucket.net = bucket.net.plus(row.net || 0);
      byCategory.set(key, bucket);
      const unitCost = onMenu ? unitCosts.get(String(row.current_product_id)) ?? 0 : 0;
      const hasCost = onMenu && unitCost > 0;
      const cost = hasCost ? new Decimal(unitCost).times(row.quantity || 0).toNumber() : null;
      return {
        productId: row.product_id,
        name: row.product_name,
        category: categoryName,
        onMenu,
        quantity: Number(row.quantity || 0),
        orders: Number(row.order_count || 0),
        net: Number(row.net || 0),
        ...(canViewFinancials ? {
          cost,
          profit: cost === null ? null : new Decimal(row.net || 0).minus(cost).toNumber(),
        } : {}),
      };
    });

    res.json({
      period: { startDate, endDate, days: dayCount, previousStartDate: previousStart, previousEndDate: previousEnd },
      summary: current.summary,
      previous,
      daily: [...daily.entries()].map(([date, value]) => ({ date, orders: value.orders, sales: value.sales.toNumber() })),
      hourly: hourly.map((value, hour) => ({ hour, orders: value.orders, sales: value.sales.toNumber() })),
      paymentMethods: paymentMethodBreakdown(db, { startDate, endDate, paidOnly: true }),
      categories: [...byCategory.values()]
        .map((c) => ({ name: c.name, quantity: c.quantity, net: c.net.toNumber() }))
        .sort((a, b) => b.net - a.net),
      items,
      canViewFinancials,
    });
  } catch (error) {
    console.error('[API] Internal error:', error);
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    res.status(statusCode || 500).json({ error: statusCode ? message : 'Internal server error' });
  }
});

export function menuUnitCosts(db: ReturnType<typeof getDatabase>): Map<string, number> {
  const costs = new Map<string, number>();
  for (const recipe of listRecipes(db)) {
    if (recipe.cost_complete && Number(recipe.cost_per_serving) > 0) costs.set(String(recipe.product_id), Number(recipe.cost_per_serving));
  }
  for (const row of db.prepare('SELECT id, cost FROM products WHERE cost > 0').all() as { id: string; cost: number }[]) {
    costs.set(String(row.id), Number(row.cost));
  }
  return costs;
}

export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return shiftDate(date, -((d.getUTCDay() + 6) % 7));
}

interface WeekDay {
  date: string; orders: number; gross: Decimal; discounts: Decimal; refunds: Decimal; net: Decimal;
  payments: Map<string, Decimal>; cost: Decimal; costedLines: number;
}

export function weekDays(db: ReturnType<typeof getDatabase>, weekStart: string, paymentNames: Map<number, string>) {
  const timeZone = tenantTimezone();
  const startTime = tenantStartTime();
  const windowStart = reportDayBounds(weekStart)[0];
  const windowEnd = reportDayBounds(shiftDate(weekStart, 6))[1];
  const days = new Map<string, WeekDay>();
  for (let i = 0; i < 7; i++) {
    const date = shiftDate(weekStart, i);
    days.set(date, { date, orders: 0, gross: new Decimal(0), discounts: new Decimal(0), refunds: new Decimal(0), net: new Decimal(0), payments: new Map(), cost: new Decimal(0), costedLines: 0 });
  }
  const dayOf = (ts: string) => days.get(localDateInTimezone(parseDbTimestamp(ts), timeZone, startTime));

  const orders = db.prepare(`
    SELECT id, created_at, subtotal, discount_amount, total FROM orders
    WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'
  `).all(windowStart, windowEnd) as PeriodOrderRow[];
  const orderDay = new Map<string, WeekDay>();
  for (const order of orders) {
    const day = dayOf(order.created_at);
    if (!day) continue;
    orderDay.set(String(order.id), day);
    day.orders += 1;
    day.gross = day.gross.plus(order.subtotal || 0);
    day.discounts = day.discounts.plus(order.discount_amount || 0);
    day.net = day.net.plus(order.total || 0);
  }

  for (const refund of periodRefunds(db, weekStart, shiftDate(weekStart, 6))) {
    const day = dayOf(refund.created_at);
    if (!day) continue;
    day.refunds = day.refunds.plus(refund.amount);
    day.net = day.net.minus(refund.amount);
  }

  const bills = db.prepare(`
    SELECT b.order_id, b.payment_details FROM bills b JOIN orders o ON o.id = b.order_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND b.payment_status = 'paid'
  `).all(windowStart, windowEnd) as { order_id: string; payment_details: string | null }[];
  for (const bill of bills) {
    const day = orderDay.get(String(bill.order_id));
    if (!day) continue;
    let entries: { method?: string; payment_method_id?: number; amount?: number }[] = [];
    try { entries = JSON.parse(bill.payment_details || '[]'); } catch { entries = []; }
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = entry.method === 'custom'
        ? (paymentNames.get(Number(entry.payment_method_id)) ?? `custom:${entry.payment_method_id}`)
        : String(entry.method || 'unknown');
      day.payments.set(key, (day.payments.get(key) || new Decimal(0)).plus(entry.amount || 0));
    }
  }

  const lines = db.prepare(`
    SELECT oi.order_id, oi.quantity, p.id AS product_id FROM order_items oi
    JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND oi.voided_at IS NULL
  `).all(windowStart, windowEnd) as { order_id: string; quantity: number; product_id: string | null }[];
  const unitCosts = menuUnitCosts(db);
  let uncostedLines = 0;
  for (const line of lines) {
    const day = orderDay.get(String(line.order_id));
    if (!day) continue;
    const unitCost = line.product_id ? unitCosts.get(String(line.product_id)) ?? 0 : 0;
    if (unitCost > 0) {
      day.cost = day.cost.plus(new Decimal(unitCost).times(line.quantity || 0));
      day.costedLines += 1;
    } else {
      uncostedLines += 1;
    }
  }
  return { days: [...days.values()], uncostedLines };
}

export function buildWeeklyReport(db: ReturnType<typeof getDatabase>, weekStart: string, canViewFinancials: boolean) {
    const paymentNames = new Map(
      (db.prepare('SELECT id, name FROM payment_methods').all() as { id: number; name: string }[]).map((m) => [m.id, m.name]),
    );
    const current = weekDays(db, weekStart, paymentNames);
    const previous = weekDays(db, shiftDate(weekStart, -7), paymentNames);

    const methodTotals = new Map<string, Decimal>();
    for (const day of current.days) {
      for (const [method, amount] of day.payments) methodTotals.set(method, (methodTotals.get(method) || new Decimal(0)).plus(amount));
    }
    const paymentMethods = [...methodTotals.entries()].sort((a, b) => b[1].comparedTo(a[1])).map(([method]) => method);

    const anyCost = current.days.some((d) => d.costedLines > 0);
    const shape = (day: WeekDay, lastWeek?: WeekDay) => ({
      date: day.date,
      orders: day.orders,
      gross: day.gross.toNumber(),
      refunds: day.refunds.toNumber(),
      discounts: day.discounts.toNumber(),
      net: day.net.toNumber(),
      ...(lastWeek ? { lastWeekNet: lastWeek.net.toNumber() } : {}),
      payments: Object.fromEntries(paymentMethods.map((m) => [m, (day.payments.get(m) || new Decimal(0)).toNumber()])),
      ...(canViewFinancials ? {
        cost: anyCost ? day.cost.toNumber() : null,
        grossProfit: anyCost ? day.net.minus(day.cost).toNumber() : null,
      } : {}),
    });
    const totalOf = (days: WeekDay[]) => days.reduce((acc, d) => {
      acc.orders += d.orders; acc.gross = acc.gross.plus(d.gross); acc.refunds = acc.refunds.plus(d.refunds);
      acc.discounts = acc.discounts.plus(d.discounts); acc.net = acc.net.plus(d.net); acc.cost = acc.cost.plus(d.cost);
      acc.costedLines += d.costedLines;
      for (const [m, v] of d.payments) acc.payments.set(m, (acc.payments.get(m) || new Decimal(0)).plus(v));
      return acc;
    }, { date: '', orders: 0, gross: new Decimal(0), discounts: new Decimal(0), refunds: new Decimal(0), net: new Decimal(0), payments: new Map<string, Decimal>(), cost: new Decimal(0), costedLines: 0 } as WeekDay);
    const total = totalOf(current.days);
    const previousTotal = totalOf(previous.days);

    return {
      weekStart,
      weekEnd: shiftDate(weekStart, 6),
      paymentMethods,
      days: current.days.map((day, i) => shape(day, previous.days[i])),
      total: { ...shape(total, previousTotal), averageBill: total.orders ? total.net.div(total.orders).toNumber() : 0 },
      previous: {
        orders: previousTotal.orders,
        net: previousTotal.net.toNumber(),
        averageBill: previousTotal.orders ? previousTotal.net.div(previousTotal.orders).toNumber() : 0,
        ...(canViewFinancials && previous.days.some((d) => d.costedLines > 0) ? { grossProfit: previousTotal.net.minus(previousTotal.cost).toNumber() } : {}),
      },
      uncostedLines: canViewFinancials ? current.uncostedLines : undefined,
      canViewFinancials,
    };
}

router.get('/weekly', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const weekStart = mondayOf(reportDate(req.query.week_start, reportToday()));
    const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    res.json(buildWeeklyReport(db, weekStart, hasPermission(userId, 'reports.financial.view')));
  } catch (error) {
    console.error('[API] Internal error:', error);
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    res.status(statusCode || 500).json({ error: statusCode ? message : 'Internal server error' });
  }
});

interface CogsItem { productId: string; name: string; category: string | null; quantity: number; net: number; unitCost: number | null; cost: number | null; profit: number | null; previousMargin: number | null }

export function cogsItems(db: ReturnType<typeof getDatabase>, startDate: string, endDate: string, unitCosts: Map<string, number>) {
  const rows = db.prepare(`
    SELECT oi.product_id, oi.product_name, p.id AS current_product_id, p.category_id,
      SUM(oi.quantity) AS quantity, SUM(oi.total) AS net
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND oi.voided_at IS NULL
    GROUP BY oi.product_id, oi.product_name
  `).all(reportDayBounds(startDate)[0], reportDayBounds(endDate)[1]) as {
    product_id: string | null; product_name: string; current_product_id: string | null; category_id: string | null; quantity: number; net: number;
  }[];
  return rows.map((row) => {
    const unitCost = row.current_product_id ? unitCosts.get(String(row.current_product_id)) ?? null : null;
    const quantity = Number(row.quantity || 0);
    const net = Number(row.net || 0);
    const cost = unitCost === null ? null : new Decimal(unitCost).times(quantity).toNumber();
    return { row, productId: String(row.product_id ?? ''), name: row.product_name, quantity, net, unitCost, cost, profit: cost === null ? null : new Decimal(net).minus(cost).toNumber() };
  });
}

export function cogsTotals(items: { net: number; cost: number | null }[]) {
  let sales = new Decimal(0); let costedSales = new Decimal(0); let cost = new Decimal(0); let uncostedItems = 0;
  for (const item of items) {
    sales = sales.plus(item.net);
    if (item.cost === null) { uncostedItems += 1; continue; }
    costedSales = costedSales.plus(item.net);
    cost = cost.plus(item.cost);
  }
  const profit = costedSales.minus(cost);
  return {
    sales: sales.toNumber(), costedSales: costedSales.toNumber(), cost: cost.toNumber(), grossProfit: profit.toNumber(),
    margin: costedSales.gt(0) ? profit.div(costedSales).times(100).toNumber() : null,
    costPercent: costedSales.gt(0) ? cost.div(costedSales).times(100).toNumber() : null,
    uncostedSales: sales.minus(costedSales).toNumber(), uncostedItems,
  };
}

function monthStart(date: string, monthsBack: number): string {
  const [y, m] = date.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 1));
  return d.toISOString().slice(0, 10);
}

export function buildCogsReport(db: ReturnType<typeof getDatabase>, startDate: string, endDate: string, trendBy: 'week' | 'month') {
    const unitCosts = menuUnitCosts(db);

    const length = daysBetween(startDate, endDate);
    const previousEnd = shiftDate(startDate, -1);
    const previousStart = shiftDate(previousEnd, -(length - 1));
    const current = cogsItems(db, startDate, endDate, unitCosts);
    const previous = cogsItems(db, previousStart, previousEnd, unitCosts);
    const previousMargins = new Map<string, number>();
    for (const item of previous) {
      if (item.profit !== null && item.net > 0) previousMargins.set(`${item.productId}|${item.name}`, (item.profit / item.net) * 100);
    }

    const categories = db.prepare('SELECT id, name, parent_id FROM categories').all() as { id: string; name: string; parent_id: string | null }[];
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const topCategoryName = (categoryId: string | null): string | null => {
      let category = categoryId ? categoryById.get(categoryId) : undefined;
      const seen = new Set<string>();
      while (category?.parent_id && categoryById.has(category.parent_id) && !seen.has(category.id)) {
        seen.add(category.id);
        category = categoryById.get(category.parent_id);
      }
      return category?.name ?? null;
    };

    const items: CogsItem[] = current
      .map((item) => ({
        productId: item.productId,
        name: item.name,
        category: item.row.current_product_id ? topCategoryName(item.row.category_id) : null,
        quantity: item.quantity,
        net: item.net,
        unitCost: item.unitCost,
        cost: item.cost,
        profit: item.profit,
        previousMargin: previousMargins.get(`${item.productId}|${item.name}`) ?? null,
      }))
      .sort((a, b) => b.net - a.net);

    const trend: { start: string; end: string; sales: number; costedSales: number; cost: number; costPercent: number | null; margin: number | null }[] = [];
    const anchor = endDate;
    for (let i = trendBy === 'week' ? 7 : 5; i >= 0; i -= 1) {
      const start = trendBy === 'week' ? shiftDate(mondayOf(anchor), -7 * i) : monthStart(anchor, i);
      const end = trendBy === 'week' ? shiftDate(start, 6) : shiftDate(monthStart(anchor, i - 1), -1);
      const totals = cogsTotals(cogsItems(db, start, end, unitCosts));
      trend.push({ start, end, sales: totals.sales, costedSales: totals.costedSales, cost: totals.cost, costPercent: totals.costPercent, margin: totals.margin });
    }

    return {
      period: { startDate, endDate, days: length },
      previousPeriod: { startDate: previousStart, endDate: previousEnd },
      totals: cogsTotals(current),
      previous: cogsTotals(previous),
      items,
      trendBy,
      trend,
    };
}

router.get('/cogs', requirePermission('reports.financial.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const today = reportToday();
    let startDate = reportDate(req.query.start_date, today);
    let endDate = reportDate(req.query.end_date, today);
    if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
    res.json(buildCogsReport(db, startDate, endDate, req.query.trend === 'month' ? 'month' : 'week'));
  } catch (error) {
    console.error('[API] Internal error:', error);
    const { statusCode, message } = error as { statusCode?: number; message?: string };
    res.status(statusCode || 500).json({ error: statusCode ? message : 'Internal server error' });
  }
});

function sendReportError(res: Response, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Internal server error' });
  if (!statusCode) console.error('[reports] printout failed', error);
}
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/shift-report', requirePermission('cash.shifts.view'), (req: Request, res: Response) => {
  try {
    const id = Number(req.query.session_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'session_id is required' });
    res.json(buildShiftReport(id));
  } catch (error) { sendReportError(res, error); }
});

router.get('/daily-report', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const date = String(req.query.date || '');
    if (!DAY_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json(buildDailyReport(date));
  } catch (error) { sendReportError(res, error); }
});

router.post('/shift-report/telegram', requirePermission('cash.shifts.view'), async (req: Request, res: Response) => {
  try {
    const id = Number(req.body?.session_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'session_id is required' });
    const report = buildShiftReport(id);
    res.json(await sendPrintoutNow({ kind: 'shift', sessionId: id }, `${report.kind}-report shift #${id}`));
  } catch (error) { sendReportError(res, error); }
});

router.post('/daily-report/telegram', requirePermission('reports.view'), async (req: Request, res: Response) => {
  try {
    const date = String(req.body?.date || '');
    if (!DAY_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json(await sendPrintoutNow({ kind: 'daily', businessDate: date }, `Daily sales ${date}`));
  } catch (error) { sendReportError(res, error); }
});

export const reportRoutes = router;
