'use client';

import { useMemo, useState } from 'react';
import { Users, X } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Bill, Order, OrderItem } from '@/lib/types';

const MIN_GUESTS = 2;
const MAX_GUESTS = 20;

type Assignment = { units: number[]; sharedBy: number[] };

const emptyAssignment = (count: number): Assignment => ({ units: Array(count).fill(0), sharedBy: [] });

/** Splits an amount into equal cent shares; the leftover cent goes to the first guest. */
function shareAmounts(amount: number, parts: number): number[] {
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / parts);
  return Array.from({ length: parts }, (_, i) => (base + (i < cents - base * parts ? 1 : 0)) / 100);
}

export function SplitCheckModal({ bill, order, onClose, onSplit }: { bill: Bill; order: Order; onClose: () => void; onSplit: (bills: Bill[]) => void }) {
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const items = useMemo(() => (order.items || []).filter((item) => !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status)), [order.items]);
  const initialCount = Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, order.guest_count || MIN_GUESTS));
  const [labels, setLabels] = useState(() => Array.from({ length: initialCount }, (_, i) => `Guest ${i + 1}`));
  const [assign, setAssign] = useState<Record<number, Assignment>>(() => Object.fromEntries(items.map((item) => [item.id, emptyAssignment(initialCount)])));
  const [selected, setSelected] = useState(0);
  const [editingLabel, setEditingLabel] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [sharing, setSharing] = useState<{ itemId: number; guests: number[] } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const count = labels.length;

  const unassignedOf = (item: OrderItem) => {
    const a = assign[item.id];
    if (!a || a.sharedBy.length > 0) return 0;
    return item.quantity - a.units.reduce((sum, n) => sum + n, 0);
  };
  const unitPrice = (item: OrderItem) => Number(item.total) / item.quantity;

  const guestLines = (guest: number) => items.flatMap((item) => {
    const a = assign[item.id];
    if (!a) return [];
    const shareIndex = a.sharedBy.indexOf(guest);
    if (shareIndex >= 0) {
      return [{ item, label: item.product_name, share: `1/${a.sharedBy.length}`, amount: shareAmounts(Number(item.total), a.sharedBy.length)[shareIndex] }];
    }
    const units = a.units[guest] || 0;
    return units > 0 ? [{ item, label: `${units > 1 ? `${units}× ` : ''}${item.product_name}`, share: null as string | null, amount: unitPrice(item) * units }] : [];
  });
  const guestTotal = (guest: number) => guestLines(guest).reduce((sum, line) => sum + line.amount, 0);

  const unassignedItems = items.filter((item) => unassignedOf(item) > 0);
  const unassignedCount = unassignedItems.reduce((sum, item) => sum + unassignedOf(item), 0);
  const emptyGuests = Array.from({ length: count }, (_, g) => g).filter((g) => guestLines(g).length === 0);
  const ready = unassignedCount === 0 && emptyGuests.length === 0;

  const resize = (next: number) => {
    next = Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, next));
    if (next === count) return;
    if (next < count) {
      setConfirmRemove(null);
      setLabels((old) => old.slice(0, next));
      setAssign((old) => Object.fromEntries(Object.entries(old).map(([id, a]) => {
        const sharedBy = a.sharedBy.filter((g) => g < next);
        return [id, { units: a.units.slice(0, next), sharedBy: sharedBy.length >= MIN_GUESTS ? sharedBy : [] }];
      })));
      setSelected((s) => Math.min(s, next - 1));
      return;
    }
    setLabels((old) => [...old, ...Array.from({ length: next - old.length }, (_, i) => `Guest ${old.length + i + 1}`)]);
    setAssign((old) => Object.fromEntries(Object.entries(old).map(([id, a]) => [id, { ...a, units: [...a.units, ...Array(next - a.units.length).fill(0)] }])));
  };

  const removeGuest = (guest: number, force = false) => {
    if (count <= MIN_GUESTS) return;
    if (!force && guestLines(guest).length > 0 && confirmRemove !== guest) { setConfirmRemove(guest); return; }
    setConfirmRemove(null);
    setLabels((old) => old.filter((_, i) => i !== guest));
    setAssign((old) => Object.fromEntries(Object.entries(old).map(([id, a]) => {
      const sharedBy = a.sharedBy.filter((g) => g !== guest).map((g) => (g > guest ? g - 1 : g));
      return [id, { units: a.units.filter((_, i) => i !== guest), sharedBy: sharedBy.length >= MIN_GUESTS ? sharedBy : [] }];
    })));
    setSelected((s) => (s === guest ? 0 : s > guest ? s - 1 : s));
  };

  const giveUnit = (item: OrderItem, guest = selected) => {
    if (unassignedOf(item) <= 0) return;
    setAssign((old) => ({ ...old, [item.id]: { ...old[item.id], units: old[item.id].units.map((n, g) => (g === guest ? n + 1 : n)) } }));
  };

  const takeBack = (item: OrderItem, guest: number) => {
    setAssign((old) => {
      const a = old[item.id];
      if (a.sharedBy.includes(guest)) return { ...old, [item.id]: emptyAssignment(count) };
      return { ...old, [item.id]: { ...a, units: a.units.map((n, g) => (g === guest ? Math.max(0, n - 1) : n)) } };
    });
  };

  const eachPaysOwn = () => setAssign(Object.fromEntries(items.map((item) => [item.id, emptyAssignment(count)])));
  const splitEvenly = () => setAssign(Object.fromEntries(items.map((item) => {
    const units = Array(count).fill(0);
    for (let unit = 0; unit < item.quantity; unit++) units[unit % count]++;
    return [item.id, { units, sharedBy: [] }];
  })));
  const restToSelected = () => setAssign((old) => Object.fromEntries(items.map((item) => {
    const a = old[item.id];
    const left = unassignedOf(item);
    return [item.id, left > 0 ? { ...a, units: a.units.map((n, g) => (g === selected ? n + left : n)) } : a];
  })));

  const applyShare = () => {
    if (!sharing || sharing.guests.length < MIN_GUESTS) return;
    const guests = [...sharing.guests].sort((a, b) => a - b);
    setAssign((old) => ({ ...old, [sharing.itemId]: { units: Array(count).fill(0), sharedBy: guests } }));
    setSharing(null);
  };

  const submit = async () => {
    if (!ready) return toast.error(t('allocateAllItems'));
    setSaving(true);
    try {
      const checks = labels.map((label, guest) => ({
        label: label.trim() || `Guest ${guest + 1}`,
        items: items.flatMap((item): Array<{ order_item_id: number; quantity?: number; share?: { of: number } }> => {
          const a = assign[item.id];
          if (a.sharedBy.includes(guest)) return [{ order_item_id: item.id, share: { of: a.sharedBy.length } }];
          const quantity = a.units[guest] || 0;
          return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
        }),
      }));
      const { data } = await api.post(`/bills/${bill.id}/split-check`, { checks });
      onSplit(data.bills);
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || t('splitCheckFailed'));
    } finally { setSaving(false); }
  };

  const sharingItem = sharing ? items.find((item) => item.id === sharing.itemId) : null;

  return <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-3">
    <div className="bg-card text-foreground rounded-2xl w-full max-w-5xl max-h-[94vh] flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{t('splitCheck')}{order.table?.name ? ` · ${order.table.name}` : ''}</h2>
          <p className="text-sm text-muted-foreground">Bill total {fmt(Number(bill.total))}</p>
        </div>
        <button onClick={onClose} aria-label={tCommon('cancel')} className="h-12 w-12 rounded-xl border flex items-center justify-center"><X size={22} /></button>
      </div>

      <div className="px-5 py-3 border-b flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-muted-foreground me-1 flex items-center gap-1"><Users size={16} />People</span>
        {[2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" onClick={() => resize(n)}
            className={`h-12 w-12 rounded-xl text-lg font-bold ${count === n ? 'border-2 border-primary bg-primary/10' : 'border'}`}>{n}</button>
        ))}
        <button type="button" onClick={() => resize(count + 1)} disabled={count >= MAX_GUESTS} aria-label="Add a person"
          className="h-12 min-w-12 px-3 rounded-xl border text-lg font-bold disabled:opacity-40">{count > 6 ? `${count} +` : '+'}</button>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button variant="outline" className="h-12" onClick={eachPaysOwn}>Each pays own</Button>
          <Button variant="outline" className="h-12" onClick={splitEvenly}>Split evenly</Button>
          <Button variant="outline" className="h-12" onClick={restToSelected} disabled={unassignedCount === 0}>Rest to {labels[selected]}</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5 space-y-5">
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
          {labels.map((label, guest) => {
            const lines = guestLines(guest);
            const isSelected = guest === selected;
            return (
              <div key={guest} role="button" tabIndex={0} aria-label={`Select ${label}`} aria-pressed={isSelected} onClick={() => setSelected(guest)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(guest); }}
                className={`rounded-xl p-3 cursor-pointer min-h-36 flex flex-col ${isSelected ? 'border-2 border-primary bg-primary/5' : 'border-2 border-border'}`}>
                <div className="flex items-start justify-between gap-2">
                  {editingLabel === guest ? (
                    <input autoFocus value={label} maxLength={40} onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setLabels((old) => old.map((l, i) => (i === guest ? e.target.value : l)))}
                      onBlur={() => setEditingLabel(null)} onKeyDown={(e) => { if (e.key === 'Enter') setEditingLabel(null); }}
                      className="w-full rounded-lg border px-2 py-1 text-base font-bold" aria-label="Guest name" />
                  ) : (
                    <button type="button" onClick={(e) => { e.stopPropagation(); setSelected(guest); setEditingLabel(guest); }}
                      className="text-base font-bold text-start underline decoration-dotted underline-offset-4" aria-label={`Rename ${label}`}>{label}</button>
                  )}
                  {count > MIN_GUESTS && (
                    <button type="button" onClick={(e) => { e.stopPropagation(); removeGuest(guest); }}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted" aria-label={`Remove ${label}`}>× Remove</button>
                  )}
                </div>
                {confirmRemove === guest && (
                  <div className="mt-2 rounded-lg bg-orange-50 p-2 text-xs text-orange-900 dark:bg-orange-950/50 dark:text-orange-100" onClick={(e) => e.stopPropagation()}>
                    Remove {label}? Their items go back to Still to assign.
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button type="button" className="rounded-lg bg-orange-600 py-2 font-bold text-white" onClick={() => removeGuest(guest, true)}>Remove</button>
                      <button type="button" className="rounded-lg border py-2 font-bold" onClick={() => setConfirmRemove(null)}>Keep</button>
                    </div>
                  </div>
                )}
                <div className="mt-2 flex-1 space-y-1">
                  {lines.length === 0 && <p className="text-sm text-muted-foreground">{isSelected ? 'Tap items below to add' : 'No items yet'}</p>}
                  {lines.map((line) => (
                    <button key={line.item.id} type="button" onClick={(e) => { e.stopPropagation(); takeBack(line.item, guest); }}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-sm hover:bg-muted text-start" aria-label={`Give back ${line.label}`}>
                      <span className="min-w-0 flex-1 truncate">{line.label}</span>
                      {line.share && <span className="shrink-0 rounded bg-muted px-1.5 text-xs font-semibold">{line.share}</span>}
                      <span className="tabular-nums shrink-0">{fmt(line.amount)}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-2 border-t pt-2 text-lg font-bold tabular-nums">{fmt(guestTotal(guest))}</p>
              </div>
            );
          })}
        </div>

        {!advanced ? (
          <div>
            <p className="mb-2 text-sm font-semibold text-muted-foreground">Still to assign · tap to give to {labels[selected]}</p>
            {unassignedItems.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">Every item is assigned.</p>
            ) : (
              <div className="space-y-2">
                {unassignedItems.map((item) => {
                  const left = unassignedOf(item);
                  const untouched = left === item.quantity;
                  return (
                    <div key={item.id} className="flex items-stretch gap-2">
                      <button type="button" onClick={() => giveUnit(item)}
                        className="flex flex-1 items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 text-base hover:bg-muted text-start">
                        <span className="font-semibold">{left}× {item.product_name}</span>
                        <span className="tabular-nums text-muted-foreground">{fmt(unitPrice(item))} each</span>
                      </button>
                      {untouched && (
                        <button type="button" onClick={() => setSharing({ itemId: item.id, guests: labels.map((_, g) => g) })}
                          className="rounded-xl border-2 px-4 text-sm font-semibold hover:bg-muted">Share…</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="text-start p-2 sticky start-0 bg-card">{t('items')}</th>{labels.map((label, i) => <th key={i} className="p-2 min-w-24">{label}</th>)}</tr></thead>
              <tbody>{items.map((item) => {
                const a = assign[item.id];
                return <tr key={item.id} className="border-t">
                  <td className="p-2 sticky start-0 bg-card"><div className="font-medium">{item.product_name}</div><div className="text-xs text-muted-foreground">{item.quantity} × {fmt(unitPrice(item))}</div></td>
                  {a.sharedBy.length > 0
                    ? <td colSpan={count} className="p-2 text-center text-muted-foreground">Shared by {a.sharedBy.map((g) => labels[g]).join(', ')}</td>
                    : labels.map((_, guest) => <td key={guest} className="p-2"><input type="number" min="0" max={item.quantity} value={a.units[guest] || 0}
                      onChange={(e) => { const value = Math.min(item.quantity, Math.max(0, Math.floor(Number(e.target.value) || 0))); setAssign((old) => ({ ...old, [item.id]: { ...old[item.id], units: old[item.id].units.map((n, g) => (g === guest ? value : n)) } })); }}
                      className="w-full text-center border rounded px-2 py-2" aria-label={`${item.product_name} for ${labels[guest]}`} /></td>)}
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-sm font-semibold text-muted-foreground underline">
          {advanced ? 'Back to tap to assign' : 'Advanced (number grid)'}
        </button>
      </div>

      <div className="px-5 py-4 border-t flex flex-wrap items-center justify-end gap-3">
        <p className="me-auto text-sm text-muted-foreground">
          {unassignedCount > 0
            ? <span className="text-orange-600 font-semibold">{unassignedCount} {unassignedCount === 1 ? 'item' : 'items'} still to assign</span>
            : emptyGuests.length > 0
              ? <span className="text-orange-600 font-semibold">{emptyGuests.map((g) => labels[g]).join(', ')} {emptyGuests.length === 1 ? 'has' : 'have'} no items</span>
              : 'Tax, discount and service charge are divided on the bills.'}
        </p>
        <Button variant="outline" className="h-12" onClick={onClose}>{tCommon('cancel')}</Button>
        <Button className="h-12 px-6 text-base font-bold" onClick={submit} disabled={saving || !ready}>{saving ? tCommon('saving') : `Create ${count} bills`}</Button>
      </div>
    </div>

    {sharing && sharingItem && (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={() => setSharing(null)}>
        <div className="w-full max-w-md rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold">Share {sharingItem.quantity > 1 ? `${sharingItem.quantity}× ` : ''}{sharingItem.product_name}</h3>
          <p className="text-sm text-muted-foreground">{fmt(Number(sharingItem.total))} divided evenly between the guests you choose.</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {labels.map((label, guest) => {
              const on = sharing.guests.includes(guest);
              return <button key={guest} type="button" onClick={() => setSharing({ ...sharing, guests: on ? sharing.guests.filter((g) => g !== guest) : [...sharing.guests, guest] })}
                className={`h-12 rounded-xl px-3 text-start font-semibold ${on ? 'border-2 border-primary bg-primary/10' : 'border-2'}`}>{on ? '✓ ' : ''}{label}</button>;
            })}
          </div>
          {sharing.guests.length >= MIN_GUESTS && (
            <p className="mt-3 text-sm">Each pays about {fmt(Number(sharingItem.total) / sharing.guests.length)}</p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-12" onClick={() => setSharing(null)}>{tCommon('cancel')}</Button>
            <Button className="h-12" disabled={sharing.guests.length < MIN_GUESTS} onClick={applyShare}>Share between {sharing.guests.length}</Button>
          </div>
        </div>
      </div>
    )}
  </div>;
}
