'use client';

import { Beer, Plus, CreditCard, X } from 'lucide-react';
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Beer size={20} />Open tabs ({tabs.length})</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target rounded-full text-muted-foreground active:bg-muted"><X size={20} /></button>
        </div>
        {tabs.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No open tabs. Add items and tap Add to tab to start one.</p>
        ) : (
          <div className="min-h-0 space-y-2 overflow-y-auto">
            {tabs.map((order) => {
              const partial = order.bill?.payment_status === 'partial';
              const owed = Number(order.bill?.balance ?? order.total);
              return (
                <div key={order.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-bold text-foreground">{order.tab_name}</p>
                      <p className="text-xs text-muted-foreground">#{order.order_number} · open {openFor(order.created_at, now)}{order.customer?.name ? ` · ${order.customer.name}` : ''}</p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="text-lg font-bold tabular-nums">{fmt(partial ? owed : Number(order.total))}</p>
                      {partial && <p className="text-xs text-amber-500">still owed</p>}
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={() => onAddItems(order)}><Plus size={16} className="me-1" />Add items</Button>
                    <Button className="flex-1" disabled={payingOrderId === order.id} onClick={() => onPay(order)}><CreditCard size={16} className="me-1" />Pay</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
