'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { List, MapPinned, X } from 'lucide-react';
import type { Table } from '@/lib/types';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useTranslations, type AppConfig } from 'use-intl';
import { TableTurnoverBadge } from '@/components/tables/TableTurnoverBadge';
import { shapeFor, computeCanvasAspect, loadSavedCanvasSize, VIRTUAL_WIDTH } from '@/components/tables/FloorplanEditor';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { TABLE_STATUS_LABEL_KEYS } from '@/lib/i18n';

interface Props {
  tables: Table[];
  selectedTableId: string | null;
  onSelectAvailable: (tableId: string, customer?: { id: string; name: string; phone: string } | null) => void;
  onSelectOccupied: (table: Table) => void;
  onSelectHeld: (tableId: string) => void;
  onPlaceOrder: () => void;
  onHoldTable: (tableId: string) => void;
  onClose: () => void;
}

type PosKey = keyof AppConfig['Messages']['pos'];

const planTone: Record<string, string> = {
  available: 'border-emerald-700 bg-emerald-100 text-emerald-950 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-50',
  occupied: 'border-orange-700 bg-orange-100 text-orange-950 dark:border-orange-400 dark:bg-orange-950 dark:text-orange-50',
  reserved: 'border-yellow-600 bg-yellow-100 text-yellow-950 dark:border-yellow-400 dark:bg-yellow-950 dark:text-yellow-50',
  cleaning: 'border-gray-400 bg-gray-100 text-gray-700 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-200',
  held: 'border-blue-600 bg-blue-100 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-50',
};
const SECTION_PAD = 22;
const SECTION_LABEL = 26;

const statusStyles: Record<string, { border: string; badge: string; badgeKey: PosKey | null }> = {
  available: { border: 'border-border hover:border-brand/40', badge: '', badgeKey: null },
  occupied: { border: 'border-orange-300 dark:border-orange-800/40 bg-orange-50 dark:bg-orange-950/40', badge: 'bg-orange-500', badgeKey: 'tableOccupied' },
  reserved: { border: 'border-yellow-300 dark:border-yellow-800/40 bg-yellow-50 dark:bg-yellow-950/40', badge: 'bg-yellow-500', badgeKey: 'tableReserved' },
  cleaning: { border: 'border-gray-300 dark:border-border bg-muted', badge: 'bg-gray-500', badgeKey: 'tableCleaning' },
  held: { border: 'border-blue-400 dark:border-blue-800/40 bg-blue-50 dark:bg-blue-950/40', badge: 'bg-blue-500', badgeKey: 'tableHeld' },
};

export default function TablePickerModal({
  tables, selectedTableId, onSelectAvailable, onSelectOccupied, onSelectHeld, onPlaceOrder, onHoldTable, onClose,
}: Props) {
  const heldOrders = useHeldOrdersStore();
  const t = useTranslations('pos');
  const tTables = useTranslations('tables');
  const placed = (table: Table) => table.position_x != null && table.position_y != null;
  const hasPlan = tables.some(placed);
  const [view, setView] = useState<'plan' | 'list'>(hasPlan ? 'plan' : 'list');
  const floors = useMemo(() => {
    const count = (f: string) => tables.filter((tb) => (tb.floor || '') === f).length;
    const named = [...new Set(tables.map((tb) => tb.floor).filter((f): f is string => Boolean(f)))]
      .sort((a, b) => count(b) - count(a) || a.localeCompare(b));
    return tables.some((tb) => !tb.floor) ? [...named, ''] : named;
  }, [tables]);
  const [activeFloor, setActiveFloor] = useState<string | null>(null);
  const floor = activeFloor !== null && floors.includes(activeFloor) ? activeFloor : (floors[0] ?? '');
  const floorTables = tables.filter((tb) => (tb.floor || '') === floor);
  const planTables = floorTables.filter(placed);
  const unplacedTables = floorTables.filter((tb) => !placed(tb));
  const showPlan = view === 'plan' && hasPlan;
  const floorHasPlan = planTables.length > 0;
  const fmt = useFormatCurrency();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(VIRTUAL_WIDTH);
  const savedSize = loadSavedCanvasSize(floor);
  const roomAspect = savedSize.mode === 'custom'
    ? Math.max(1, Math.min(100, savedSize.w)) / Math.max(1, Math.min(100, savedSize.h))
    : computeCanvasAspect(planTables);
  const roomHeight = Math.round(VIRTUAL_WIDTH / roomAspect);
  const layout = useMemo(() => {
    const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    const all = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const tb of planTables) {
      const { w, h } = shapeFor(tb.capacity);
      const cx = (tb.position_x! / 100) * VIRTUAL_WIDTH;
      const cy = (tb.position_y! / 100) * roomHeight;
      all.minX = Math.min(all.minX, cx - w / 2); all.maxX = Math.max(all.maxX, cx + w / 2);
      all.minY = Math.min(all.minY, cy - h / 2); all.maxY = Math.max(all.maxY, cy + h / 2);
      const name = tb.section?.trim();
      if (!name) continue;
      const g = groups.get(name) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      g.minX = Math.min(g.minX, cx - w / 2); g.maxX = Math.max(g.maxX, cx + w / 2);
      g.minY = Math.min(g.minY, cy - h / 2); g.maxY = Math.max(g.maxY, cy + h / 2);
      groups.set(name, g);
    }
    const sections = [...groups.entries()].map(([name, g]) => ({
      name, left: g.minX - SECTION_PAD, top: g.minY - SECTION_PAD - SECTION_LABEL,
      width: g.maxX - g.minX + SECTION_PAD * 2, height: g.maxY - g.minY + SECTION_PAD * 2 + SECTION_LABEL,
    }));
    for (const sec of sections) {
      all.minX = Math.min(all.minX, sec.left); all.maxX = Math.max(all.maxX, sec.left + sec.width);
      all.minY = Math.min(all.minY, sec.top); all.maxY = Math.max(all.maxY, sec.top + sec.height);
    }
    const margin = 16;
    const w = Math.max(all.maxX - all.minX + margin * 2, 560);
    const h = Math.max(all.maxY - all.minY + margin * 2, 360);
    const view = { x: (all.minX + all.maxX - w) / 2, y: (all.minY + all.maxY - h) / 2, w, h };
    return { sections, view };
  }, [planTables, roomHeight]);
  const { sections, view: viewBox } = layout;
  const aspect = viewBox.w > 0 && viewBox.h > 0 ? viewBox.w / viewBox.h : roomAspect;
  const canvasScale = canvasWidth > 0 && viewBox.w > 0 ? canvasWidth / viewBox.w : 1;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => { if (el.clientWidth > 0) setCanvasWidth(el.clientWidth); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showPlan, floorHasPlan, floor]);

  const handleClick = (table: Table) => {
    if (heldOrders.hasHeldOrder(table.id)) {
      onSelectHeld(table.id);
      return;
    }
    if (table.status === 'occupied') {
      onSelectOccupied(table);
      return;
    }
    if (table.status === 'available' || table.status === 'reserved') {
      const customer = table.status === 'reserved' && table.reservation_customer_id
        ? { id: table.reservation_customer_id, name: table.reservation_customer_name ?? '', phone: table.reservation_customer_phone ?? '' }
        : null;
      onSelectAvailable(table.id, customer);
      return;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className={`bg-card rounded-2xl w-full ${showPlan ? 'max-w-[96vw] p-4' : 'max-w-lg p-6'} max-h-[94vh] overflow-y-auto`}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">{t('selectTable')}</h2>
          <div className="flex items-center gap-2">
          {showPlan && (
            <div className="me-2 hidden items-center gap-3 text-sm font-medium sm:flex">
              {(['available', 'occupied'] as const).map((st) => (
                <span key={st} className="flex items-center gap-1.5">
                  <span className={`inline-block h-4 w-4 rounded border-2 ${planTone[st]}`} />{tTables(TABLE_STATUS_LABEL_KEYS[st])}
                </span>
              ))}
            </div>
          )}
          {hasPlan && (
            <div className="flex rounded-xl border border-border p-1">
              <button type="button" onClick={() => setView('plan')} aria-pressed={showPlan}
                className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ${showPlan ? 'bg-brand text-white' : 'text-muted-foreground hover:bg-muted'}`}><MapPinned size={15} />{tTables('floorplanViewPlan')}</button>
              <button type="button" onClick={() => setView('list')} aria-pressed={!showPlan}
                className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium ${!showPlan ? 'bg-brand text-white' : 'text-muted-foreground hover:bg-muted'}`}><List size={15} />{tTables('floorplanViewList')}</button>
            </div>
          )}
          <button onClick={onClose} className="touch-target rounded-full text-gray-400 hover:text-muted-foreground active:bg-muted" aria-label={t('close')}>
            <X size={20} />
          </button>
          </div>
        </div>

        {showPlan && floors.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {floors.map((f) => (
              <button key={f || '__unassigned__'} type="button" onClick={() => setActiveFloor(f)}
                className={`h-10 rounded-full border px-4 text-sm font-medium ${f === floor ? 'border-brand bg-brand text-white' : 'border-border hover:bg-muted'}`}>{f || tTables('floor')}</button>
            ))}
          </div>
        )}

        {showPlan && !floorHasPlan && unplacedTables.length > 0 && (
          <p className="mb-3 text-sm text-muted-foreground">No room layout is saved for this floor yet. Set it up under Tables, then Layout.</p>
        )}

        {showPlan && floorHasPlan && (
          <div ref={canvasRef} data-testid="table-picker-plan"
            className="relative mx-auto mb-4 w-full overflow-hidden rounded-xl border border-border bg-card"
            style={{ aspectRatio: aspect, maxWidth: `calc((94vh - 9rem) * ${aspect})` }}>
            <div style={{ position: 'absolute', top: 0, left: 0, width: VIRTUAL_WIDTH, height: roomHeight, transform: `scale(${canvasScale}) translate(${-viewBox.x}px, ${-viewBox.y}px)`, transformOrigin: 'top left' }}>
              {sections.map((sec) => (
                <div key={sec.name} data-testid="table-picker-section" aria-hidden
                  className="absolute rounded-2xl border-2 border-dashed border-gray-400 bg-muted/70 dark:border-gray-600"
                  style={{ left: sec.left, top: sec.top, width: sec.width, height: sec.height }}>
                  <span className="absolute start-3 top-1 text-[15px] font-bold text-muted-foreground">{sec.name}</span>
                </div>
              ))}
              {planTables.map((table) => {
                const isHeld = heldOrders.hasHeldOrder(table.id);
                const isSelected = selectedTableId === table.id;
                const isDisabled = table.status === 'cleaning';
                const shape = shapeFor(table.capacity);
                const order = table.current_order || table.activeOrder;
                const tone = planTone[isHeld ? 'held' : table.status] || planTone.available;
                return (
                  <button key={table.id} type="button" disabled={isDisabled} onClick={() => handleClick(table)}
                    data-testid={`table-picker-table-${table.name}`}
                    aria-label={`${table.name} — ${tTables(TABLE_STATUS_LABEL_KEYS[isHeld ? 'held' : table.status])}`}
                    style={{ left: `${table.position_x}%`, top: `${table.position_y}%`, width: shape.w, height: shape.h }}
                    className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-[3px] p-1 text-center leading-tight ${shape.round ? 'rounded-full' : 'rounded-xl'} ${tone} ${isSelected ? 'ring-4 ring-brand ring-offset-2 ring-offset-card' : ''} ${isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                    <span className="max-w-full truncate text-lg font-black">{table.name}</span>
                    {isHeld ? <span className="text-xs font-bold">{t('tableHeld')}</span>
                      : order && Number(order.total) > 0 && <span className="max-w-full truncate text-sm font-bold">{fmt(Number(order.total))}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          {(showPlan ? unplacedTables : tables).map((table) => {
            const isHeld = heldOrders.hasHeldOrder(table.id);
            const isSelected = selectedTableId === table.id;
            const style = statusStyles[table.status] || statusStyles.available;
            const isDisabled = table.status === 'cleaning';

            return (
              <button
                key={table.id}
                onClick={() => !isDisabled && handleClick(table)}
                disabled={isDisabled}
                className={`min-h-28 p-4 rounded-xl border-2 text-center transition-colors relative ${
                  isSelected
                    ? 'border-brand bg-brand-light'
                    : isHeld
                      ? 'border-blue-400 bg-blue-50'
                      : style.border
                } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {isHeld && (
                  <span className="absolute -top-2 -end-2 bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                    {t('tableHeld')}
                  </span>
                )}
                {!isHeld && style.badgeKey && (
                  <span className={`absolute -top-2 -end-2 ${style.badge} text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold`}>
                    {t(style.badgeKey)}
                  </span>
                )}
                <p className="font-bold text-foreground">{table.name}</p>
                <p className="text-xs text-muted-foreground">{t('tableSeats', { count: table.capacity })}</p>
                {table.status === 'occupied' && (table.current_order || table.activeOrder) && (
                  <p className="text-xs text-orange-600 font-medium mt-1">
                    #{(table.current_order || table.activeOrder)?.order_number}
                  </p>
                )}
                {table.status === 'occupied' && Number((table.current_order || table.activeOrder)?.split_bills_total) > 0 && (
                  <p className="mt-1 inline-block rounded-full bg-orange-100 px-2 py-0.5 text-xs font-bold text-orange-800 dark:bg-orange-900/50 dark:text-orange-200">
                    {(table.current_order || table.activeOrder)?.split_bills_paid ?? 0} of {(table.current_order || table.activeOrder)?.split_bills_total} paid
                  </p>
                )}
                {table.status === 'occupied' && table.seated_at && (
                  <div className="mt-1"><TableTurnoverBadge seatedAt={table.seated_at} /></div>
                )}
              </button>
            );
          })}
        </div>

        {tables.length === 0 && (
          <p className="text-center text-muted-foreground py-8">{t('noTablesFound')}</p>
        )}

        {selectedTableId && (
          <div className="flex gap-3 mt-4 pt-4 border-t border-border">
            <button
              onClick={() => onHoldTable(selectedTableId)}
              className="touch-target flex-1 px-4 rounded-xl border-2 border-border text-foreground font-medium hover:bg-muted active:bg-muted transition-colors"
            >
              {t('holdTable')}
            </button>
            <button
              onClick={() => {
                onPlaceOrder();
                onClose();
              }}
              className="touch-target flex-1 px-4 rounded-xl bg-brand text-white font-medium hover:bg-brand/90 active:bg-brand/90 transition-colors"
            >
              {t('placeOrderButton')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
