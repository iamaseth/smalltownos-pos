'use client';

import { useState, useEffect } from 'react';
import { X, ShoppingCart, Users, Trash2, BadgePercent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import toast from 'react-hot-toast';
import type { Table, Order, Bill, OrderItem } from '@/lib/types';
import { SplitCheckModal } from '@/components/pos/SplitCheckModal';
import DiscountDialog, { type DiscountInput } from '@/components/pos/DiscountDialog';
import { useConfirm } from '@/hooks/use-confirm';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';

interface Props {
  table: Table;
  currency: string;
  cartItemCount: number;
  onClose: () => void;
  onAddItems: (table: Table, order: Order) => void;
  onPayment: (bill: Bill) => void;
  onAddCartToOrder?: (table: Table, order: Order) => void;
}

export default function TableCheckoutModal({
  table,

  cartItemCount,
  onClose,
  onAddItems,
  onPayment,
  onAddCartToOrder
}: Props) {
  const t = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const { confirm, ConfirmDialog } = useConfirm();
  const { currentTenant } = useAuthStore();
  const canCancelItems = tenantCan(currentTenant, 'orders.item.cancel');
  const canDiscount = tenantCan(currentTenant, 'orders.discount.apply');
  const [discountTarget, setDiscountTarget] = useState<{ kind: 'order' } | { kind: 'item'; item: OrderItem } | null>(null);
  const [removingId, setRemovingId] = useState<number | string | null>(null);
  const fmt = useFormatCurrency();
  const formatItemTotal = (value: unknown, fallback: unknown) => {
    const total = Number(value);
    if (Number.isFinite(total)) return fmt(total);
    const subtotal = Number(fallback);
    return fmt(Number.isFinite(subtotal) ? subtotal : 0);
  };
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [addingItems, setAddingItems] = useState(false);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);
  const [splitBill, setSplitBill] = useState<Bill | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const fetchOrder = async () => {
      try {
        const known = table.current_order || table.activeOrder;
        if (known) {
          const orderRes = await api.get(`/orders/${known.id}`, { signal: controller.signal });
          const fetched = orderRes.data.order;
          if (fetched && !['completed', 'cancelled'].includes(fetched.status)) {
            setOrder(fetched);
            return;
          }
        }
        const { data } = await api.get(`/tables/${table.id}`, { signal: controller.signal });
        const tbl = data.table;
        const activeOrder = tbl.activeOrder || tbl.current_order;
        if (activeOrder) {
          const orderRes = await api.get(`/orders/${activeOrder.id}`, { signal: controller.signal });
          setOrder(orderRes.data.order);
        }
      } catch {
        if (controller.signal.aborted) return;
        toast.error(t('loadOrderFailed'));
      } finally {
        setLoading(false);
      }
    };
    fetchOrder();
    return () => controller.abort();
  }, [table.id, table.current_order, table.activeOrder, t]);

  useEffect(() => {
    api.get('/settings/split_checks_enabled').then((res) => setSplitChecksEnabled(res.data?.setting?.value === 'true')).catch(() => setSplitChecksEnabled(false));
  }, []);

  const handleCheckout = async () => {
    if (!order) return;
    setGenerating(true);
    try {
      if (order.bill) {
        onPayment({ ...order.bill, order });
        return;
      }
      const { data } = await api.post('/bills/generate', { order_id: order.id });
      onPayment(data.bill);
    } catch {
      toast.error(t('generateBillFailed'));
    } finally {
      setGenerating(false);
    }
  };

  const handleSplitCheck = async () => {
    if (!order) return;
    setGenerating(true);
    try {
      const bill = order.bill ? { ...order.bill, order } : (await api.post('/bills/generate', { order_id: order.id })).data.bill;
      setSplitBill(bill);
    } catch {
      toast.error(t('generateBillFailed'));
    }
    finally { setGenerating(false); }
  };

  const handleRemoveItem = async (item: OrderItem) => {
    if (!order) return;
    if (!await confirm(`${tOrders('removeItemConfirm')} ${item.quantity}x ${item.product_name}`, { destructive: true, confirmLabel: tCommon('remove') })) return;
    setRemovingId(item.id);
    try {
      await api.patch(`/orders/${order.id}/items/${item.id}/cancel`, { reason: tOrders('removedByManager') });
      const { data } = await api.get(`/orders/${order.id}`);
      setOrder(data.order);
      toast.success(tOrders('itemRemoved'));
    } catch {
      toast.error(tOrders('removeItemFailed'));
    } finally {
      setRemovingId(null);
    }
  };

  const applyDiscount = async (input: DiscountInput) => {
    if (!order || !discountTarget) return;
    if (discountTarget.kind === 'order') {
      await api.patch(`/orders/${order.id}/discount`, {
        discount_type: input.type,
        discount_value: input.value,
        discount_reason: input.value > 0 ? input.reason : undefined,
        override_pin: input.pin,
      });
    } else {
      await api.patch(`/orders/${order.id}/items/${discountTarget.item.id}/discount`, {
        discount_type: input.type,
        discount_value: input.value,
        override_pin: input.pin,
      });
    }
    const { data } = await api.get(`/orders/${order.id}`);
    setOrder(data.order);
    toast.success(input.value === 0 ? t('discountRemoved') : t('discountUpdated'));
  };

  const handleAddCartToOrder = async () => {
    if (!order || !onAddCartToOrder) return;
    setAddingItems(true);
    try {
      await onAddCartToOrder(table, order);
    } catch {
      toast.error(t('addItemsFailed'));
    } finally {
      setAddingItems(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-card rounded-2xl p-8">
          <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-card rounded-2xl p-6 w-full max-w-md">
          <p className="text-muted-foreground text-center py-4">{t('noActiveOrder')}</p>
          <Button onClick={onClose} variant="outline" className="w-full">{t('close')}</Button>
        </div>
      </div>
    );
  }

  // Filter active items (not cancelled)
  const activeItems = (order.items || []).filter((item: OrderItem) => item.status !== 'cancelled');
  const splitBills = (order.bills || []).filter((bill) => Boolean(bill.split_group_id));
  const canEditOrder = order.bill?.payment_status !== 'paid' && splitBills.length === 0;

  return (
    <>
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="dark bg-neutral-950 text-white border-2 border-neutral-700 rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex justify-between items-center gap-4 bg-black px-5 py-4 border-b-2 border-neutral-800">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-3xl font-black text-white">{table.name}</h2>
              <span className={`px-2.5 py-0.5 text-sm font-extrabold uppercase tracking-wide rounded-full ${
                order.bill?.payment_status === 'paid' ? 'bg-green-500 text-black' : 'bg-orange-400 text-black'
              }`}>
                {order.bill?.payment_status === 'paid' ? t('paid') : t('unpaid')}
              </span>
            </div>
            <p className="mt-0.5 text-base font-semibold text-neutral-300">{t('orderNumber', { number: order.order_number })}</p>
          </div>
          <button onClick={onClose} className="touch-target h-13 w-13 rounded-xl border-2 border-neutral-600 bg-neutral-900 text-white hover:bg-neutral-800" aria-label={t('close')}>
            <X size={22} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* Existing order items - shown as disabled/reference */}
          <div className="mb-3">
            <p className="text-sm font-bold text-neutral-300 uppercase tracking-[0.1em] mb-2">{t('previousItems')}</p>
            <div className="space-y-2">
              {activeItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border-2 border-neutral-700 bg-neutral-900 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-lg text-white font-extrabold">
                      {item.quantity}× {item.product_name}
                    </p>
                    {item.special_instructions && (
                      <p className="text-sm font-semibold text-neutral-300">{item.special_instructions}</p>
                    )}
                  </div>
                  <span className="ms-2 text-end">
                    <span className="block text-lg font-extrabold text-white tabular-nums">{formatItemTotal(item.total, item.subtotal)}</span>
                    {Number(item.discount_amount) > 0 && <span className="block text-sm font-bold text-green-400">−{fmt(Number(item.discount_amount))}</span>}
                  </span>
                  {canDiscount && canEditOrder && (
                    <button type="button" onClick={() => setDiscountTarget({ kind: 'item', item })}
                      aria-label={`Discount ${item.product_name}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-green-700 bg-green-950 text-green-300 hover:bg-green-900"><BadgePercent size={20} /></button>
                  )}
                  {canCancelItems && canEditOrder && (
                    <button type="button" disabled={removingId === item.id} onClick={() => handleRemoveItem(item)}
                      aria-label={`${tCommon('remove')} ${item.product_name}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-red-800 bg-red-950 text-red-300 hover:bg-red-900 disabled:opacity-40"><Trash2 size={20} /></button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-black px-5 pb-5 pt-4 border-t-2 border-neutral-800 space-y-3">
          <div className="flex justify-between text-base font-semibold">
            <span className="text-neutral-300">{t('subtotal')}</span>
            <span className="tabular-nums">{fmt(Number(order.subtotal))}</span>
          </div>
          {Number(order.discount_amount) > 0 && (
            <div className="flex justify-between text-base font-bold text-green-400">
              <span>{t('discount')}</span>
              <span>−{fmt(Number(order.discount_amount))}</span>
            </div>
          )}
          <TaxBreakdown
            taxAmount={Number(order.tax_amount)}
            taxBreakdown={order.tax_breakdown}
            theme="dark"
          />
          <div className="flex items-baseline justify-between text-3xl font-black">
            <span>{t('total')}</span>
            <span className="tabular-nums">{fmt(Number(order.total))}</span>
          </div>
          {order.bill && order.bill.payment_status !== 'paid' && Number(order.bill.balance) > 0 && (
            <div className="flex justify-between text-base font-bold">
              <span className="text-orange-400">{t('balanceDue')}</span>
              <span className="text-orange-400 tabular-nums">{fmt(Number(order.bill.balance))}</span>
            </div>
          )}

          {splitBills.length > 0 && <div className="space-y-2">{splitBills.map((bill) => <div key={bill.id} className="flex items-center justify-between rounded-lg border p-2"><div><p className="text-sm font-medium">{bill.split_label}</p><p className="text-xs text-muted-foreground">{fmt(Number(bill.total))} · {bill.payment_status}</p></div>{bill.payment_status !== 'paid' && <Button size="sm" onClick={() => onPayment(bill)}>{t('pay')}</Button>}</div>)}</div>}

          {canDiscount && canEditOrder && (
            <Button variant="outline" size="lg" className="w-full h-12 border-2 border-neutral-600 bg-neutral-900 text-base font-bold text-white hover:bg-neutral-800" onClick={() => setDiscountTarget({ kind: 'order' })}>
              <BadgePercent size={18} className="me-2" />{Number(order.discount_amount) > 0 ? 'Change bill discount' : 'Discount whole bill'}
            </Button>
          )}
          {/* Show different buttons based on cart state */}
          {splitBills.length === 0 && splitChecksEnabled && order.type === 'dine_in' && order.bill?.payment_status !== 'paid' && <Button variant="outline" onClick={handleSplitCheck} disabled={generating} className="w-full"><Users size={15} className="me-2" />{t('splitCheck')}</Button>}
          {cartItemCount > 0 ? (
            // Cart has items - show "Add items to order" option
            <div className="space-y-2">
              <Button 
                onClick={handleAddCartToOrder} 
                disabled={addingItems}
                className="w-full h-14 bg-[#2563eb] text-lg font-bold text-white hover:bg-[#1d4ed8]"
                size="lg"
              >
                <ShoppingCart size={16} className="me-2" />
                {addingItems ? t('adding') : t('addToOrder', { count: cartItemCount })}
              </Button>
              <Button onClick={handleCheckout} variant="outline" size="lg" className="w-full h-14 border-2 border-neutral-400 bg-neutral-900 text-lg font-bold text-white hover:bg-neutral-800" disabled={generating}>
                {generating ? t('generating') : t('checkoutInstead')}
              </Button>
            </div>
          ) : splitBills.length === 0 ? (
            // Cart empty - show both options
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" size="lg" className="h-14 border-2 border-neutral-400 bg-neutral-900 text-lg font-bold text-white hover:bg-neutral-800" onClick={() => onAddItems(table, order)}>
                {t('addItems')}
              </Button>
              <Button size="lg" className="h-14 bg-green-500 text-xl font-black text-black hover:bg-green-400" onClick={handleCheckout} disabled={generating}>
                {generating ? t('generating') : t('checkout')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
    {ConfirmDialog}
    {discountTarget && (
      <DiscountDialog
        title={discountTarget.kind === 'order' ? 'Discount whole bill' : `Discount ${discountTarget.item.product_name}`}
        subtitle={discountTarget.kind === 'order' ? `${table.name} · ${t('orderNumber', { number: order.order_number })}` : `${discountTarget.item.quantity}x`}
        baseAmount={discountTarget.kind === 'order' ? Number(order.subtotal) : Number(discountTarget.item.subtotal)}
        canClear={discountTarget.kind === 'order' && Number(order.discount_amount) > 0}
        onClose={() => setDiscountTarget(null)}
        onApply={applyDiscount}
      />
    )}
    {splitBill && <SplitCheckModal bill={splitBill} order={order} onClose={() => setSplitBill(null)} onSplit={(bills) => { setOrder({ ...order, bill: bills[0], bills }); setSplitBill(null); }} />}
    </>
  );
}
