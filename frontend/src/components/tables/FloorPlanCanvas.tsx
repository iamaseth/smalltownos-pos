'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Table } from '@/lib/types';
import { shapeFor, computeCanvasAspect, loadSavedCanvasSize, VIRTUAL_WIDTH } from '@/components/tables/FloorplanEditor';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { TABLE_STATUS_LABEL_KEYS } from '@/lib/i18n';

export const planTone: Record<string, string> = {
  available: 'border-emerald-700 bg-emerald-100 text-emerald-950 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-50',
  occupied: 'border-orange-700 bg-orange-100 text-orange-950 dark:border-orange-400 dark:bg-orange-950 dark:text-orange-50',
  reserved: 'border-yellow-600 bg-yellow-100 text-yellow-950 dark:border-yellow-400 dark:bg-yellow-950 dark:text-yellow-50',
  cleaning: 'border-gray-400 bg-gray-100 text-gray-700 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-200',
  held: 'border-blue-600 bg-blue-100 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-50',
};
const SECTION_PAD = 22;
const SECTION_LABEL = 26;

/** Room layout drawn exactly as saved in the floor planner, zoomed to fit its tables. */
export function FloorPlanCanvas({ floor, tables, onPick, isHeld = () => false, isDisabled = (tb) => tb.status === 'cleaning', selectedId = null, heldLabel, testIdPrefix = 'table-picker', reservedHeight = '9rem' }: {
  floor: string;
  tables: Table[];
  onPick: (table: Table) => void;
  isHeld?: (tableId: string) => boolean;
  isDisabled?: (table: Table) => boolean;
  selectedId?: string | null;
  heldLabel?: string;
  testIdPrefix?: string;
  reservedHeight?: string;
}) {
  const tTables = useTranslations('tables');
  const fmt = useFormatCurrency();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(VIRTUAL_WIDTH);
  const savedSize = loadSavedCanvasSize(floor);
  const roomAspect = savedSize.mode === 'custom'
    ? Math.max(1, Math.min(100, savedSize.w)) / Math.max(1, Math.min(100, savedSize.h))
    : computeCanvasAspect(tables);
  const roomHeight = Math.round(VIRTUAL_WIDTH / roomAspect);
  const { sections, view: viewBox } = useMemo(() => {
    const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
    const all = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const tb of tables) {
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
    const secs = [...groups.entries()].map(([name, g]) => ({
      name, left: g.minX - SECTION_PAD, top: g.minY - SECTION_PAD - SECTION_LABEL,
      width: g.maxX - g.minX + SECTION_PAD * 2, height: g.maxY - g.minY + SECTION_PAD * 2 + SECTION_LABEL,
    }));
    for (const sec of secs) {
      all.minX = Math.min(all.minX, sec.left); all.maxX = Math.max(all.maxX, sec.left + sec.width);
      all.minY = Math.min(all.minY, sec.top); all.maxY = Math.max(all.maxY, sec.top + sec.height);
    }
    const margin = 16;
    const w = Math.max(all.maxX - all.minX + margin * 2, 560);
    const h = Math.max(all.maxY - all.minY + margin * 2, 360);
    return { sections: secs, view: { x: (all.minX + all.maxX - w) / 2, y: (all.minY + all.maxY - h) / 2, w, h } };
  }, [tables, roomHeight]);
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
  }, [floor]);

  return (
    <div ref={canvasRef} data-testid={`${testIdPrefix}-plan`}
      className="relative mx-auto mb-4 w-full overflow-hidden rounded-xl border border-border bg-card"
      style={{ aspectRatio: aspect, maxWidth: `calc((94vh - ${reservedHeight}) * ${aspect})` }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: VIRTUAL_WIDTH, height: roomHeight, transform: `scale(${canvasScale}) translate(${-viewBox.x}px, ${-viewBox.y}px)`, transformOrigin: 'top left' }}>
        {sections.map((sec) => (
          <div key={sec.name} data-testid={`${testIdPrefix}-section`} aria-hidden
            className="absolute rounded-2xl border-2 border-dashed border-gray-400 bg-muted/70 dark:border-gray-600"
            style={{ left: sec.left, top: sec.top, width: sec.width, height: sec.height }}>
            <span className="absolute start-3 top-1 text-[15px] font-bold text-muted-foreground">{sec.name}</span>
          </div>
        ))}
        {tables.map((table) => {
          const held = isHeld(table.id);
          const disabled = isDisabled(table);
          const shape = shapeFor(table.capacity);
          const order = table.current_order || table.activeOrder;
          const tone = planTone[held ? 'held' : table.status] || planTone.available;
          return (
            <button key={table.id} type="button" disabled={disabled} onClick={() => onPick(table)}
              data-testid={`${testIdPrefix}-table-${table.name}`}
              aria-label={`${table.name} — ${tTables(TABLE_STATUS_LABEL_KEYS[held ? 'held' : table.status])}`}
              style={{ left: `${table.position_x}%`, top: `${table.position_y}%`, width: shape.w, height: shape.h }}
              className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-[3px] p-1 text-center leading-tight ${shape.round ? 'rounded-full' : 'rounded-xl'} ${tone} ${selectedId === table.id ? 'ring-4 ring-brand ring-offset-2 ring-offset-card' : ''} ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
              <span className="max-w-full truncate text-lg font-black">{table.name}</span>
              {held ? <span className="text-xs font-bold">{heldLabel}</span>
                : order && Number(order.total) > 0 && <span className="max-w-full truncate text-sm font-bold">{fmt(Number(order.total))}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
