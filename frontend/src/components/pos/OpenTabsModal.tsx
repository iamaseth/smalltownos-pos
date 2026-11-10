'use client';

import { useState } from 'react';
import { Beer, Plus, CreditCard, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Order, Table } from '@/lib/types';

interface Props {
  tabs: Order[];
  tables?: Table[];
  onOpenTable?: (table: Table) => void;
  now: number;
  payingOrderId: number | null;
  onAddItems: (order: Order) => void;
  onPay: (order: Order) => void;
  onClose: () => void;
}

function openFor(createdAt: string, now: number): string {
  const parsed = new Date(createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`).getTime();
  const minutes = Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 60000)) : 0;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d`;
}

type Row = { key: string; kind: 'tab' | 'table'; title: string; order: Order; table?: Table };
type Filter = 'all' | 'tabs' | 'tables';

export default function OpenTabsModal({ tabs, tables = [], onOpenTable, now, payingOrderId, onAddItems, onPay, onClose }: Props) {
  const fmt = useFormatCurrency();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const q = query.trim().toLowerCase();
  const tableRows: Row[] = tables.flatMap((table) => {
    const order = table.current_order || table.activeOrder;
    return table.status === 'occupied' && order ? [{ key: `t${table.id}`, kind: 'table' as const, title: table.name, order, table }] : [];
  });
  const tabRows: Row[] = tabs.map((order) => ({ key: `o${order.id}`, kind: 'tab' as const, title: order.tab_name || `#${order.order_number}`, order }));
  const all = [...tableRows, ...tabRows];
  const shown = all
    .filter((r) => filter === 'all' || (filter === 'tabs' ? r.kind === 'tab' : r.kind === 'table'))
    .filter((r) => !q || `${r.title} ${r.order.order_number} ${r.order.customer?.name ?? ''}`.toLowerCase().includes(q));
  const owedOf = (o: Order) => (o.bill?.payment_status === 'partial' ? Number(o.bill?.balance ?? o.total) : Number(o.total));
  const totalOwed = all.reduce((sum, r) => sum + owedOf(r.order), 0);
  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: all.length },
    { id: 'tabs', label: 'Tabs', count: tabRows.length },
    { id: 'tables', label: 'Tables', count: tableRows.length },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Beer size={20} />Open tabs &amp; tables ({all.length})</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target rounded-full text-muted-foreground active:bg-muted"><X size={20} /></button>
        </div>
        {all.length > 0 && (
          <>
            <div className="mb-2 flex gap-2">
              {filters.map((f) => (
                <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                  className={`rounded-full border px-3 py-1 text-sm font-medium ${filter === f.id ? 'border-brand bg-brand text-white' : 'border-border text-foreground'}`}>
                  {f.label} ({f.count})
                </button>
              ))}
            </div>
            <div className="relative mb-3">
              <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find by name, table, customer or number…"
                className="w-full rounded-xl border border-border bg-background py-2 ps-9 pe-3 text-sm outline-none focus:border-brand"
              />
            </div>
          </>
        )}
        {all.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Nothing open. Add items and tap Add to tab, or seat a table, to start one.</p>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Nothing matches.</p>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {shown.map(({ key, kind, title, order, table }) => {
              const partial = order.bill?.payment_status === 'partial';
              return (
                <li key={key} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate font-bold text-foreground">
                      {title}
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">{kind === 'table' ? 'Table' : 'Tab'}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      #{order.order_number} · {openFor(order.created_at, now)}{order.customer?.name ? ` · ${order.customer.name}` : ''}{partial ? ' · part paid' : ''}
                    </p>
                  </div>
                  <p className="w-20 shrink-0 text-end text-base font-bold tabular-nums">{fmt(owedOf(order))}</p>
                  {kind === 'table' && table ? (
                    <Button size="sm" onClick={() => onOpenTable?.(table)}>Open</Button>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={() => onAddItems(order)}><Plus size={14} className="me-1" />Add</Button>
                      <Button size="sm" disabled={payingOrderId === order.id} onClick={() => onPay(order)}><CreditCard size={14} className="me-1" />Pay</Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {all.length > 0 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{shown.length} of {all.length} shown</span>
            <span className="font-bold tabular-nums">Total owed {fmt(totalOwed)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
