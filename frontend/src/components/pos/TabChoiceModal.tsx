'use client';

import { useEffect, useState } from 'react';
import { Armchair, Beer, ShoppingBag, UserPlus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { parsePhone } from '@/lib/phone';
import type { Customer, Order } from '@/lib/types';
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
  const customer = useCartStore((st) => st.customer);
  const setCustomer = useCartStore((st) => st.setCustomer);
  const country = useAuthStore((st) => st.currentTenant?.country ?? '');
  const [matches, setMatches] = useState<Customer[]>([]);
  const [newPhone, setNewPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const searchText = customer ? '' : trimmed;
  const shownMatches = searchText.length >= 2 ? matches : [];

  useEffect(() => {
    if (searchText.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.get('/customers-search', { params: { q: searchText }, signal: controller.signal })
        .then(({ data }) => setMatches(Array.isArray(data) ? data : (data.customers || [])))
        .catch(() => { /* search is optional */ });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [searchText]);

  const pickCustomer = (c: Customer) => {
    setCustomer(c);
    if (!name.trim()) setName(c.name);
    setMatches([]); setNewPhone('');
  };

  const createCustomer = async () => {
    const parsed = newPhone.trim() ? parsePhone(newPhone, country) : null;
    if (newPhone.trim() && !parsed) { toast.error('That phone number is not valid'); return; }
    setCreating(true);
    try {
      const { data } = await api.post('/customers', parsed
        ? { name: searchText, phone: parsed.e164, country_code: parsed.countryCode }
        : { name: searchText });
      pickCustomer(data.customer);
      toast.success('Customer added');
    } catch {
      toast.error('Could not add customer (phone may already exist)');
    } finally {
      setCreating(false);
    }
  };

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

        <label className="mt-4 block text-sm font-medium text-muted-foreground" htmlFor="tab-name">Name (type a name, then tap Bar tab or Takeaway)</label>
        <input id="tab-name" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
          onFocus={() => setKeyboard(true)} placeholder="e.g. Tom, blue shirt" autoComplete="off"
          className="mt-1 h-12 w-full rounded-xl border border-border bg-background px-3 text-base outline-none focus:border-brand" />

        {(customer || searchText.length >= 2) && (
          <div className="mt-3">
            {customer ? (
              <div className="flex items-center justify-between rounded-xl border-2 border-brand bg-muted px-3 py-2 text-sm text-foreground">
                <span className="truncate font-semibold">Customer: {customer.name}{customer.phone ? ` · ${customer.phone}` : ''}</span>
                <button type="button" aria-label="Remove customer" onClick={() => setCustomer(null)} className="touch-target shrink-0"><X size={16} /></button>
              </div>
            ) : (
              <>
                {shownMatches.length > 0 && (
                  <>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{shownMatches.length} existing {shownMatches.length === 1 ? 'customer' : 'customers'} (tap to link, keeps their history)</p>
                    <div className="max-h-60 space-y-1 overflow-y-auto">
                      {shownMatches.map((c) => (
                        <button key={c.id} type="button" onClick={() => pickCustomer(c)}
                          className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-start text-sm hover:bg-muted">
                          <span className="truncate font-medium">{c.name}</span>
                          <span className="ms-2 shrink-0 text-xs text-muted-foreground">{c.phone || 'no phone'}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="mt-2 space-y-2 rounded-xl border border-dashed border-border p-3">
                  <p className="text-xs text-muted-foreground">{shownMatches.length > 0 ? 'Not them?' : 'No customer found.'} Save &ldquo;{searchText}&rdquo; as a customer so their visits are remembered (phone optional).</p>
                  <input type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (optional)"
                    className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-brand" />
                  <button type="button" disabled={creating} onClick={createCustomer}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand text-sm font-semibold text-white disabled:opacity-50">
                    <UserPlus size={16} />Add &ldquo;{searchText}&rdquo; as new customer
                  </button>
                </div>
              </>
            )}
          </div>
        )}

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
