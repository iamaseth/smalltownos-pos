'use client';

import { useEffect, useState } from 'react';
import { Armchair, Beer, ShoppingBag, X } from 'lucide-react';
import api from '@/lib/api';
import type { Order } from '@/lib/types';
import OnScreenKeyboard from '@/components/pos/OnScreenKeyboard';

interface Props {
  onChooseTable: () => void;
  onNewTab: (name: string) => void;
  onTakeaway: (name: string) => void;
  onOpenTab: (order: Order) => void;
  onClose: () => void;
}

export default function TabChoiceModal({ onChooseTable, onNewTab, onTakeaway, onOpenTab, onClose }: Props) {
  const [name, setName] = useState('');
  const [openTabs, setOpenTabs] = useState<Order[]>([]);
  const [keyboard, setKeyboard] = useState(false);
  const trimmed = name.trim();

  useEffect(() => {
    let cancelled = false;
    api.get('/orders', { params: { status: 'pending,preparing,ready,served', per_page: 500 } })
      .then(({ data }) => {
        if (!cancelled) setOpenTabs(((data.orders || []) as Order[]).filter((o) => !o.table_id && o.tab_name));
      })
      .catch(() => { /* list is optional */ });
    return () => { cancelled = true; };
  }, []);

  const big = 'flex h-20 flex-1 flex-col items-center justify-center gap-1 rounded-xl border-2 border-border text-sm font-semibold hover:bg-muted active:bg-muted';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Where does this order go?</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="touch-target rounded-full text-muted-foreground active:bg-muted"><X size={20} /></button>
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onChooseTable} className={big}><Armchair size={22} />Table</button>
          <button type="button" disabled={!trimmed} onClick={() => onNewTab(trimmed)} className={`${big} disabled:opacity-40`}><Beer size={22} />Bar tab</button>
          <button type="button" onClick={() => onTakeaway(trimmed)} className={big}><ShoppingBag size={22} />Takeaway</button>
        </div>

        <label className="mt-4 block text-sm font-medium text-muted-foreground" htmlFor="tab-name">Name for the tab or takeaway</label>
        <input id="tab-name" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
          onFocus={() => setKeyboard(true)} placeholder="e.g. Tom, blue shirt" autoComplete="off"
          className="mt-1 h-12 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-brand" />

        {openTabs.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium text-muted-foreground">Open bar tabs</p>
            <div className="grid grid-cols-2 gap-2">
              {openTabs.map((order) => (
                <button key={order.id} type="button" onClick={() => onOpenTab(order)}
                  className="rounded-xl border-2 border-orange-300 bg-orange-50 p-3 text-start dark:border-orange-800/40 dark:bg-orange-950/40">
                  <span className="block truncate font-bold text-foreground">{order.tab_name}</span>
                  <span className="text-xs text-muted-foreground">#{order.order_number}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {keyboard && <OnScreenKeyboard value={name} onChange={setName} onClose={() => setKeyboard(false)} />}
    </div>
  );
}
