'use client';

import { useState } from 'react';
import {
  Plus, Minus, Trash2, Pause, SquarePen,
  Users, MoreHorizontal, Save, Printer, GitMerge, ArrowLeftRight, BadgePercent, ChevronDown, CreditCard,
} from 'lucide-react';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import type { Table, Order, OrderItem, CartItem } from '@/lib/types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';

interface Props {
  tables: Table[];
  currency: string;
  submitting: boolean;
  onPlaceOrder: () => void;
  onChooseDestination: () => void;
  onShowTabs?: () => void;
  openTabCount?: number;
  onPayNow: () => void;
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
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2]"
          aria-label={t('remove')}
        >
          <Minus size={16} />
        </button>
        <span className="min-w-[20px] text-center text-[13px] font-medium tabular-nums">{item.quantity}</span>
        <button
          onClick={() => stepBy(1)}
          className="touch-target rounded-full bg-muted transition-colors hover:bg-muted/70 active:bg-muted/70"
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
        className="touch-target rounded-full bg-muted transition-colors hover:bg-muted/70 active:bg-muted/70"
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
        className="w-10 rounded-md border border-[#4a5f92] bg-[#141f38] text-center text-[13px] tabular-nums"
      />
      <button
        onClick={() => stepBy(1)}
        className="touch-target rounded-full bg-muted transition-colors hover:bg-muted/70 active:bg-muted/70"
        aria-label={t('addItems')}
      >
        <Plus size={16} />
      </button>
    </>
  );
}

export default function CartPanel({ tables, submitting, onPlaceOrder, onChooseDestination, onShowTabs, openTabCount = 0, onPayNow, onEditItem, variant = 'sidebar', existingOrder }: Props) {
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
    } catch {
      toast.error(t('holdOrderFailed'));
    }
  };

  const [moreOpen, setMoreOpen] = useState(false);
  const isDrawer = variant === 'drawer';
  const selectedTable = tables.find((table) => table.id === cart.tableId);
  const total = cart.subtotal(); // Preserve the existing checkout calculation; do not invent 10% tax.
  const iconButton = 'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-[#4a5f92] bg-[#2b3d68] text-[#e5e9f2]';
  return (
    <div className={isDrawer ? 'relative flex w-full flex-col bg-[#0f1729] text-[#e5e9f2]' : 'relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#0f1729] text-[#e5e9f2]'}>
      {/* Exact reference hierarchy: header, scrollable rows, notes, fixed totals and actions. */}
      <div className="relative flex shrink-0 items-center justify-between border-b border-[#243049] px-3 py-[10px]">
        <div className="relative">
          <button type="button" onClick={() => { setMoreOpen(false); onChooseDestination(); }}
            className="flex items-center gap-1.5 rounded-lg border border-[#3d4f7c] bg-[#22325a] px-[10px] py-[5px] text-[13px] font-medium">
            {cart.tabName ? `${cart.orderType === 'takeaway' ? 'Takeaway' : 'Tab'}: ${cart.tabName}` : cart.orderType === 'takeaway' ? 'Takeaway' : selectedTable?.name || 'Walk-in'} <ChevronDown size={14}/>
          </button>
        </div>
        {onShowTabs && (
          <button type="button" onClick={() => { setMoreOpen(false); onShowTabs(); }}
            className="flex items-center gap-1.5 rounded-lg border border-[#3d4f7c] bg-[#22325a] px-[10px] py-[5px] text-[13px] font-medium">
            Open ({openTabCount})
          </button>
        )}
        {cart.orderType === 'dine_in' && cart.tableId && (
          <div className="flex items-center gap-1 rounded-full bg-[#1a2540] px-1 py-[3px] text-[12px]">
            <button type="button" className={iconButton} aria-label="Decrease pax" onClick={() => cart.setGuestCount(Math.max(1,cart.guestCount-1))}><Minus size={14}/></button>
            <span className="min-w-[48px] text-center">{cart.guestCount} Pax</span>
            <button type="button" className={iconButton} aria-label="Increase pax" onClick={() => cart.setGuestCount(Math.min(99,cart.guestCount+1))}><Plus size={14}/></button>
          </div>
        )}
      </div>
      <div className={isDrawer ? 'max-h-[40vh] overflow-y-auto px-[10px] py-[6px]' : 'min-h-0 flex-1 overflow-y-auto px-[10px] py-[6px]'}>
        {existingOrder?.items?.filter((i: OrderItem) => i.status !== 'cancelled').map((item: OrderItem) => (
          <div key={item.id} className="mb-1 flex justify-between text-[12px] text-[#8f9bb8]"><span>{item.quantity}× {item.product_name}</span><span>{fmt(Number(item.total))}</span></div>
        ))}
        {cart.items.length === 0 && <div className="py-10 text-center text-[13px] text-[#6b7694]">Cart is empty</div>}
        {cart.items.map(item => (
          <div key={item.id} className="mb-1 rounded-lg border border-[#243049] bg-[#141f38] px-[6px] py-[5px]">
            <div className="flex items-center gap-[6px]">
              <div className="min-w-0 flex-1 leading-[1.25]">
                <span className="block text-[13px] font-medium" title={item.product.name}>{item.product.name}</span>
                <span className="text-[12px] text-[#8f9bb8]">{fmt(Number(item.product.price))}</span>
              </div>
              {onEditItem && <button type="button" onClick={() => onEditItem(item)} className={iconButton+' border-[#7a5f22] bg-[#3a2f16] text-[#f5b942]'} aria-label="Edit item"><SquarePen size={14}/></button>}
              <div className="flex shrink-0 items-center gap-[3px]"><ItemQuantityControl item={item} updateQuantity={cart.updateQuantity}/></div>
              <button type="button" onClick={() => cart.removeItem(item.id)} className={iconButton+' border-[#7a3a46] bg-[#3a1d24] text-[#f08a8a]'} aria-label="Remove item"><Trash2 size={14}/></button>
            </div>
            {item.addons.map(a => <div key={a.id} className="pl-[2px] text-[11px] leading-[1.3] text-[#8f9bb8]">+ {a.name}{(a.quantity || 1)>1 ? ' ×'+a.quantity : ''}{Number(a.price)>0 ? ' ('+fmt(Number(a.price)*(a.quantity||1))+')' : ''}</div>)}
            {item.special_instructions && <div className="pl-[2px] text-[11px] leading-[1.3] text-[#8f9bb8]">{item.special_instructions}</div>}
          </div>
        ))}
      </div>
      <div className="relative mx-[10px] mt-[2px] h-[26px] shrink-0">
        <input type="text" maxLength={200} value={cart.orderNotes} onChange={e => cart.setOrderNotes(e.target.value)}
          placeholder="Order notes (optional)" className="h-[26px] w-full rounded-md border border-[#2f3d5c] bg-[#0f1729] pl-2 pr-[46px] text-[12px] outline-none placeholder:text-[#7f8bab] focus:border-[#3b73f0]"/>
        <span className="pointer-events-none absolute right-2 top-[6px] text-[11px] leading-[14px] text-[#6b7694]">{cart.orderNotes.length}/200</span>
      </div>
      <div className="mt-[6px] shrink-0 border-t border-[#243049] px-3 pb-3 pt-[6px]">
        <div className="flex justify-between py-[1px] text-[12px] text-[#8f9bb8]"><span>Items</span><span>{cart.itemCount()}</span></div>
        <div className="flex justify-between py-[1px] text-[12px] text-[#8f9bb8]"><span>Subtotal</span><span>{fmt(cart.subtotal())}</span></div>
        <div className="flex justify-between py-[1px] text-[12px] text-[#8f9bb8]"><span>Tax</span><span>Calculated at checkout</span></div>
        <div className="flex justify-between pb-2 pt-[6px] text-[18px] font-medium"><span>Total before tax</span><span>{fmt(total)}</span></div>
        {(() => {
          const empty = submitting || cart.items.length === 0;
          const primary = 'flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#2563eb] text-[14px] font-medium text-white disabled:opacity-40';
          if (billingType === 'prepaid') {
            return <button type="button" onClick={onPlaceOrder} disabled={empty} className={`${primary} w-full`}><CreditCard size={15}/>{submitting ? t('placing') : 'Pay '+fmt(total)}</button>;
          }
          if (existingOrder) {
            return <button type="button" onClick={onPlaceOrder} disabled={empty} className={`${primary} w-full`}>{submitting ? t('placing') : `Add to order #${existingOrder.order_number}`}</button>;
          }
          return (
            <div className="flex gap-[6px]">
              <button type="button" onClick={onPlaceOrder} disabled={empty}
                className="flex h-10 flex-1 items-center justify-center rounded-lg border border-[#3d4f7c] bg-[#22325a] text-[14px] font-medium text-white disabled:opacity-40">{submitting ? t('placing') : cart.tableId ? 'Send order' : 'Add to tab'}</button>
              <button type="button" onClick={onPayNow} disabled={empty} className={primary}><CreditCard size={15}/>Pay {fmt(total)}</button>
            </div>
          );
        })()}
        <div className="mt-[6px] flex gap-[6px]">
          <button type="button" disabled={!canHold} onClick={handleHold} className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border border-[#3d4f7c] bg-[#22325a] text-[12px] disabled:opacity-40"><Pause size={14}/>Hold</button>
          <button type="button" disabled title="Save not connected" className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border border-[#3d4f7c] bg-[#22325a] text-[12px] opacity-40"><Save size={14}/>Save</button>
          <button type="button" disabled title="Print not connected" className="flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border border-[#3d4f7c] bg-[#22325a] text-[12px] opacity-40"><Printer size={14}/>Print</button>
          <button type="button" onClick={() => { setMoreOpen(!moreOpen); }} aria-label="More actions" aria-expanded={moreOpen}
            className="flex h-8 w-10 shrink-0 items-center justify-center rounded-lg border border-[#3d4f7c] bg-[#22325a]"><MoreHorizontal size={17}/></button>
        </div>
      </div>
      {moreOpen && <div className="absolute bottom-[54px] right-3 z-40 w-[210px] rounded-[10px] border border-[#3d4f7c] bg-[#1a2540] p-1 shadow-xl">
        <button type="button" disabled title="Split bill workflow not connected" className="flex w-full items-center gap-2 rounded-md p-2 text-left text-[13px] opacity-50"><Users size={15}/>Split bill</button>
        <button type="button" disabled={cart.items.length===0} onClick={() => { if(window.confirm('Clear cart?')) {cart.clearCart();setMoreOpen(false);} }}
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-[13px] hover:bg-[#243049] disabled:opacity-40"><Trash2 size={15}/>Clear cart</button>
        <div className="my-1 border-t border-[#2f3d5c]"/>
        {([['Combine bills',GitMerge],['Move table',ArrowLeftRight],['Discount',BadgePercent]] as const).map(([label,Icon]) => (
          <div key={label} className="flex items-center gap-2 rounded-md p-2 text-[13px] text-[#6b7694]"><Icon size={15}/>{label}<span className="ml-auto rounded-full bg-[#243049] px-1.5 text-[10px] text-[#8f9bb8]">Soon</span></div>
        ))}
      </div>}
    </div>
  );
}
