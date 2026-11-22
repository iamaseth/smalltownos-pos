'use client';

import { useState, type ReactNode } from 'react';
import {
  Plus, Minus, Trash2, Pause, X, StickyNote, SquarePen,
  Users, MoreHorizontal, Printer, GitMerge, ArrowLeftRight, BadgePercent, CreditCard,
} from 'lucide-react';
import { cartLineTotal, useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import type { Table, Order, OrderItem, CartItem } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';

export type OrderDestination = 'table' | 'tab' | 'togo';

interface Props {
  tables: Table[];
  currency: string;
  submitting: boolean;
  onPlaceOrder: () => void;
  destination: OrderDestination | null;
  showTableOption?: boolean;
  onSelectTable: () => void;
  onSelectTab: () => void;
  onSelectToGo: () => void;
  onClearCart?: () => void;
  onPayExisting?: () => void;
  onShowTabs?: () => void;
  openTabCount?: number;
  onPayNow: () => void;
  /** Prints the open order's bill for the customer before payment. */
  onPrintBill?: () => void;
  /** Sends the unsent cart items, then prints the bill. */
  onSendAndPrintBill?: () => void;
  onEditItem?: (item: CartItem) => void;
  variant?: 'sidebar' | 'drawer';
  existingOrder?: Order | null;
}

function ItemQuantityControl({
  item,
  updateQuantity,
}: {
  item: CartItem;
  updateQuantity: (cartItemId: string, quantity: number) => void;
}) {
  const t = useTranslations('pos');
  const step = fractionalQuantityStep(item.product);
  const [draft, setDraft] = useState(() => String(item.quantity));
  const [lastQuantity, setLastQuantity] = useState(item.quantity);
  if (lastQuantity !== item.quantity) {
    setLastQuantity(item.quantity);
    setDraft(String(item.quantity));
  }

  const commitDraft = () => {
    if (step == null) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(item.quantity));
      return;
    }
    const rounded = Math.max(step, roundToQuantityPrecision(parsed, step));
    updateQuantity(item.id, rounded);
    setDraft(String(rounded));
  };

  const stepBy = (sign: 1 | -1) => {
    if (step == null) {
      updateQuantity(item.id, item.quantity + sign);
      return;
    }
    const next = roundToQuantityPrecision(item.quantity + sign * step, step);
    updateQuantity(item.id, next);
    setDraft(String(next));
  };

  if (step == null) {
    return (
      <>
        <button
          onClick={() => stepBy(-1)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2] active:scale-95"
          aria-label={t('remove')}
        >
          <Minus size={16} />
        </button>
        <span className="min-w-[26px] text-center text-[15px] font-bold tabular-nums">{item.quantity}</span>
        <button
          onClick={() => stepBy(1)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2] active:scale-95"
          aria-label={t('addItems')}
        >
          <Plus size={16} />
        </button>
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => stepBy(-1)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2] active:scale-95"
        aria-label={t('remove')}
      >
        <Minus size={16} />
      </button>
      <input
        type="number"
        inputMode="decimal"
        min={step}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitDraft();
        }}
        aria-label={t('quantity')}
        className="h-7 w-9 rounded-lg border-2 border-[#4a5f92] bg-[#141f38] text-center text-[14px] font-bold tabular-nums"
      />
      <button
        onClick={() => stepBy(1)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2] active:scale-95"
        aria-label={t('addItems')}
      >
        <Plus size={16} />
      </button>
    </>
  );
}

export default function CartPanel({ tables, submitting, onPlaceOrder, destination, showTableOption = true, onSelectTable, onSelectTab, onSelectToGo, onClearCart, onPayExisting, onShowTabs, openTabCount = 0, onPayNow, onEditItem, variant = 'sidebar', existingOrder, onPrintBill, onSendAndPrintBill }: Props) {
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { currentTenant } = useAuthStore();
  const billingType = usePosSettingsStore((s) => s.billingType);
  const t = useTranslations('pos');
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const fmt = useFormatCurrency();
  const canHold = isRestaurant && cart.orderType === 'dine_in' && cart.tableId && cart.items.length > 0 && billingType === 'postpaid';

  const handleHold = async () => {
    if (!cart.tableId) {
      toast.error(t('selectTableFirst'));
      return;
    }
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === cart.tableId)?.name || cart.tableId;
    try {
      await heldOrders.holdOrder(cart.tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      toast.success(t('orderHeldFor', { table: tableName }));
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: { error?: string } } })?.response;
      toast.error(response?.status === 409 && response.data?.error ? response.data.error : t('holdOrderFailed'));
    }
  };

  const [moreOpen, setMoreOpen] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const isDrawer = variant === 'drawer';
  const selectedTable = tables.find((table) => table.id === cart.tableId);
  const total = cart.subtotal(); // New items only; preserve existing checkout calculation.
  const savedItems = (existingOrder?.items || []).filter((item: OrderItem) => item.status !== 'cancelled');
  const savedSubtotal = savedItems.reduce((sum: number, item: OrderItem) => sum + (Number(item.total) || 0), 0);
  const combinedSubtotal = savedSubtotal + total; // Informational only; tax and payments are calculated at checkout.
  const menuItem = 'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-[15px] font-semibold hover:bg-[#243049] disabled:opacity-40';
  const iconButton = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 active:scale-95';
  const destinationPrompt = 'flex h-11 w-full items-center justify-center rounded-xl border-2 border-dashed border-[#f5b942] text-[16px] font-bold text-[#f5b942]';
  return (
    <div className={isDrawer ? 'relative flex w-full flex-col bg-[#0f1729] text-[#e5e9f2]' : 'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0f1729] text-[#e5e9f2]'}>
      {/* Exact reference hierarchy: header, scrollable rows, notes, fixed totals and actions. */}
      <div className="relative shrink-0 border-b border-[#243049] px-3 py-[10px]">
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Order type" className="flex min-w-0 flex-1 overflow-hidden rounded-xl border-2 border-[#3d4f7c]">
            {([
              ...(showTableOption ? [['table', 'Table', onSelectTable] as const] : []),
              ['tab', 'Tab', onSelectTab] as const,
              ['togo', 'To Go', onSelectToGo] as const,
            ]).map(([key, label, onSelect], index) => {
              const active = destination === key;
              return (
                <button key={key} type="button" aria-pressed={active} onClick={() => { setMoreOpen(false); onSelect(); }}
                  title={label}
                  className={`flex h-11 min-w-0 flex-1 items-center justify-center whitespace-nowrap px-1 text-[14px] font-extrabold uppercase ${index > 0 ? 'border-s-2 border-[#3d4f7c]' : ''} ${active ? 'bg-[#2563eb] text-white' : 'bg-[#22325a] hover:bg-[#2b3d68]'}`}>
                  {label}
                </button>
              );
            })}
          </div>
          {onShowTabs && (
            <button type="button" onClick={() => { setMoreOpen(false); onShowTabs(); }}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border-2 border-[#3d4f7c] bg-[#22325a] px-3 text-[14px] font-extrabold">
              Open ({openTabCount})
            </button>
          )}
        </div>
        <div className="mt-2 flex min-h-11 items-center justify-between gap-2 text-[15px]">
          {destination === 'table' && (cart.tableId ? (
            <>
              <button type="button" onClick={onSelectTable} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-start" title="Change table">
                <span className="min-w-0 break-words text-[20px] font-black leading-tight text-white">{selectedTable?.name || cart.tableId}</span>
                {existingOrder && <span className="shrink-0 text-[14px] font-semibold text-[#8f9bb8]">#{existingOrder.order_number}</span>}
              </button>
              <div className="flex shrink-0 items-center gap-1 text-[14px] font-bold">
                <button type="button" className={iconButton+' border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2]'} aria-label="Decrease pax" onClick={() => cart.setGuestCount(Math.max(1,cart.guestCount-1))}><Minus size={16}/></button>
                <span className="min-w-[52px] text-center">{cart.guestCount} Pax</span>
                <button type="button" className={iconButton+' border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2]'} aria-label="Increase pax" onClick={() => cart.setGuestCount(Math.min(99,cart.guestCount+1))}><Plus size={16}/></button>
              </div>
            </>
          ) : (
            <button type="button" onClick={onSelectTable} className={destinationPrompt}>Tap to pick a table</button>
          ))}
          {destination === 'tab' && (cart.tabName ? (
            <>
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 break-words text-[20px] font-black leading-tight text-white">Tab: {cart.tabName}</span>
                {existingOrder && <span className="min-w-0 truncate text-[14px] font-semibold text-[#8f9bb8]">#{existingOrder.order_number}</span>}
              </span>
              <button type="button" onClick={onSelectTab} className="h-10 shrink-0 rounded-lg border-2 border-[#3d4f7c] bg-[#22325a] px-3 text-[14px] font-bold" title="Change tab">Change</button>
            </>
          ) : (
            <button type="button" onClick={onSelectTab} className={destinationPrompt}>Tap to name or choose a tab</button>
          ))}
          {destination === 'togo' && (existingOrder ? (
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2"><span className="min-w-0 break-words text-[20px] font-black leading-tight text-white">To Go{cart.tabName ? `: ${cart.tabName}` : ''}</span><span className="shrink-0 text-[14px] font-semibold text-[#8f9bb8]">#{existingOrder.order_number}</span></span>
          ) : (
            <input type="text" maxLength={60} value={cart.tabName} onChange={(e) => cart.setTabName(e.target.value)}
              placeholder="Customer name (optional)" aria-label="To Go customer name"
              className="h-11 w-full rounded-lg border-2 border-[#3d4f7c] bg-[#0f1729] px-3 text-[16px] font-bold outline-none placeholder:font-semibold placeholder:text-[#7f8bab] focus:border-[#3b73f0]"/>
          ))}
          {!destination && <span className="text-[15px] font-semibold text-[#8f9bb8]">{showTableOption ? 'Choose Table, Tab or To Go' : 'Walk-in · or choose Tab / To Go'}</span>}
        </div>
      </div>
      <div className={isDrawer ? 'max-h-[40vh] overflow-y-auto px-[10px] py-[6px]' : 'min-h-0 flex-1 overflow-y-auto px-[10px] py-[6px]'}>
        {existingOrder && <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#a9b9dd]">Already on tab · {savedItems.length} line items</div>}
        {savedItems.map((item: OrderItem) => (
          <div key={item.id} className="mb-1 flex justify-between text-[12px] text-[#8f9bb8]"><span>{item.quantity}× {item.product_name}</span><span>{fmt(Number(item.total))}</span></div>
        ))}
        {existingOrder && <div className="mt-3 border-t border-[#243049] pt-2 text-xs font-semibold uppercase tracking-wide text-[#a9b9dd]">New items to add</div>}
        {cart.items.length === 0 && <div className="py-5 text-center text-[13px] text-[#6b7694]">{existingOrder ? 'No new items selected. Saved tab items are above.' : 'Cart is empty'}</div>}
        {cart.items.map(item => (
          <div key={item.id} className="border-b border-[#334155]/60 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-bold leading-tight text-white" title={item.product.name}>{item.product.name}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1 rounded-lg bg-[#e8f3ff] px-1 py-0.5 text-[#0878d1]">
                <ItemQuantityControl item={item} updateQuantity={cart.updateQuantity}/>
              </div>
              <span className="w-[62px] shrink-0 text-right text-[14px] font-extrabold tabular-nums text-white">{fmt(cartLineTotal(item))}</span>
              {onEditItem && <button type="button" onClick={() => onEditItem(item)} aria-label={`Edit ${item.product.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center text-white"><SquarePen size={17}/></button>}
              <button type="button" onClick={() => cart.removeItem(item.id)} aria-label={`Remove ${item.product.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center text-red-500"><Trash2 size={18}/></button>
            </div>
            {item.special_instructions && <div className="mt-0.5 truncate text-[12px] leading-tight text-slate-400">{item.special_instructions}</div>}
            {item.addons.length > 0 && <div className="mt-0.5 truncate text-[11px] leading-tight text-slate-400">{item.addons.map(a => `+ ${a.name}${(a.quantity || 1)>1 ? ' ×'+a.quantity : ''}`).join(', ')}</div>}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t-2 border-[#243049] px-3 pb-3 pt-2">
        {cart.orderNotes && (
          <button type="button" onClick={() => { setMoreOpen(true); setEditingNote(true); }} className="mb-1.5 block w-full truncate text-start text-[14px] font-semibold text-[#8f9bb8]" title="Edit order note">
            Note: {cart.orderNotes}
          </button>
        )}
        {existingOrder && <div className="flex justify-between text-[14px] font-semibold text-[#8f9bb8]"><span>Already on the bill</span><span className="tabular-nums">{fmt(savedSubtotal)}</span></div>}
        <div className="flex items-baseline justify-between gap-2 pb-2 text-[26px] font-black leading-tight" data-testid="cart-total"><span>Total</span><span className="tabular-nums">{fmt(existingOrder ? combinedSubtotal : total)}</span></div>
        {(() => {
          const empty = submitting || cart.items.length === 0;
          const side = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-[#3d4f7c] bg-[#22325a] text-white disabled:opacity-40';
          const secondary = 'flex h-12 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-[#3d4f7c] bg-[#22325a] px-2 text-[16px] font-bold text-white disabled:opacity-40';
          const payButton = 'flex h-12 min-w-0 flex-[1.4] items-center justify-center gap-1.5 rounded-xl bg-[#22c55e] px-2 text-[18px] font-black text-black disabled:opacity-40';
          const sendFirst = cart.items.length > 0 && Boolean(onSendAndPrintBill) && billingType !== 'prepaid';
          const canPrintBill = sendFirst || (Boolean(onPrintBill) && cart.items.length === 0);
          const printButton = <button type="button" disabled={!canPrintBill || submitting} onClick={sendFirst ? onSendAndPrintBill : onPrintBill}
            title={sendFirst ? 'Send the new items and print the bill' : onPrintBill ? 'Print bill for the customer' : 'Open a table or tab to print its bill'}
            aria-label={sendFirst ? 'Send and print bill' : 'Print bill'} className={side}><Printer size={20}/></button>;
          const moreButton = <button type="button" onClick={() => { setMoreOpen(!moreOpen); setEditingNote(false); }} aria-label="More actions" aria-expanded={moreOpen} className={side}><MoreHorizontal size={22}/></button>;
          let actions: ReactNode;
          if (billingType === 'prepaid') {
            actions = <button type="button" onClick={onPlaceOrder} disabled={empty} aria-label={`Pay ${fmt(total)}`} className={payButton}><CreditCard size={18}/>{submitting ? t('placing') : 'Pay'}</button>;
          } else if (existingOrder) {
            actions = <>
              {onPayExisting && (
                <button type="button" onClick={onPayExisting} disabled={submitting || cart.items.length > 0}
                  title={cart.items.length > 0 ? 'Send the new items first' : undefined} className={secondary}><CreditCard size={17}/>Bill</button>
              )}
              <button type="button" onClick={onPlaceOrder} disabled={empty} className="flex h-12 min-w-0 flex-[1.4] items-center justify-center rounded-xl bg-[#2563eb] px-2 text-[16px] font-bold text-white disabled:opacity-40"><span className="truncate">{submitting ? t('placing') : `Add to ${destination === 'table' && selectedTable ? selectedTable.name : cart.tabName || `#${existingOrder.order_number}`}`}</span></button>
            </>;
          } else {
            actions = <>
              <button type="button" onClick={onPlaceOrder} disabled={empty} className={secondary}
                title={destination === 'togo' ? 'Send now, pay later' : cart.tableId ? 'Send order' : 'Add to tab'}>{submitting ? t('placing') : 'Send'}</button>
              <button type="button" onClick={onPayNow} disabled={empty} aria-label={`Pay ${fmt(total)}`} className={payButton}><CreditCard size={18}/>Pay</button>
            </>;
          }
          return <div className="flex gap-[6px]">{printButton}{actions}{moreButton}</div>;
        })()}
      </div>
      {moreOpen && <div className="absolute bottom-[68px] end-3 z-40 w-[250px] rounded-xl border-2 border-[#3d4f7c] bg-[#1a2540] p-1.5 shadow-xl">
        {editingNote ? (
          <div className="p-1.5">
            <label className="mb-1 block text-[13px] font-bold text-[#8f9bb8]" htmlFor="cart-order-note">Order note</label>
            <textarea id="cart-order-note" autoFocus maxLength={200} rows={3} value={cart.orderNotes} onChange={e => cart.setOrderNotes(e.target.value)}
              placeholder="e.g. birthday, no ice for the table" className="w-full rounded-lg border-2 border-[#3d4f7c] bg-[#0f1729] p-2 text-[15px] outline-none placeholder:text-[#7f8bab] focus:border-[#3b73f0]"/>
            <div className="mt-1 flex items-center justify-between text-[12px] text-[#8f9bb8]"><span>{cart.orderNotes.length}/200</span>
              <button type="button" onClick={() => { setEditingNote(false); setMoreOpen(false); }} className="rounded-lg bg-[#2563eb] px-3 py-1.5 text-[14px] font-bold text-white">Done</button></div>
          </div>
        ) : (<>
          <button type="button" onClick={() => setEditingNote(true)} className={menuItem}><StickyNote size={17}/>{cart.orderNotes ? 'Edit order note' : 'Add order note'}</button>
          <button type="button" disabled={!canHold} onClick={() => { setMoreOpen(false); handleHold(); }} className={menuItem}><Pause size={17}/>Hold</button>
          <button type="button" disabled title="Split bill workflow not connected" className={menuItem}><Users size={17}/>Split bill</button>
          <button type="button" disabled={cart.items.length===0} onClick={() => { if(window.confirm('Clear cart?')) {cart.clearCart();onClearCart?.();setMoreOpen(false);} }} className={menuItem}><Trash2 size={17}/>Clear cart</button>
          <div className="my-1 border-t border-[#2f3d5c]"/>
          {([['Combine bills',GitMerge],['Move table',ArrowLeftRight],['Discount',BadgePercent]] as const).map(([label,Icon]) => (
            <div key={label} className="flex items-center gap-2 rounded-lg p-2 text-[14px] text-[#6b7694]"><Icon size={16}/>{label}<span className="ms-auto rounded-full bg-[#243049] px-1.5 text-[11px] text-[#8f9bb8]">Soon</span></div>
          ))}
        </>)}
      </div>}
    </div>
  );
}
