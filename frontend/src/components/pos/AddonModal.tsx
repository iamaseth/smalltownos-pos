'use client';

import { useState } from 'react';
import { X, Plus, Minus } from 'lucide-react';

import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { formatCurrencyForTenant } from '@/lib/countries';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';
import type { Product, Addon, AddonGroup } from '@/lib/types';

interface Props {
  product: Product;
  currency: string;
  /** Overrides the signed-in tenant's currency formatting (e.g. for standalone pages with no auth store). */
  country?: string;
  onAdd: (product: Product, quantity: number, addons: Addon[], specialInstructions: string) => void;
  onClose: () => void;
  initialQuantity?: number;
  initialAddons?: Addon[];
  initialInstructions?: string;
  mode?: 'add' | 'edit';
}

function groupInitialAddons(addons: Addon[]): Record<string | number, Addon[]> {
  const grouped: Record<string | number, Addon[]> = {};
  for (const addon of addons) {
    const groupId = addon.addon_group_id;
    if (groupId == null) continue;
    grouped[groupId] = [...(grouped[groupId] || []), addon];
  }
  return grouped;
}

export default function AddonModal({
  product, currency, country, onAdd, onClose,
  initialQuantity = 1, initialAddons = [], initialInstructions = '', mode = 'add',
}: Props) {
  const t = useTranslations('pos');
  const tenantFmt = useFormatCurrency();
  const fmt = country ? (n: number) => formatCurrencyForTenant(n, country, currency) : tenantFmt;
  const [selected, setSelected] = useState<Record<string | number, Addon[]>>(() => groupInitialAddons(initialAddons));
  const [quantity, setQuantity] = useState(initialQuantity);
  const [qtyDraft, setQtyDraft] = useState(() => String(initialQuantity));
  const [instructions, setInstructions] = useState(initialInstructions);
  const step = fractionalQuantityStep(product);

  const setQty = (next: number) => {
    setQuantity(next);
    setQtyDraft(String(next));
  };

  const commitQtyDraft = () => {
    if (step == null) return;
    const parsed = Number(qtyDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setQtyDraft(String(quantity));
      return;
    }
    const rounded = Math.max(step, roundToQuantityPrecision(parsed, step));
    setQuantity(rounded);
    setQtyDraft(String(rounded));
  };

  const groups = product.addon_groups || [];
  const tProducts = useTranslations('products');

  /** "American Breakfast — Egg style" → "Egg style": the item name is already at the top. */
  const shortGroupName = (name: string): string => {
    const prefix = product.name.trim();
    const rest = name.startsWith(prefix) ? name.slice(prefix.length).replace(/^\s*[—–:-]\s*/, '').trim() : '';
    return rest || name;
  };
  const groupRequiredMin = (g: AddonGroup): number => (Boolean(g.is_required) ? Math.max(1, g.min_selection || 1) : (g.min_selection || 0));

  const getGroupTotalQuantity = (groupId: string | number): number => {
    const list = selected[groupId] || [];
    return list.reduce((sum, a) => sum + (a.quantity || 1), 0);
  };

  const updateAddonQuantity = (group: AddonGroup, addon: Addon, delta: number) => {
    const groupId = group.id;
    const currentList = selected[groupId] || [];
    const existingIndex = currentList.findIndex((a) => a.id === addon.id);
    const currentQty = existingIndex >= 0 ? (currentList[existingIndex].quantity || 1) : 0;
    const newQty = currentQty + delta;

    if (newQty <= 0) {
      const updatedList = currentList.filter((a) => a.id !== addon.id);
      setSelected({ ...selected, [groupId]: updatedList });
    } else {
      const currentGroupTotal = currentList.reduce((sum, a) => sum + (a.quantity || 1), 0);
      const newGroupTotal = currentGroupTotal + delta;
      const max = group.max_selection || 999;
      if (delta > 0 && newGroupTotal > max) {
        toast.error(t('maxSelectionReached', { count: max }));
        return;
      }

      if (existingIndex >= 0) {
        const updatedList = [...currentList];
        updatedList[existingIndex] = { ...updatedList[existingIndex], quantity: newQty };
        setSelected({ ...selected, [groupId]: updatedList });
      } else {
        setSelected({ ...selected, [groupId]: [...currentList, { ...addon, quantity: newQty }] });
      }
    }
  };

  /** Tapping a row: a pick-one group switches to the tapped option instead of refusing it. */
  const tapAddonRow = (group: AddonGroup, addon: Addon, qty: number) => {
    if (qty === 0 && group.max_selection === 1) {
      setSelected({ ...selected, [group.id]: [{ ...addon, quantity: 1 }] });
      return;
    }
    if (qty === 0) updateAddonQuantity(group, addon, 1);
    else if (qty === 1) updateAddonQuantity(group, addon, -1);
  };

  const getAddonQuantity = (groupId: string | number, addonId: string | number): number => {
    const list = selected[groupId] || [];
    const item = list.find((a) => a.id === addonId);
    return item ? (item.quantity || 1) : 0;
  };

  const allAddons = Object.values(selected).flat();
  const addonTotal = allAddons.reduce((sum, a) => sum + Number(a.price) * (a.quantity || 1), 0);
  const itemTotal = (Number(product.price) + addonTotal) * quantity;

  const isValid = groups.every((g) => {
    const count = getGroupTotalQuantity(g.id);
    const requiredMin = Boolean(g.is_required) ? Math.max(1, g.min_selection || 1) : (g.min_selection || 0);
    if (count < requiredMin) return false;
    if (g.max_selection && count > g.max_selection) return false;
    return true;
  });

  const missingGroup = groups.find((g) => getGroupTotalQuantity(g.id) < groupRequiredMin(g));

  const handleAdd = () => {
    if (!isValid) return;
    let effectiveQuantity = quantity;
    if (step != null) {
      const parsed = Number(qtyDraft);
      if (Number.isFinite(parsed) && parsed > 0) {
        effectiveQuantity = Math.max(step, roundToQuantityPrecision(parsed, step));
        setQuantity(effectiveQuantity);
        setQtyDraft(String(effectiveQuantity));
      }
    }
    onAdd(product, effectiveQuantity, allAddons, instructions);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-lg max-h-[92vh] flex flex-col">
        <div className="flex justify-between items-center p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-foreground">{product.name}</h2>
            <p className="text-brand font-semibold">{fmt(Number(product.price))}</p>
          </div>
          <button onClick={onClose} className="touch-target rounded-full text-muted-foreground hover:text-foreground active:bg-muted" aria-label={t('close')}>
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {groups.map((group, index) => {
            const count = getGroupTotalQuantity(group.id);
            const activeAddons = (group.addons || []).filter((a) => a.is_active);
            const allowMultiple = Boolean(group.allow_multiple_quantities);
            const requiredMin = groupRequiredMin(group);
            const chosen = (selected[group.id] || []).map((a) => ((a.quantity || 1) > 1 ? `${a.quantity}× ${a.name}` : a.name));
            const done = count > 0 && count >= requiredMin;

            return (
              <section key={group.id} className="rounded-xl border-2 border-border overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-2.5 bg-muted">
                  <span className="shrink-0 w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center text-sm font-bold tabular-nums" aria-hidden>{index + 1}</span>
                  <h3 className="font-bold text-base text-foreground">{shortGroupName(group.name)}</h3>
                  <span
                    data-testid="addon-group-status"
                    className={`ms-auto shrink min-w-0 truncate rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      done
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                        : requiredMin > 0
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                          : 'bg-card text-muted-foreground'
                    }`}
                  >
                    {done ? `✓ ${chosen.join(', ')}` : requiredMin > 0 ? t('selectAtLeast', { count: requiredMin }) : tProducts('optional')}
                  </span>
                </div>
                {group.description && <p className="px-4 pt-2 text-xs text-muted-foreground">{group.description}</p>}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
                  {activeAddons.map((addon) => {
                    const addonQty = getAddonQuantity(group.id, addon.id);
                    const isSel = addonQty > 0;
                    const price = Number(addon.price);
                    return (
                      <div
                        key={addon.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSel}
                        onClick={() => tapAddonRow(group, addon, addonQty)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapAddonRow(group, addon, addonQty); } }}
                        className={`min-h-16 flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-2 py-2.5 text-center cursor-pointer select-none transition-colors active:scale-[0.98] ${
                          isSel ? 'border-brand bg-brand text-white' : 'border-border bg-card text-foreground hover:border-gray-400'
                        }`}
                      >
                        <span className="text-base font-bold leading-tight">{addon.name}</span>
                        {price !== 0 && (
                          <span className={`text-xs font-semibold ${isSel ? 'text-white' : 'text-muted-foreground'}`}>+{fmt(price)}</span>
                        )}
                        {allowMultiple && isSel && (
                          <span className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button type="button" onClick={() => updateAddonQuantity(group, addon, -1)} aria-label={t('remove')}
                              className="w-8 h-8 rounded-full bg-white/25 flex items-center justify-center"><Minus size={14} /></button>
                            <span className="w-6 text-center text-sm font-bold tabular-nums">{addonQty}</span>
                            <button type="button" onClick={() => updateAddonQuantity(group, addon, 1)} aria-label={t('addItems')}
                              className="w-8 h-8 rounded-full bg-white/25 flex items-center justify-center"><Plus size={14} /></button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('specialInstructions')}</label>
            <input
              type="text"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, 100))}
              placeholder={t('specialInstructionsPlaceholder')}
              maxLength={100}
              className="w-full min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-muted-foreground text-end mt-0.5">{instructions.length}/100</p>
          </div>
        </div>

        <div className="p-5 border-t border-border">
          <div className="flex items-center justify-center gap-4 mb-4">
            <button
              onClick={() =>
                step == null
                  ? setQty(Math.max(1, quantity - 1))
                  : setQty(Math.max(step, roundToQuantityPrecision(quantity - step, step)))
              }
              className="touch-target rounded-full bg-muted flex items-center justify-center hover:bg-muted active:bg-muted"
              aria-label={t('remove')}
            >
              <Minus size={18} />
            </button>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3].map((quickQty) => (
                <button
                  key={quickQty}
                  type="button"
                  onClick={() => setQty(quickQty)}
                  className={`touch-target rounded-lg border px-3 text-sm font-bold tabular-nums ${
                    quantity === quickQty ? 'border-brand bg-brand text-white' : 'border-border bg-card text-foreground'
                  }`}
                >
                  {quickQty}
                </button>
              ))}
            </div>
            {step == null ? (
              <span className="text-lg font-bold w-10 text-center tabular-nums">{quantity}</span>
            ) : (
              <input
                type="number"
                inputMode="decimal"
                min={step}
                step={step}
                value={qtyDraft}
                onChange={(e) => setQtyDraft(e.target.value)}
                onBlur={commitQtyDraft}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitQtyDraft();
                }}
                aria-label={t('quantity')}
                className="w-16 text-lg font-bold text-center tabular-nums border border-border bg-background rounded-md px-1 py-0.5 outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
              />
            )}
            <button
              onClick={() =>
                step == null
                  ? setQty(quantity + 1)
                  : setQty(roundToQuantityPrecision(quantity + step, step))
              }
              className="touch-target rounded-full bg-muted flex items-center justify-center hover:bg-muted active:bg-muted"
              aria-label={t('addItems')}
            >
              <Plus size={18} />
            </button>
          </div>
          <Button onClick={handleAdd} disabled={!isValid} className="w-full" size="lg">
            {!isValid && missingGroup
              ? t('selectName', { name: shortGroupName(missingGroup.name) })
              : mode === 'edit'
              ? t('saveItemChanges', { total: fmt(itemTotal) })
              : t('addToCart', { total: fmt(itemTotal) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
