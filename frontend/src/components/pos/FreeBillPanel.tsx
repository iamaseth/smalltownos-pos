'use client';

import { useState, type CSSProperties } from 'react';
import toast from 'react-hot-toast';
import { Gift, X } from 'lucide-react';
import api from '@/lib/api';
import type { Bill, Order } from '@/lib/types';

/**
 * Whole-bill Free: five short words for staff (keys are the server's COMP_REASONS).
 * Free on one item in Orders still offers the full list.
 */
const COMP_REASONS: [string, string][] = [
  ['entertainer', 'Artist'], ['event', 'Event'], ['owner_comp', 'Owner'], ['complaint', 'Complaint'], ['other', 'Other'],
];
const REMOVED = ['cancelled', 'voided', 'void_adjustment', 'refunded'];

function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

type FreeTarget = Pick<Bill, 'order_id' | 'total' | 'paid_amount'>;

/** True when the bill has nothing left to pay because everything is free or removed. */
export function isZeroBill(bill: FreeTarget): boolean {
  return Number(bill.total) <= 0 && !(Number(bill.paid_amount) > 0);
}

/**
 * Free (comp): make the whole bill free with a reason and a manager PIN. Every item is marked
 * Free (recorded like Free in Orders), then the bill closes with no payment recorded.
 */
export default function FreeBillPanel({ bill, offerFree, onClosed, startOpen = false, onCancel }: {
  /** A bill, or (from the table popup) the order's id and total before a bill exists. */
  bill: FreeTarget;
  offerFree: boolean;
  onClosed: () => void;
  /** BackStreet: shown already open (inside Discount bill → Free); also closes a bill that is already $0. */
  startOpen?: boolean;
  onCancel?: () => void;
}) {
  const zero = isZeroBill(bill);
  const [open, setOpen] = useState(startOpen);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const closeFree = async (closeReason: string) => {
    const { data } = await api.post(`/cash-handover/open-tickets/${bill.order_id}/close-free`, { pin, reason: closeReason });
    toast.success(`Bill closed · approved by ${data.approved_by}`);
    onClosed();
  };

  const makeFree = async () => {
    if (!reason) { toast.error('Choose a reason'); return; }
    setBusy(true);
    try {
      const { data } = await api.get(`/orders/${bill.order_id}`);
      const order: Order = data.order ?? data;
      const items = (order.items || []).filter((i) => !REMOVED.includes(String(i.status)) && !i.comped_at && Number(i.unit_price) > 0);
      for (const item of items) {
        await api.patch(`/orders/${bill.order_id}/items/${item.id}/comp`, { reason, note: note.trim() || undefined, override_pin: pin });
      }
      // The table popup has no bill yet: make it now so the $0 bill can be closed and settled.
      await api.post('/bills/generate', { order_id: bill.order_id });
      const label = COMP_REASONS.find(([key]) => key === reason)?.[1] ?? reason;
      await closeFree(note.trim() ? `${label}: ${note.trim()}` : label);
    } catch (error) {
      setPin('');
      toast.error(errorText(error, 'Could not make the bill free'));
    } finally { setBusy(false); }
  };

  const pinInput = (
    <label className="block space-y-1">
      <span className="block text-sm font-bold text-amber-100">Manager PIN</span>
      {/* Plain text box drawn as dots (not a password field), so the browser does not fill a saved login here. */}
      <input type="text" inputMode="numeric" name="free-manager-pin" autoComplete="one-time-code" value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={6}
        placeholder="PIN" aria-label="Manager PIN" style={{ WebkitTextSecurity: 'disc' } as unknown as CSSProperties}
        className="min-h-11 w-full rounded-lg border border-neutral-600 bg-neutral-950 px-3 py-2 text-base text-white outline-none focus:ring-2 focus:ring-red-400" />
    </label>
  );

  if (zero && !startOpen) return null;

  if (!offerFree) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border-2 border-neutral-600 px-4 text-base font-bold text-white hover:bg-neutral-800">
        <Gift size={16} /> Free
      </button>
    );
  }
  return (
    <div data-testid="free-bill-panel" className="space-y-2 rounded-2xl border-2 border-amber-500 bg-amber-950/40 p-3 text-white">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-base font-black"><Gift size={18} /> Free bill</p>
        <button type="button" aria-label="Close" onClick={() => { setOpen(false); setPin(''); onCancel?.(); }} className="rounded-lg p-1.5 hover:bg-neutral-800"><X size={16} /></button>
      </div>
      <p className="text-sm text-amber-100">{zero ? 'Pay $0. Pick why. Manager PIN.' : 'Pick why. Manager PIN.'}</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {COMP_REASONS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={reason === key} onClick={() => setReason(key)}
            className={`min-h-14 rounded-lg border px-2 text-lg font-bold ${reason === key ? 'border-amber-400 bg-amber-500 text-black' : 'border-neutral-600 hover:bg-neutral-800'}`}>
            {label}
          </button>
        ))}
      </div>
      <label className="block space-y-1">
        <span className="block text-sm font-bold text-amber-100">{reason === 'other' ? 'Why? (must write)' : 'Note'}</span>
        <input type="text" name="free-note" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200}
          placeholder={reason === 'other' ? 'Why?' : 'Name'}
          className="min-h-11 w-full rounded-lg border border-neutral-600 bg-neutral-950 px-3 py-2 text-sm text-white outline-none" />
      </label>
      {pinInput}
      <button type="button" disabled={busy || !reason || !pin || (reason === 'other' && !note.trim())} onClick={() => void makeFree()}
        className="min-h-14 w-full rounded-2xl bg-amber-500 text-xl font-black text-black hover:bg-amber-400 disabled:opacity-50">
        {busy ? '…' : !reason ? 'Pick why' : reason === 'other' && !note.trim() ? 'Write why' : !pin ? 'Type PIN' : zero ? 'Close bill' : 'Free + close'}
      </button>
    </div>
  );
}
