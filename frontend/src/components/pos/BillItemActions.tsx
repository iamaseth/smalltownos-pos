'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeftRight, Flame, Gift, List, MapPinned, Minus, NotebookPen, Percent, Plus, Replace, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { FloorPlanCanvas, planTone } from '@/components/tables/FloorPlanCanvas';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import type { CartItem, Order, OrderItem, Product, Table } from '@/lib/types';
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
        className={`dark max-h-[94vh] w-full ${wide ? 'max-w-5xl' : 'max-w-md'} overflow-y-auto rounded-2xl border-2 border-neutral-700 bg-neutral-950 p-5 text-white`}>
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

const bigBtn = 'flex h-24 flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-lg font-bold text-white hover:brightness-125 disabled:opacity-40';

export type ActionTone = 'move' | 'change' | 'discount' | 'add' | 'note' | 'free' | 'rush' | 'print' | 'remove';
const TONES: Record<ActionTone, { bg: string; border: string; text: string }> = {
  move: { bg: '#0C447C', border: '#378ADD', text: '#ffffff' },
  change: { bg: '#0C447C', border: '#378ADD', text: '#ffffff' },
  discount: { bg: '#3C3489', border: '#7F77DD', text: '#ffffff' },
  add: { bg: '#085041', border: '#1D9E75', text: '#ffffff' },
  note: { bg: '#633806', border: '#EF9F27', text: '#ffffff' },
  free: { bg: '#72243E', border: '#D4537E', text: '#ffffff' },
  rush: { bg: '#712B13', border: '#D85A30', text: '#ffffff' },
  print: { bg: '#444441', border: '#888780', text: '#ffffff' },
  remove: { bg: '#501313', border: '#E24B4A', text: '#F7C1C1' },
};
/** Same colour for the same action on every POS screen. */
export function toneStyle(tone: ActionTone, enabled = true): CSSProperties | undefined {
  if (!enabled) return undefined;
  const t = TONES[tone];
  return { backgroundColor: t.bg, borderColor: t.border, color: t.text };
}

export type ItemAction = 'change' | 'note' | 'discount' | 'free' | 'move' | 'rush' | 'more' | 'remove';

export function ItemActionsPanel({ item, canDiscount, canRemove, onPick, onClose }: {
  item: OrderItem; canDiscount: boolean; canRemove: boolean; onPick: (action: ItemAction) => void; onClose: () => void;
}) {
  const fmt = useFormatCurrency();
  const hasAddons = Array.isArray(item.addons) && item.addons.length > 0;
  const sent = sentAtMs(item);
  const sentText = sent ? new Date(sent).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const buttons: [ItemAction, string, ReactNode, boolean][] = [
    ['change', 'Change', <Replace key="c" size={36} strokeWidth={2.25} />, true],
    ['note', 'Note', <NotebookPen key="n" size={36} strokeWidth={2.25} />, true],
    ['discount', 'Discount', <Percent key="d" size={36} strokeWidth={2.25} />, canDiscount && !item.comped_at],
    ['free', 'Free', <Gift key="f" size={36} strokeWidth={2.25} />, !item.comped_at],
    ['move', 'Move', <ArrowLeftRight key="m" size={36} strokeWidth={2.25} />, true],
    ['rush', 'Rush', <Flame key="r" size={36} strokeWidth={2.25} />, true],
  ];
  return (
    <Shell title={`${item.quantity} × ${item.product_name}`} subtitle={`${fmt(Number(item.total))}${sentText ? ` · sent ${sentText}` : ''}${item.special_instructions ? ` · ${item.special_instructions}` : ''}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {buttons.map(([key, label, icon, enabled]) => (
          <button key={key} type="button" disabled={!enabled} onClick={() => onPick(key)} style={toneStyle(key as ActionTone, enabled)} className={bigBtn}>{icon}{label}</button>
        ))}
      </div>
      {!hasAddons && !item.comped_at && (
        <button type="button" onClick={() => onPick('more')} style={toneStyle('add')} className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 text-base font-bold hover:brightness-125">
          <Plus size={28} strokeWidth={2.25} />Add 1 more
        </button>
      )}
      {canRemove && (
        <>
          <button type="button" onClick={() => onPick('remove')} style={toneStyle('remove')} className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 text-base font-bold hover:brightness-125">
            <Trash2 size={28} strokeWidth={2.25} />Remove
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

export function ChangeItemDialog({ item, onChange, onClose, notSent = false }: {
  item: Pick<OrderItem, 'quantity' | 'product_name' | 'created_at'>; onChange: (product: Product, note: string, pin: string) => Promise<void>; onClose: () => void; notSent?: boolean;
}) {
  const fmt = useFormatCurrency();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Product | null>(null);
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const needsPin = !notSent && !withinChangeWindow(item as OrderItem);

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
          <p className="text-center text-sm text-neutral-400">{notSent ? 'Not sent yet: no kitchen ticket.' : 'The kitchen gets a CHANGE ticket.'}</p>
        </div>
      )}
    </Shell>
  );
}

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
  const placed = (tb: Table) => tb.position_x != null && tb.position_y != null;
  const hasPlan = tables.some(placed);
  const [view, setView] = useState<'plan' | 'list'>(hasPlan ? 'plan' : 'list');
  const floors = [...new Set(tables.filter(placed).map((tb) => tb.floor || ''))];
  const [floor, setFloor] = useState<string>(() => tables.find((tb) => tb.id === currentTableId)?.floor || floors[0] || '');
  const planTables = tables.filter((tb) => placed(tb) && (tb.floor || '') === floor);
  const canTarget = (tb: Table) => targets.some((x) => x.id === tb.id);
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
      <div className="mt-5 mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold uppercase tracking-wide text-neutral-300">2. Tap the new table</p>
        {hasPlan && (
          <div className="flex rounded-xl border border-neutral-600 p-1">
            <button type="button" aria-pressed={view === 'plan'} onClick={() => setView('plan')} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-bold ${view === 'plan' ? 'bg-blue-600 text-white' : 'text-neutral-300'}`}><MapPinned size={16} />Floor plan</button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')} className={`flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-bold ${view === 'list' ? 'bg-blue-600 text-white' : 'text-neutral-300'}`}><List size={16} />List</button>
          </div>
        )}
      </div>
      {selected.length === 0 && <p className="mb-2 text-sm text-amber-300">Tick at least one item first.</p>}
      {view === 'plan' && hasPlan ? (
        <>
          {floors.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {floors.map((f) => (
                <button key={f || '__none__'} type="button" onClick={() => setFloor(f)}
                  className={`h-10 rounded-full border-2 px-4 text-sm font-bold ${f === floor ? 'border-blue-500 bg-blue-600 text-white' : 'border-neutral-600'}`}>{f || 'Floor'}</button>
              ))}
            </div>
          )}
          <FloorPlanCanvas floor={floor} tables={planTables} testIdPrefix="move-table" reservedHeight="18rem"
            isDisabled={(tb) => busy || selected.length === 0 || !canTarget(tb)} selectedId={currentTableId} onPick={(tb) => { void move(tb); }} />
          <p className="text-center text-sm text-neutral-400">Green = free (new bill) · Orange = busy (added to its bill) · Ringed = this table</p>
        </>
      ) : (
        <div className="space-y-3">
          {sections.map((sec) => (
            <div key={sec || '__none__'}>
              {sec && <p className="mb-1 text-sm font-bold text-neutral-400">{sec}</p>}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {targets.filter((tb) => (tb.section?.trim() || '') === sec).map((tb) => (
                  <button key={tb.id} type="button" disabled={busy || selected.length === 0} onClick={() => move(tb)}
                    className={`flex h-16 flex-col items-center justify-center rounded-xl border-[3px] text-lg font-black disabled:opacity-40 ${planTone[tb.status] || planTone.available}`}>
                    {tb.name}
                    {tb.status === 'occupied' && <span className="text-xs font-bold">add to bill</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

export type CartItemAction = 'change' | 'note' | 'options' | 'remove';

export function CartItemPanel({ item, hasOptions, onQuantity, onPick, onClose }: {
  item: CartItem; hasOptions: boolean; onQuantity: (quantity: number) => void; onPick: (action: CartItemAction) => void; onClose: () => void;
}) {
  const fmt = useFormatCurrency();
  const addonTotal = item.addons.reduce((sum, a) => sum + Number(a.price) * (a.quantity || 1), 0);
  const lineTotal = (Number(item.product.price) + addonTotal) * item.quantity;
  const later = (label: string, icon: ReactNode) => (
    <button type="button" disabled className={bigBtn} title="Do this on the bill after Send">{icon}{label}<span className="text-xs font-semibold text-neutral-400">on the bill after Send</span></button>
  );
  return (
    <Shell title={`${item.quantity} × ${item.product.name}`} subtitle={`${fmt(lineTotal)} · not sent yet${item.special_instructions ? ` · ${item.special_instructions}` : ''}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onPick('change')} style={toneStyle('change')} className={bigBtn}><Replace size={36} strokeWidth={2.25} />Change</button>
        <button type="button" onClick={() => onPick('note')} style={toneStyle('note')} className={bigBtn}><NotebookPen size={36} strokeWidth={2.25} />Note</button>
        {later('Discount', <Percent size={36} strokeWidth={2.25} />)}
        {later('Free', <Gift size={36} strokeWidth={2.25} />)}
      </div>
      {hasOptions && (
        <button type="button" onClick={() => onPick('options')} className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-base font-bold hover:bg-neutral-800">
          <SlidersHorizontal size={24} strokeWidth={2.25} />Options / add-ons
        </button>
      )}
      <div className="mt-2 flex items-center justify-between rounded-xl border-2 border-neutral-600 bg-neutral-900 px-3 py-2">
        <span className="text-base font-bold">Quantity</span>
        <span className="flex items-center gap-2">
          <button type="button" aria-label="One less" onClick={() => onQuantity(item.quantity - 1)} className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-neutral-600 text-2xl font-black hover:bg-neutral-800"><Minus size={22} /></button>
          {[1, 2, 3].map((n) => (
            <button key={n} type="button" aria-pressed={item.quantity === n} onClick={() => onQuantity(n)}
              className={`h-12 w-12 rounded-xl border-2 text-xl font-black ${item.quantity === n ? 'border-blue-500 bg-blue-600 text-white' : 'border-neutral-600 hover:bg-neutral-800'}`}>{n}</button>
          ))}
          <span className="w-10 text-center text-2xl font-black tabular-nums">{item.quantity}</span>
          <button type="button" aria-label="One more" onClick={() => onQuantity(item.quantity + 1)} className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-neutral-600 text-2xl font-black hover:bg-neutral-800"><Plus size={22} /></button>
        </span>
      </div>
      <button type="button" onClick={() => onPick('remove')} style={toneStyle('remove')} className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-xl border-2 text-base font-bold hover:brightness-125">
        <Trash2 size={28} strokeWidth={2.25} />Remove
      </button>
      <p className="mt-2 text-center text-sm text-neutral-400">Not sent yet: no PIN needed</p>
    </Shell>
  );
}

export function CartNoteDialog({ name, initial, onSave, onClose }: { name: string; initial: string; onSave: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState(initial);
  return (
    <Shell title="Note" subtitle={name} onClose={onClose}>
      <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} rows={3} placeholder="no ice, no chili…"
        className="w-full rounded-xl border-2 border-neutral-600 bg-neutral-900 p-3 text-lg text-white" />
      <button type="button" onClick={() => onSave(note.trim())}
        className="mt-3 h-14 w-full rounded-xl bg-green-500 text-lg font-black text-black hover:bg-green-400">Save note</button>
    </Shell>
  );
}
