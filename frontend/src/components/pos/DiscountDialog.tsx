'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Delete, Gift, X } from 'lucide-react';
import FreeBillPanel from '@/components/pos/FreeBillPanel';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';

export interface DiscountInput {
  type: DiscountType;
  value: number;
  reason?: string;
  pin?: string;
}

interface Props {
  title: string;
  subtitle?: string;
  baseAmount: number;
  canClear?: boolean;
  onClose: () => void;
  onApply: (input: DiscountInput) => Promise<void>;
  /** BackStreet: offer Free (whole bill, reason + manager PIN) next to Percent / Amount. */
  free?: { orderId: number; total: number; paidAmount: number; onClosed: () => void };
}

const PERCENT_CHIPS = [5, 10, 15, 20];
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'];

export default function DiscountDialog({ title, subtitle, baseAmount, canClear, onClose, onApply, free }: Props) {
  const [freeOpen, setFreeOpen] = useState(false);
  const fmt = useFormatCurrency();
  const { toStored } = useCurrencyUnitAdapter();
  const [mode, setMode] = useState<DiscountMode>('percentage');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [type, setType] = useState<DiscountType>('percentage');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/settings/discount')
      .then((res) => {
        const nextMode = normalizeDiscountMode(res.data.discount_mode);
        setMode(nextMode);
        setRequiresApproval(!!res.data.discount_requires_approval);
        setType((current) => (isDiscountTypeAllowed(nextMode, current) ? current : defaultDiscountTypeForMode(nextMode)));
      })
      .catch(() => {});
  }, []);

  const numeric = parseFloat(value);
  const entered = Number.isFinite(numeric) ? numeric : 0;
  const stored = type === 'amount' ? toStored(entered) : entered;
  const previewOff = type === 'percentage' ? (baseAmount * entered) / 100 : Math.min(stored, baseAmount);

  const press = (key: string) => {
    if (key === '.' && (type === 'percentage' || value.includes('.'))) return;
    setValue((current) => (current.length >= 7 ? current : current + key));
  };

  const apply = async (clear = false) => {
    if (!clear && entered <= 0) {
      toast.error('Enter a discount');
      return;
    }
    if (!clear && !reason.trim()) {
      toast.error('Add the reason for this discount');
      return;
    }
    if (!clear && requiresApproval && !pin) {
      toast.error('Manager PIN required');
      return;
    }
    setBusy(true);
    try {
      await onApply({ type, value: clear ? 0 : stored, reason: reason.trim() || undefined, pin: requiresApproval && !clear ? pin : undefined });
      onClose();
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || 'Could not apply discount');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const freeChoice = free && (
    <button type="button" aria-pressed={freeOpen} onClick={() => setFreeOpen((v) => !v)}
      className={`mb-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 text-base font-bold ${freeOpen ? 'border-amber-500 bg-amber-500 text-black' : 'border-amber-500 text-amber-600'}`}>
      <Gift size={18} /> Free (whole bill)
    </button>
  );
  const freePanel = free && freeOpen && (
    <FreeBillPanel startOpen offerFree bill={{ order_id: free.orderId, total: free.total, paid_amount: free.paidAmount }}
      onCancel={() => setFreeOpen(false)} onClosed={() => { onClose(); free.onClosed(); }} />
  );

  if (mode === 'none') {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-card p-6 text-center">
          <p className="mb-4 text-base text-foreground">Discounts are turned off in Settings.</p>
          {freeChoice}
          {freePanel && <div className="mb-3 text-start">{freePanel}</div>}
          <button type="button" onClick={onClose} className="h-12 w-full rounded-xl border border-border text-base font-medium">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[94vh] w-full max-w-md overflow-y-auto rounded-2xl bg-card p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-xl font-bold text-foreground">{title}</h3>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"><X size={20} /></button>
        </div>

        {freeChoice}
        {freePanel ? freePanel : (<>
        {mode === 'both' && (
          <div className="mb-3 flex rounded-xl border border-border p-1">
            {(['percentage', 'amount'] as const).map((option) => (
              <button key={option} type="button" aria-pressed={type === option} onClick={() => { setType(option); setValue(''); }}
                className={`h-11 flex-1 rounded-lg text-base font-semibold ${type === option ? 'bg-brand text-white' : 'text-muted-foreground'}`}>{option === 'percentage' ? 'Percent %' : 'Amount'}</button>
            ))}
          </div>
        )}

        {type === 'percentage' && (
          <div className="mb-3 grid grid-cols-4 gap-2">
            {PERCENT_CHIPS.map((chip) => (
              <button key={chip} type="button" onClick={() => setValue(String(chip))}
                className={`h-11 rounded-lg border text-base font-semibold ${value === String(chip) ? 'border-brand bg-brand/10 text-brand' : 'border-border'}`}>{chip}%</button>
            ))}
          </div>
        )}

        <div className="mb-3 rounded-xl bg-muted px-4 py-3 text-center">
          <div className="text-4xl font-bold tabular-nums text-foreground">{value || '0'}{type === 'percentage' ? '%' : ''}</div>
          <div className="text-sm text-muted-foreground">{entered > 0 ? `Takes off ${fmt(previewOff)} of ${fmt(baseAmount)}` : `On ${fmt(baseAmount)}`}</div>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-2">
          {KEYS.map((key) => (
            <button key={key} type="button" onClick={() => press(key)} disabled={key === '.' && type === 'percentage'}
              className="h-14 rounded-xl border border-border bg-card text-2xl font-semibold active:bg-muted disabled:opacity-30">{key}</button>
          ))}
          <button type="button" aria-label="Backspace" onClick={() => setValue((current) => current.slice(0, -1))}
            className="flex h-14 items-center justify-center rounded-xl border border-border bg-card active:bg-muted"><Delete size={22} /></button>
        </div>

        <label className="mb-3 block space-y-1">
          <span className="block text-lg font-bold text-foreground">Reason (required)</span>
          {/* A textarea, not a text box: Chrome fills a saved login email into a text box next to a PIN. */}
          <textarea name="discount-reason" autoComplete="off" rows={1} value={reason} onChange={(event) => setReason(event.target.value.replace(/\n/g, ' '))} placeholder="Who it's for and why" maxLength={120}
            data-1p-ignore data-lpignore="true"
            className="h-14 w-full resize-none rounded-lg border-2 border-border bg-background px-3 py-3 text-xl" />
        </label>

        {requiresApproval && (
          <label className="mb-3 block space-y-1">
            <span className="block text-sm font-semibold text-foreground">Manager PIN (approves this)</span>
            {/* Plain text box drawn as dots (not a password field), so the browser does not fill a saved login here. */}
            <input name="discount-manager-pin" value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} placeholder="Type the manager's PIN"
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="Manager PIN" style={{ WebkitTextSecurity: 'disc' } as unknown as CSSProperties}
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-base" />
          </label>
        )}

        <div className="flex gap-2">
          {canClear && (
            <button type="button" disabled={busy} onClick={() => apply(true)} className="h-14 rounded-xl border border-border px-4 text-base font-medium disabled:opacity-50">Remove</button>
          )}
          <button type="button" disabled={busy} onClick={() => apply(false)} className="h-14 flex-1 rounded-xl bg-brand text-lg font-semibold text-white disabled:opacity-50">{busy ? '…' : 'Apply discount'}</button>
        </div>
        </>)}
      </div>
    </div>
  );
}
