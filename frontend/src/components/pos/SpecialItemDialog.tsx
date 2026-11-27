'use client';

/**
 * BackStreet: the Special item popup on the till. The cashier types what it is and the price,
 * picks Kitchen or Bar (where the ticket prints), and adds it to the bill.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import type { SpecialItemsConfig } from '@/lib/special-items';

const MAX_NAME = 60;

export function SpecialItemDialog({ config, onAdd, onClose }: {
  config: SpecialItemsConfig;
  onAdd: (station: 'kitchen' | 'bar', name: string, price: number) => void;
  onClose: () => void;
}) {
  const stations = (['kitchen', 'bar'] as const).filter((s) => config[s]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [station, setStation] = useState<'kitchen' | 'bar'>(stations[0] ?? 'kitchen');
  const [error, setError] = useState('');

  const amount = Number.parseFloat(price);
  const add = () => {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) { setError('Write what it is'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter the price'); return; }
    if (amount > 10000) { setError('That price is too high'); return; }
    onAdd(station, clean, Math.round(amount * 100) / 100);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Special item"
      onClick={onClose}>
      <form className="w-full max-w-sm space-y-3 rounded-2xl border-2 border-orange-400 bg-slate-900 p-4 text-white"
        onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="flex items-center justify-between">
          <p className="text-xl font-extrabold">Special item</p>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 hover:bg-slate-800"><X size={18} /></button>
        </div>
        <label className="block">
          <span className="mb-1 block text-base font-bold text-slate-200">What is it?</span>
          <textarea name="special-name" rows={1} autoFocus value={name} maxLength={MAX_NAME} autoComplete="off" data-1p-ignore data-lpignore="true"
            onChange={(e) => { setName(e.target.value.replace(/\n/g, ' ')); setError(''); }}
            placeholder="Grilled river fish"
            className="min-h-14 w-full resize-none rounded-lg border-2 border-slate-600 bg-slate-950 px-3 py-3 text-xl text-white outline-none focus:border-orange-400" />
        </label>
        <label className="block">
          <span className="mb-1 block text-base font-bold text-slate-200">Price ($)</span>
          <input name="special-price" inputMode="decimal" value={price} autoComplete="off" data-1p-ignore data-lpignore="true"
            onChange={(e) => { setPrice(e.target.value.replace(/[^\d.]/g, '')); setError(''); }}
            placeholder="0.00"
            className="min-h-14 w-full rounded-lg border-2 border-slate-600 bg-slate-950 px-3 py-2 text-2xl font-bold tabular-nums text-white outline-none focus:border-orange-400" />
        </label>
        {stations.length > 1 && (
          <div>
            <span className="mb-1 block text-base font-bold text-slate-200">Send to</span>
            <div className="grid grid-cols-2 gap-2">
              {stations.map((s) => (
                <button key={s} type="button" aria-pressed={station === s} onClick={() => setStation(s)}
                  className={`min-h-14 rounded-xl border-2 text-lg font-extrabold ${station === s ? 'border-orange-400 bg-orange-500 text-black' : 'border-slate-600 hover:bg-slate-800'}`}>
                  {s === 'kitchen' ? 'Kitchen' : 'Bar'}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-base font-bold text-red-400" role="alert">{error}</p>}
        <button type="submit" data-testid="special-item-add"
          className="min-h-14 w-full rounded-2xl bg-emerald-600 text-xl font-black text-white hover:bg-emerald-500">
          {Number.isFinite(amount) && amount > 0 ? `Add to bill · $${amount.toFixed(2)}` : 'Add to bill'}
        </button>
      </form>
    </div>
  );
}
