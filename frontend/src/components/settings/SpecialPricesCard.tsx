'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Play, Plus, Search, Square, Trash2, X } from 'lucide-react';
import api from '@/lib/api';
import type { Product } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

interface EventItem { product_id: string; price: number }
interface SpecialEvent {
  id: string; name: string; enabled: boolean; mode: 'weekly' | 'date'; days: number[]; date: string | null;
  start: string; end: string; items: EventItem[]; show_banner: boolean; show_on_buttons: boolean; manual_until: string | null;
}
interface Snapshot { events: SpecialEvent[]; active: { id: string }[]; now: string }

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

function blankEvent(): SpecialEvent {
  return {
    id: `ev-${Date.now().toString(36)}`, name: '', enabled: true, mode: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], date: null,
    start: '17:00', end: '19:00', items: [], show_banner: true, show_on_buttons: true, manual_until: null,
  };
}

function scheduleText(e: SpecialEvent): string {
  const when = e.mode === 'date'
    ? (e.date ?? 'no date')
    : e.days.length === 7 ? 'Every day' : WEEK_ORDER.filter((d) => e.days.includes(d)).map((d) => DAY_LABELS[d]).join(', ');
  return `${when} · ${e.start}–${e.end} · ${e.items.length} drink${e.items.length === 1 ? '' : 's'}`;
}

/** Events with their own prices for chosen drinks: happy hour, live music nights, one-off parties. */
export function SpecialPricesCard() {
  const fmt = useFormatCurrency();
  const [events, setEvents] = useState<SpecialEvent[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [serverNow, setServerNow] = useState(0);
  const [products, setProducts] = useState<Product[]>([]);
  const [editing, setEditing] = useState<SpecialEvent | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (data: Snapshot) => { setEvents(data.events); setActiveIds(data.active.map((a) => a.id)); setServerNow(Date.parse(data.now) || 0); };

  const load = useCallback(() => Promise.all([api.get('/special-prices'), api.get('/products', { params: { per_page: 1000 } })])
    .then(([sp, pr]) => { apply(sp.data); setProducts(pr.data.products || []); })
    .catch((error) => toast.error(errorText(error, 'Could not load special prices'))), []);

  useEffect(() => { void load(); }, [load]);

  const productById = useMemo(() => new Map(products.map((p) => [String(p.id), p])), [products]);

  const saveAll = async (next: SpecialEvent[], message: string) => {
    setBusy(true);
    try {
      const { data } = await api.put('/special-prices', { events: next });
      apply(data);
      toast.success(message);
      return true;
    } catch (error) {
      toast.error(errorText(error, 'Could not save'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveEditing = async () => {
    if (!editing) return;
    const exists = events.some((e) => e.id === editing.id);
    const next = exists ? events.map((e) => (e.id === editing.id ? editing : e)) : [...events, editing];
    if (await saveAll(next, `${editing.name || 'Event'} saved`)) setEditing(null);
  };

  const toggle = (e: SpecialEvent) => saveAll(events.map((x) => (x.id === e.id ? { ...x, enabled: !x.enabled } : x)), e.enabled ? `${e.name} switched off` : `${e.name} switched on`);
  const remove = (e: SpecialEvent) => {
    if (!window.confirm(`Delete ${e.name}?`)) return;
    void saveAll(events.filter((x) => x.id !== e.id), `${e.name} deleted`);
  };
  const manual = async (e: SpecialEvent, start: boolean) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/special-prices/${e.id}/${start ? 'start' : 'stop'}`, start ? { hours: 2 } : {});
      apply(data);
      toast.success(start ? `${e.name} on for 2 hours` : `${e.name} stopped`);
    } catch (error) {
      toast.error(errorText(error, 'Could not change the event'));
    } finally {
      setBusy(false);
    }
  };

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !editing) return [];
    const taken = new Set(editing.items.map((i) => i.product_id));
    return products.filter((p) => !taken.has(String(p.id)) && p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [search, products, editing]);

  const input = 'h-11 rounded-lg border border-border bg-background px-3 text-base';
  const chip = (on: boolean) => `h-10 min-w-12 rounded-lg border px-3 text-sm font-semibold ${on ? 'border-emerald-600 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'border-border text-muted-foreground'}`;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Special prices</h2>
          <p className="text-sm text-muted-foreground">Events with their own prices for chosen drinks. If two events overlap, the lowest price wins.</p>
        </div>
        {!editing && <button type="button" onClick={() => { setEditing(blankEvent()); setSearch(''); }} className="flex h-10 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-semibold text-white"><Plus size={16} />New event</button>}
      </div>

      {!editing && (
        <div className="space-y-2">
          {events.length === 0 && <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No events yet. Add happy hour, a live music night or a party.</p>}
          {events.map((e) => {
            const live = activeIds.includes(e.id);
            return (
              <div key={e.id} className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${live ? 'border-emerald-600' : 'border-border'}`}>
                <button type="button" onClick={() => { setEditing({ ...e, items: [...e.items] }); setSearch(''); }} className="min-w-0 flex-1 text-start">
                  <p className="font-semibold text-foreground">{e.name} {live && <span className="ms-1 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">On now</span>}{e.mode === 'date' && <span className="ms-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">one date</span>}</p>
                  <p className="text-sm text-muted-foreground">{scheduleText(e)}</p>
                </button>
                {e.manual_until && Date.parse(e.manual_until) > serverNow
                  ? <button type="button" disabled={busy} onClick={() => manual(e, false)} className="flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-semibold"><Square size={14} />Stop</button>
                  : <button type="button" disabled={busy} onClick={() => manual(e, true)} className="flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-semibold"><Play size={14} />Start now</button>}
                <button type="button" role="switch" aria-checked={e.enabled} aria-label={`${e.name} on or off`} disabled={busy} onClick={() => toggle(e)}
                  className={`relative h-7 w-12 rounded-full ${e.enabled ? 'bg-emerald-600' : 'bg-muted-foreground/40'}`}>
                  <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${e.enabled ? 'end-1' : 'start-1'}`} />
                </button>
                <button type="button" aria-label={`Delete ${e.name}`} disabled={busy} onClick={() => remove(e)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><Trash2 size={16} /></button>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Event name</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={40} placeholder="Happy hour" className={`${input} w-full`} />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">When</p>
            <div className="mb-2 flex gap-2">
              <button type="button" onClick={() => setEditing({ ...editing, mode: 'weekly' })} className={chip(editing.mode === 'weekly')}>Every week</button>
              <button type="button" onClick={() => setEditing({ ...editing, mode: 'date' })} className={chip(editing.mode === 'date')}>One date</button>
            </div>
            {editing.mode === 'weekly' ? (
              <div className="flex flex-wrap gap-1.5">
                {WEEK_ORDER.map((d) => (
                  <button key={d} type="button" aria-pressed={editing.days.includes(d)}
                    onClick={() => setEditing({ ...editing, days: editing.days.includes(d) ? editing.days.filter((x) => x !== d) : [...editing.days, d] })}
                    className={chip(editing.days.includes(d))}>{DAY_LABELS[d]}</button>
                ))}
              </div>
            ) : (
              <input type="date" value={editing.date ?? ''} onChange={(e) => setEditing({ ...editing, date: e.target.value || null })} className={input} />
            )}
            <div className="mt-2 flex items-center gap-2">
              <input type="time" value={editing.start} onChange={(e) => setEditing({ ...editing, start: e.target.value })} className={input} aria-label="Start time" />
              <span className="text-sm text-muted-foreground">to</span>
              <input type="time" value={editing.end} onChange={(e) => setEditing({ ...editing, end: e.target.value })} className={input} aria-label="End time" />
              {editing.end <= editing.start && <span className="text-xs text-muted-foreground">ends the next day</span>}
            </div>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">Drinks and event price</p>
            <div className="space-y-1.5">
              {editing.items.map((it) => {
                const p = productById.get(it.product_id);
                return (
                  <div key={it.product_id} className="grid grid-cols-[minmax(0,1fr)_80px_110px_32px] items-center gap-2 rounded-lg border border-border px-3 py-1.5">
                    <span className="truncate font-medium">{p?.name ?? 'Removed item'}</span>
                    <span className="text-sm text-muted-foreground">{p ? fmt(Number(p.price)) : '—'}</span>
                    <input type="number" inputMode="decimal" min="0" step="0.01" aria-label={`${p?.name ?? 'Item'} event price`} value={Number.isFinite(it.price) ? it.price : ''}
                      onChange={(e) => setEditing({ ...editing, items: editing.items.map((x) => (x.product_id === it.product_id ? { ...x, price: Number(e.target.value) } : x)) })}
                      className={`${input} h-9 w-full`} />
                    <button type="button" aria-label={`Remove ${p?.name ?? 'item'}`} onClick={() => setEditing({ ...editing, items: editing.items.filter((x) => x.product_id !== it.product_id) })} className="rounded p-1 text-muted-foreground hover:bg-muted"><X size={16} /></button>
                  </div>
                );
              })}
            </div>
            <label className="relative mt-2 block">
              <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Add a drink…" className={`${input} w-full ps-9`} />
            </label>
            {matches.length > 0 && (
              <div className="mt-1 overflow-hidden rounded-lg border border-border">
                {matches.map((p) => (
                  <button key={p.id} type="button" onClick={() => { setEditing({ ...editing, items: [...editing.items, { product_id: String(p.id), price: Number(p.price) }] }); setSearch(''); }}
                    className="flex w-full justify-between border-b border-border px-3 py-2 text-start text-sm last:border-0 hover:bg-muted">
                    <span>{p.name}</span><span className="text-muted-foreground">{fmt(Number(p.price))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={editing.show_banner} onChange={(e) => setEditing({ ...editing, show_banner: e.target.checked })} />Show a banner on the POS while it is on</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={editing.show_on_buttons} onChange={(e) => setEditing({ ...editing, show_on_buttons: e.target.checked })} />Show the event price on product buttons</label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="h-10 rounded-lg border border-border px-4 text-sm font-semibold">Cancel</button>
            <button type="button" disabled={busy} onClick={saveEditing} className="h-10 rounded-lg bg-brand px-5 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save event'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
