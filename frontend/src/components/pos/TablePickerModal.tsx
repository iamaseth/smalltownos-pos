'use client';

import { useMemo, useState } from 'react';
import { List, MapPinned, X } from 'lucide-react';
import type { Table } from '@/lib/types';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useTranslations, type AppConfig } from 'use-intl';
import { TableTurnoverBadge } from '@/components/tables/TableTurnoverBadge';
import { shapeFor } from '@/components/tables/FloorplanEditor';

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
    const named = [...new Set(tables.map((tb) => tb.floor).filter((f): f is string => Boolean(f)))].sort();
    return tables.some((tb) => !tb.floor) ? [...named, ''] : named;
  }, [tables]);
  const [activeFloor, setActiveFloor] = useState<string | null>(null);
  const floor = activeFloor !== null && floors.includes(activeFloor) ? activeFloor : (floors[0] ?? '');
  const floorTables = tables.filter((tb) => (tb.floor || '') === floor);
  const planTables = floorTables.filter(placed);
  const unplacedTables = floorTables.filter((tb) => !placed(tb));
  const showPlan = view === 'plan' && hasPlan;

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
      <div className={`bg-card rounded-2xl p-6 w-full ${showPlan ? 'max-w-4xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto`}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">{t('selectTable')}</h2>
          <div className="flex items-center gap-2">
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

        {showPlan && (
          <div className="relative mb-4 w-full overflow-hidden rounded-xl border border-border bg-muted/40" style={{ aspectRatio: '16 / 10' }}>
            {planTables.map((table) => {
              const isHeld = heldOrders.hasHeldOrder(table.id);
              const isSelected = selectedTableId === table.id;
              const isDisabled = table.status === 'cleaning';
              const shape = shapeFor(table.capacity);
              const order = table.current_order || table.activeOrder;
              const tone = isSelected ? 'border-brand bg-brand-light'
                : isHeld ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/40'
                : (statusStyles[table.status] || statusStyles.available).border;
              return (
                <button key={table.id} type="button" disabled={isDisabled} onClick={() => handleClick(table)}
                  aria-label={`${table.name} — ${t('tableSeats', { count: table.capacity })}`}
                  style={{ left: `${table.position_x}%`, top: `${table.position_y}%`, width: `${shape.w / 10}%`, aspectRatio: `${shape.w} / ${shape.h}`, minWidth: 64, minHeight: 56, transform: 'translate(-50%, -50%)' }}
                  className={`absolute flex flex-col items-center justify-center border-2 bg-card p-1 text-center leading-tight transition-colors ${shape.round ? 'rounded-full' : 'rounded-xl'} ${tone} ${isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                  <span className="max-w-full truncate text-sm font-bold text-foreground">{table.name}</span>
                  <span className="text-[10px] text-muted-foreground">{t('tableSeats', { count: table.capacity })}</span>
                  {(isHeld || order) && <span className="text-[10px] font-medium text-orange-600">{isHeld ? t('tableHeld') : `#${order?.order_number}`}</span>}
                  <span className={`absolute -top-1 -end-1 h-3 w-3 rounded-full border border-card ${isHeld ? 'bg-blue-500' : table.status === 'occupied' ? 'bg-orange-500' : table.status === 'reserved' ? 'bg-yellow-500' : table.status === 'cleaning' ? 'bg-gray-500' : 'bg-emerald-500'}`} />
                </button>
              );
            })}
            {planTables.length === 0 && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{t('noTablesFound')}</p>}
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
