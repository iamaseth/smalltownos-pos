'use client';

import { useState } from 'react';
import { Beer, Plus, CreditCard, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Order } from '@/lib/types';

interface Props {
  tabs: Order[];
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

export default function OpenTabsModal({ tabs, now, payingOrderId, onAddItems, onPay, onClose }: Props) {
  const fmt = useFormatCurrency();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? tabs.filter((o) => `${o.tab_name ?? ''} ${o.order_number} ${o.customer?.name ?? ''}`.toLowerCase().includes(q))
    : tabs;
  const owedOf = (o: Order) => (o.bill?.payment_status === 'partial' ? Number(o.bill?.balance ?? o.total) : Number(o.total));
  const totalOwed = tabs.reduce((sum, o) => sum + owedOf(o), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Beer size={20} />Open tabs ({tabs.length})</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target rounded-full text-muted-foreground active:bg-muted"><X size={20} /></button>
        </div>
        {tabs.length > 0 && (
          <div className="relative mb-3">
            <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a tab by name, customer or number…"
              className="w-full rounded-xl border border-border bg-background py-2 ps-9 pe-3 text-sm outline-none focus:border-brand"
            />
          </div>
        )}
        {tabs.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No open tabs. Add items and tap Add to tab to start one.</p>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No tab matches “{query}”.</p>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {shown.map((order) => {
              const partial = order.bill?.payment_status === 'partial';
              return (
                <li key={order.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-foreground">{order.tab_name || `#${order.order_number}`}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      #{order.order_number} · {openFor(order.created_at, now)}{order.customer?.name ? ` · ${order.customer.name}` : ''}{partial ? ' · part paid' : ''}
                    </p>
                  </div>
                  <p className="w-20 shrink-0 text-end text-base font-bold tabular-nums">{fmt(owedOf(order))}</p>
                  <Button variant="outline" size="sm" onClick={() => onAddItems(order)}><Plus size={14} className="me-1" />Add</Button>
                  <Button size="sm" disabled={payingOrderId === order.id} onClick={() => onPay(order)}><CreditCard size={14} className="me-1" />Pay</Button>
                </li>
              );
            })}
          </ul>
        )}
        {tabs.length > 0 && (
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{q ? `${shown.length} of ${tabs.length} tabs` : `${tabs.length} tabs`}</span>
            <span className="font-bold tabular-nums">Total owed {fmt(totalOwed)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
