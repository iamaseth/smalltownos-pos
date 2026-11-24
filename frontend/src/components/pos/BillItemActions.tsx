'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeftRight, Flame, Gift, NotebookPen, Percent, Plus, Replace, Search, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import type { Order, OrderItem, Product, Table } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

const CHANGE_WINDOW_MS = 5 * 60_000;

export function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export function sentAtMs(item: OrderItem): number {
  const raw = String(item.created_at || '');
  const ms = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

export function withinChangeWindow(item: OrderItem): boolean {
  const age = Date.now() - sentAtMs(item);
  return age >= 0 && age <= CHANGE_WINDOW_MS;
}

function Shell({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`dark max-h-[92vh] w-full ${wide ? 'max-w-3xl' : 'max-w-md'} overflow-y-auto rounded-2xl border-2 border-neutral-700 bg-neutral-950 p-5 text-white`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-black">{title}</h2>
            {subtitle && <p className="text-sm font-semibold text-neutral-300">{subtitle}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-neutral-600 bg-neutral-900 hover:bg-neutral-800"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const bigBtn = 'flex h-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-base font-bold text-white hover:bg-neutral-800 disabled:opacity-40';

export type ItemAction = 'change' | 'note' | 'discount' | 'free' | 'move' | 'rush' | 'more' | 'remove';

export function ItemActionsPanel({ item, canDiscount, canRemove, onPick, onClose }: {
  item: OrderItem; canDiscount: boolean; canRemove: boolean; onPick: (action: ItemAction) => void; onClose: () => void;
}) {
  const fmt = useFormatCurrency();
  const hasAddons = Array.isArray(item.addons) && item.addons.length > 0;
  const sent = sentAtMs(item);
  const sentText = sent ? new Date(sent).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const buttons: [ItemAction, string, ReactNode, boolean][] = [
    ['change', 'Change', <Replace key="c" size={24} />, true],
    ['note', 'Note', <NotebookPen key="n" size={24} />, true],
    ['discount', 'Discount', <Percent key="d" size={24} />, canDiscount && !item.comped_at],
    ['free', 'Free', <Gift key="f" size={24} />, !item.comped_at],
    ['move', 'Move', <ArrowLeftRight key="m" size={24} />, true],
    ['rush', 'Rush', <Flame key="r" size={24} />, true],
  ];
  return (
    <Shell title={`${item.quantity} × ${item.product_name}`} subtitle={`${fmt(Number(item.total))}${sentText ? ` · sent ${sentText}` : ''}${item.special_instructions ? ` · ${item.special_instructions}` : ''}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {buttons.map(([key, label, icon, enabled]) => (
          <button key={key} type="button" disabled={!enabled} onClick={() => onPick(key)} className={bigBtn}>{icon}{label}</button>
        ))}
      </div>
      {!hasAddons && !item.comped_at && (
        <button type="button" onClick={() => onPick('more')} className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-base font-bold hover:bg-neutral-800">
          <Plus size={20} />Add 1 more
        </button>
      )}
      {canRemove && (
        <>
          <button type="button" onClick={() => onPick('remove')} className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-red-700 bg-red-950 text-base font-bold text-red-200 hover:bg-red-900">
            <Trash2 size={20} />Remove
          </button>
          <p className="mt-2 text-center text-sm text-neutral-400">Already sent to the kitchen: Remove needs a manager PIN</p>
        </>
      )}
    </Shell>
  );
}

export function NoteDialog({ item, onSave, onClose }: { item: OrderItem; onSave: (note: string) => Promise<void>; onClose: () => void }) {
  const [note, setNote] = useState(item.special_instructions || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await onSave(note); } finally { setBusy(false); }
  };
  return (
    <Shell title="Note" subtitle={`${item.quantity} × ${item.product_name}`} onClose={onClose}>
      <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={3} placeholder="no ice, no chili…"
        className="w-full rounded-xl border-2 border-neutral-600 bg-neutral-900 p-3 text-lg text-white" />
      <p className="mt-1 text-sm text-neutral-400">The kitchen gets a NOTE ticket.</p>
      <button type="button" disabled={busy || note.trim() === (item.special_instructions || '').trim()} onClick={save}
        className="mt-3 h-14 w-full rounded-xl bg-green-500 text-lg font-black text-black hover:bg-green-400 disabled:opacity-40">{busy ? 'Saving…' : 'Save note'}</button>
    </Shell>
  );
}

function PinInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="text" inputMode="numeric" autoComplete="off" name="approval-pin" data-1p-ignore data-lpignore="true" aria-label="Manager PIN"
      value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="Manager PIN"
      style={{ WebkitTextSecurity: 'disc' } as CSSProperties}
      className="w-full rounded-xl border-2 border-neutral-600 bg-neutral-900 px-3 py-3 text-center text-2xl tracking-[0.4em] text-white" />
  );
}

export function ChangeItemDialog({ item, onChange, onClose }: {
  item: OrderItem; onChange: (product: Product, note: string, pin: string) => Promise<void>; onClose: () => void;
}) {
  const fmt = useFormatCurrency();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Product | null>(null);
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const needsPin = !withinChangeWindow(item);

  useEffect(() => {
    api.get('/products', { params: { per_page: 500 } })
      .then(({ data }) => setProducts((data.products || []).filter((p: Product) => p.is_active !== false)))
      .catch(() => { setProducts([]); toast.error('Could not load the menu'); });
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products || []).filter((p) => !q || p.name.toLowerCase().includes(q)).slice(0, 60);
  }, [products, search]);

  const confirm = async () => {
    if (!picked) return;
    setBusy(true);
    try { await onChange(picked, note.trim(), pin); } finally { setBusy(false); }
  };

  return (
    <Shell title="Change item" subtitle={`Replace ${item.quantity} × ${item.product_name}`} onClose={onClose} wide>
      {!picked ? (
        <>
          <label className="relative block">
            <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search menu"
              className="h-12 w-full rounded-xl border-2 border-neutral-600 bg-neutral-900 ps-10 pe-3 text-lg text-white" />
          </label>
          <div className="mt-3 grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {products === null && <p className="col-span-full py-6 text-center text-neutral-400">Loading menu…</p>}
            {shown.map((p) => (
              <button key={p.id} type="button" onClick={() => setPicked(p)}
                className="flex min-h-16 flex-col justify-between rounded-xl border-2 border-neutral-700 bg-neutral-900 p-3 text-start hover:bg-neutral-800">
                <span className="font-bold leading-tight">{p.name}</span>
                <span className="text-sm font-semibold text-neutral-300">{fmt(Number(p.price))}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div className="rounded-xl border-2 border-neutral-700 bg-neutral-900 p-4 text-lg">
            <p className="font-bold text-red-300 line-through">{item.quantity} × {item.product_name}</p>
            <p className="font-black text-green-300">{item.quantity} × {picked.name} · {fmt(Number(picked.price) * Number(item.quantity))}</p>
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Note for the kitchen (optional)"
            className="h-12 w-full rounded-xl border-2 border-neutral-600 bg-neutral-900 px-3 text-lg text-white" />
          {needsPin && (
            <div>
              <p className="mb-1 text-sm font-semibold text-amber-300">Sent more than 5 minutes ago: manager PIN needed</p>
              <PinInput value={pin} onChange={setPin} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setPicked(null)} className="h-14 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-lg font-bold hover:bg-neutral-800">Back</button>
            <button type="button" disabled={busy || (needsPin && !pin)} onClick={confirm}
              className="h-14 rounded-xl bg-green-500 text-lg font-black text-black hover:bg-green-400 disabled:opacity-40">{busy ? 'Changing…' : 'Change'}</button>
          </div>
          <p className="text-center text-sm text-neutral-400">The kitchen gets a CHANGE ticket.</p>
        </div>
      )}
    </Shell>
  );
}

const tableTone: Record<string, string> = {
  available: 'border-emerald-500 bg-emerald-950 text-emerald-50',
  occupied: 'border-orange-500 bg-orange-950 text-orange-50',
};

export function MoveItemsDialog({ order, items, currentTableId, tables, initialIds, onMove, onClose }: {
  order: Order; items: OrderItem[]; currentTableId: string; tables: Table[]; initialIds: number[];
  onMove: (itemIds: number[], target: Table) => Promise<void>; onClose: () => void;
}) {
  const fmt = useFormatCurrency();
  const [selected, setSelected] = useState<number[]>(initialIds);
  const [busy, setBusy] = useState(false);
  const toggle = (id: number) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const all = selected.length === items.length;
  const targets = tables.filter((tb) => tb.id !== currentTableId && tb.is_active !== false && ['available', 'occupied'].includes(tb.status));
  const sections = [...new Set(targets.map((tb) => tb.section?.trim() || ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const move = async (target: Table) => {
    if (selected.length === 0) return;
    setBusy(true);
    try { await onMove(selected, target); } finally { setBusy(false); }
  };
  return (
    <Shell title="Move" subtitle={`Order ${order.order_number}`} onClose={onClose} wide>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-bold uppercase tracking-wide text-neutral-300">1. Which items?</p>
        <button type="button" onClick={() => setSelected(all ? [] : items.map((i) => Number(i.id)))} className="text-sm font-bold text-blue-300 underline">{all ? 'Clear all' : 'Select all'}</button>
      </div>
      <div className="space-y-2">
        {items.map((it) => {
          const on = selected.includes(Number(it.id));
          return (
            <button key={it.id} type="button" aria-pressed={on} onClick={() => toggle(Number(it.id))}
              className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-start ${on ? 'border-blue-500 bg-blue-950' : 'border-neutral-700 bg-neutral-900'}`}>
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-2 text-lg font-black ${on ? 'border-blue-400 bg-blue-500 text-white' : 'border-neutral-500'}`}>{on ? '✓' : ''}</span>
              <span className="flex-1 text-lg font-bold">{it.quantity} × {it.product_name}</span>
              <span className="font-bold tabular-nums">{fmt(Number(it.total))}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-5 mb-2 text-sm font-bold uppercase tracking-wide text-neutral-300">2. To which table?</p>
      {selected.length === 0 && <p className="text-sm text-amber-300">Tick at least one item first.</p>}
      <div className="space-y-3">
        {sections.map((sec) => (
          <div key={sec || '__none__'}>
            {sec && <p className="mb-1 text-sm font-bold text-neutral-400">{sec}</p>}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {targets.filter((tb) => (tb.section?.trim() || '') === sec).map((tb) => (
                <button key={tb.id} type="button" disabled={busy || selected.length === 0} onClick={() => move(tb)}
                  className={`flex h-16 flex-col items-center justify-center rounded-xl border-[3px] text-lg font-black disabled:opacity-40 ${tableTone[tb.status] || tableTone.available}`}>
                  {tb.name}
                  {tb.status === 'occupied' && <span className="text-xs font-bold">add to bill</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
