'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import type { Category } from '@/lib/types';

type Kind = 'percent_bill' | 'percent_category' | 'amount_bill';
interface Coupon {
  id: string; code: string; name: string; kind: Kind; value: number; category_id: string | null; min_spend: number;
  start_date: string | null; end_date: string | null; days: number[]; start_time: string | null; end_time: string | null; enabled: boolean;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const KIND_LABEL: Record<Kind, string> = {
  percent_bill: '% off the whole bill',
  percent_category: '% off one category',
  amount_bill: '$ off the bill',
};

function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

function blankCoupon(): Coupon {
  return {
    id: `cp-${Date.now().toString(36)}`, code: '', name: '', kind: 'percent_bill', value: 10, category_id: null, min_spend: 0,
    start_date: null, end_date: null, days: [], start_time: null, end_time: null, enabled: true,
  };
}

function offText(c: Coupon, categoryName: (id: string | null) => string): string {
  if (c.kind === 'amount_bill') return `$${c.value} off`;
  if (c.kind === 'percent_category') return `${c.value}% off ${categoryName(c.category_id)}`;
  return `${c.value}% off`;
}

function whenText(c: Coupon): string {
  const parts: string[] = [];
  if (c.start_date || c.end_date) parts.push(`${c.start_date ?? '…'} to ${c.end_date ?? '…'}`);
  if (c.days.length > 0 && c.days.length < 7) parts.push(WEEK_ORDER.filter((d) => c.days.includes(d)).map((d) => DAY_LABELS[d]).join(', '));
  if (c.start_time && c.end_time) parts.push(`${c.start_time}–${c.end_time}`);
  if (c.min_spend > 0) parts.push(`bill over $${c.min_spend}`);
  return parts.length ? parts.join(' · ') : 'Any time';
}

/** Coupons the manager sets up; they show as buttons at checkout when they apply. */
export function CouponsCard() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => Promise.all([api.get('/coupons'), api.get('/categories')])
    .then(([cp, cat]) => { setCoupons(cp.data.coupons || []); setCategories(cat.data.categories || []); })
    .catch((error) => toast.error(errorText(error, 'Could not load coupons'))), []);

  useEffect(() => { void load(); }, [load]);

  const flatCategories = useMemo(() => {
    const seen = new Map<string, Category>();
    const add = (c: Category & { children?: Category[] }) => { if (!seen.has(c.id)) { seen.set(c.id, c); (c.children || []).forEach(add); } };
    categories.forEach(add);
    const all = [...seen.values()];
    const byId = new Map(all.map((c) => [c.id, c]));
    return all
      .map((c) => ({ id: c.id, label: c.parent_id && byId.get(c.parent_id) ? `${byId.get(c.parent_id)!.name} › ${c.name}` : c.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [categories]);
  const categoryName = (id: string | null) => flatCategories.find((c) => c.id === id)?.label ?? 'a category';

  const saveAll = async (next: Coupon[], message: string) => {
    setBusy(true);
    try {
      const { data } = await api.put('/coupons', { coupons: next });
      setCoupons(data.coupons || []);
      toast.success(message);
      return true;
    } catch (error) {
      toast.error(errorText(error, 'Could not save coupons'));
      return false;
    } finally { setBusy(false); }
  };

  const saveEditing = async () => {
    if (!editing) return;
    const exists = coupons.some((c) => c.id === editing.id);
    const next = exists ? coupons.map((c) => (c.id === editing.id ? editing : c)) : [...coupons, editing];
    if (await saveAll(next, `${editing.code.toUpperCase()} saved`)) setEditing(null);
  };

  const toggle = (c: Coupon) => void saveAll(coupons.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)), c.enabled ? `${c.code} switched off` : `${c.code} switched on`);
  const remove = (c: Coupon) => void saveAll(coupons.filter((x) => x.id !== c.id), `${c.code} deleted`);
  const set = (patch: Partial<Coupon>) => setEditing((e) => (e ? { ...e, ...patch } : e));
  const input = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-6 text-foreground">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Coupons</h3>
          <p className="text-sm text-muted-foreground">
            Coupons you set up here show as buttons at checkout, only when they apply to that bill. One discount per bill.
            The cashier keeps the customer&apos;s paper coupon in the drawer; the shift report lists every coupon used.
          </p>
        </div>
        {!editing && (
          <button type="button" onClick={() => setEditing(blankCoupon())} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white">
            <Plus size={16} /> New coupon
          </button>
        )}
      </div>

      {editing && (
        <div data-testid="coupon-form" className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">Code
              <input value={editing.code} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} maxLength={20}
                placeholder="BRKSPECIAL15" className={`${input} mt-1 font-mono uppercase`} />
            </label>
            <label className="text-sm font-medium">Description (shows at checkout)
              <input value={editing.name} onChange={(e) => set({ name: e.target.value })} maxLength={60}
                placeholder="Special Riverside promotion" className={`${input} mt-1`} />
            </label>
            <label className="text-sm font-medium">Type
              <select value={editing.kind} onChange={(e) => set({ kind: e.target.value as Kind, category_id: e.target.value === 'percent_category' ? editing.category_id : null })} className={`${input} mt-1`}>
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">{editing.kind === 'amount_bill' ? 'Amount off ($)' : 'Percent off (%)'}
              <input type="number" min={0} step={editing.kind === 'amount_bill' ? 0.5 : 1} value={editing.value} onChange={(e) => set({ value: Number(e.target.value) })} className={`${input} mt-1`} />
            </label>
            {editing.kind === 'percent_category' && (
              <label className="text-sm font-medium sm:col-span-2">Category
                <select value={editing.category_id ?? ''} onChange={(e) => set({ category_id: e.target.value || null })} className={`${input} mt-1`}>
                  <option value="">Choose a category…</option>
                  {flatCategories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            )}
            <label className="text-sm font-medium">Minimum bill ($, 0 = none)
              <input type="number" min={0} step={1} value={editing.min_spend} onChange={(e) => set({ min_spend: Number(e.target.value) })} className={`${input} mt-1`} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm font-medium">From date
                <input type="date" value={editing.start_date ?? ''} onChange={(e) => set({ start_date: e.target.value || null })} className={`${input} mt-1`} />
              </label>
              <label className="text-sm font-medium">To date
                <input type="date" value={editing.end_date ?? ''} onChange={(e) => set({ end_date: e.target.value || null })} className={`${input} mt-1`} />
              </label>
            </div>
            <div className="text-sm font-medium sm:col-span-2">Days (none ticked = every day)
              <div className="mt-1 flex flex-wrap gap-1.5">
                {WEEK_ORDER.map((d) => {
                  const on = editing.days.includes(d);
                  return (
                    <button key={d} type="button" aria-pressed={on} onClick={() => set({ days: on ? editing.days.filter((x) => x !== d) : [...editing.days, d] })}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${on ? 'border-brand bg-brand/15 font-semibold text-brand' : 'border-border'}`}>
                      {DAY_LABELS[d]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm font-medium">From time (optional)
                <input type="time" value={editing.start_time ?? ''} onChange={(e) => set({ start_time: e.target.value || null })} className={`${input} mt-1`} />
              </label>
              <label className="text-sm font-medium">To time
                <input type="time" value={editing.end_time ?? ''} onChange={(e) => set({ end_time: e.target.value || null })} className={`${input} mt-1`} />
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !editing.code || !editing.name} onClick={() => void saveEditing()} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save coupon</button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {coupons.length === 0 && !editing && <p className="py-4 text-center text-sm text-muted-foreground">No coupons yet. Press New coupon to add one.</p>}
      <div className="space-y-2">
        {coupons.map((c) => (
          <div key={c.id} data-testid="coupon-row" className={`flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2.5 ${c.enabled ? '' : 'opacity-60'}`}>
            <span className="rounded-md bg-amber-100 px-2 py-1 font-mono text-sm font-bold text-amber-900">{c.code}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{offText(c, categoryName)} · {c.name}</p>
              <p className="truncate text-xs text-muted-foreground">{whenText(c)}</p>
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={c.enabled} disabled={busy} onChange={() => toggle(c)} /> {c.enabled ? 'On' : 'Off'}
            </label>
            <button type="button" aria-label={`Edit ${c.code}`} onClick={() => setEditing({ ...c })} className="rounded p-1.5 hover:bg-muted"><Pencil size={16} /></button>
            <button type="button" aria-label={`Delete ${c.code}`} disabled={busy} onClick={() => remove(c)} className="rounded p-1.5 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
