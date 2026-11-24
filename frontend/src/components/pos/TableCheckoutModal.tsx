'use client';

import { useState, useEffect } from 'react';
import { X, ShoppingCart, Users, BadgePercent, Printer, Undo2, ArrowLeftRight, Plus, Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import toast from 'react-hot-toast';
import type { Table, Order, Bill, OrderItem } from '@/lib/types';
import { SplitCheckModal } from '@/components/pos/SplitCheckModal';
import DiscountDialog, { type DiscountInput } from '@/components/pos/DiscountDialog';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { VoidCompDialog } from '@/components/orders/VoidCompDialog';
import { ItemActionsPanel, NoteDialog, ChangeItemDialog, MoveItemsDialog, errorText, sentAtMs, type ItemAction } from '@/components/pos/BillItemActions';
import { usePrinterStore } from '@/hooks/usePrinter';
import { usePosSettingsStore } from '@/store/pos-settings';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import type { Product } from '@/lib/types';

interface Props {
  table: Table;
  currency: string;
  cartItemCount: number;
  onClose: () => void;
  onAddItems: (table: Table, order: Order) => void;
  onPayment: (bill: Bill) => void;
  onAddCartToOrder?: (table: Table, order: Order) => void;
  /** Prints the bill for the customer to check before paying. */
  /** Prints the customer bill; pass a split bill to print just that guest's bill. */
  onPrintBill?: (order: Order, bill?: Bill) => Promise<void> | void;
  tables?: Table[];
  onTablesChanged?: () => void;
}

export default function TableCheckoutModal({
  table,

  cartItemCount,
  onClose,
  onAddItems,
  onPayment,
  onAddCartToOrder,
  onPrintBill,
  tables = [],
  onTablesChanged,
}: Props) {
  const t = useTranslations('pos');
  const tOrders = useTranslations('orders');
  const { currentTenant } = useAuthStore();
  const canCancelItems = tenantCan(currentTenant, 'orders.item.cancel');
  const canDiscount = tenantCan(currentTenant, 'orders.discount.apply');
  const [discountTarget, setDiscountTarget] = useState<{ kind: 'order' } | { kind: 'item'; item: OrderItem } | null>(null);
  const [printingBill, setPrintingBill] = useState(false);
  const [removingId, setRemovingId] = useState<number | string | null>(null);
  const [compId, setCompId] = useState<number | null>(null);
  const [actionItem, setActionItem] = useState<OrderItem | null>(null);
  const [noteItem, setNoteItem] = useState<OrderItem | null>(null);
  const [changeItem, setChangeItem] = useState<OrderItem | null>(null);
  const [moveIds, setMoveIds] = useState<number[] | null>(null);
  const { printKot } = usePrinterStore();
  const { kotPrintingEnabled, autoPrintKot } = usePosSettingsStore();
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
  const [printingSplitId, setPrintingSplitId] = useState<number | null>(null);
  const [undoingSplit, setUndoingSplit] = useState(false);

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

  const handleUndoSplit = async () => {
    const first = (order?.bills || []).find((bill) => bill.split_group_id);
    if (!order || !first) return;
    setUndoingSplit(true);
    try {
      await api.post(`/bills/${first.id}/unsplit`);
      const { data } = await api.get(`/orders/${order.id}`);
      setOrder(data.order);
      toast.success('Split undone: back to one bill');
    } catch (error: unknown) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || 'Could not undo the split');
    } finally {
      setUndoingSplit(false);
    }
  };

  const handleRemoveItem = (item: OrderItem) => {
    if (!order) return;
    setRemovingId(item.id);
  };

  const refreshAfterRemoval = async () => {
    if (!order) return;
    setRemovingId(null);
    try {
      const { data } = await api.get(`/orders/${order.id}`);
      setOrder(data.order);
    } catch {
      toast.error(tOrders('removeItemFailed'));
    }
  };

  const reloadOrder = async (orderId: number | string) => {
    const { data } = await api.get(`/orders/${orderId}`);
    const next = data.order as Order;
    if (!next || ['completed', 'cancelled'].includes(next.status)) {
      onTablesChanged?.();
      onClose();
      return null;
    }
    setOrder(next);
    return next;
  };

  const kitchenTicket = async (base: Order, items: OrderItem[], manual = false) => {
    if (!kotPrintingEnabled || (!manual && !autoPrintKot)) return;
    try {
      showPrintWarningsToast(await printKot({ ...base, items }, { items }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Kitchen ticket did not print');
    }
  };

  const addOneMore = async (item: OrderItem) => {
    if (!order) return;
    try {
      const { data } = await api.post(`/orders/${order.id}/items`, {
        items: [{ product_id: item.product_id, quantity: 1, addons: null, special_instructions: item.special_instructions || null }],
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
      const before = new Set((order.items || []).map((i) => Number(i.id)));
      const added = ((data.order as Order).items || []).filter((i) => !before.has(Number(i.id)));
      await kitchenTicket(data.order, added);
      await reloadOrder(order.id);
      toast.success(`1 more ${item.product_name}`);
    } catch (error) {
      toast.error(errorText(error, 'Could not add the item'));
    }
  };

  const rush = async (item: OrderItem) => {
    if (!order) return;
    await kitchenTicket(order, [{ ...item, product_name: `!! RUSH !! ${item.product_name}` }], true);
    toast.success(`Rush sent: ${item.product_name}`);
  };

  const saveNote = async (item: OrderItem, note: string) => {
    if (!order) return;
    try {
      await api.patch(`/orders/${order.id}/items/${item.id}/note`, { note });
      const clean = note.trim();
      await kitchenTicket(order, [{ ...item, product_name: `NOTE: ${item.product_name}`, special_instructions: clean || 'note removed' }]);
      setNoteItem(null);
      await reloadOrder(order.id);
    } catch (error) {
      toast.error(errorText(error, 'Could not save the note'));
    }
  };

  const changeTo = async (item: OrderItem, product: Product, note: string, pin: string) => {
    if (!order) return;
    let added: OrderItem[] = [];
    try {
      const { data } = await api.post(`/orders/${order.id}/items`, {
        items: [{ product_id: product.id, quantity: item.quantity, addons: null, special_instructions: note || null }],
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
      const before = new Set((order.items || []).map((i) => Number(i.id)));
      added = ((data.order as Order).items || []).filter((i) => !before.has(Number(i.id)));
    } catch (error) {
      toast.error(errorText(error, 'Could not add the new item'));
      return;
    }
    try {
      await api.patch(`/orders/${order.id}/items/${item.id}/cancel`, {
        reason: 'customer_changed_mind', note: `Changed to ${product.name}`, changing: true, ...(pin && { override_pin: pin }),
      });
    } catch (error) {
      for (const extra of added) {
        await api.patch(`/orders/${order.id}/items/${extra.id}/cancel`, { reason: 'customer_changed_mind', changing: true }).catch(() => undefined);
      }
      toast.error(errorText(error, 'Could not change the item'));
      return;
    }
    await kitchenTicket(order, [
      { ...item, product_name: `CANCEL: ${item.product_name}`, special_instructions: null },
      ...added.map((n) => ({ ...n, product_name: `NEW: ${n.product_name}` })),
    ]);
    toast.success(`${item.product_name} changed to ${product.name}`);
    setChangeItem(null);
    await reloadOrder(order.id);
  };

  const moveItems = async (itemIds: number[], target: Table, allItems: boolean) => {
    if (!order) return;
    try {
      if (allItems && target.status === 'available') {
        await api.post(`/tables/${table.id}/move-order`, { target_table_id: target.id, order_id: order.id });
      } else {
        await api.post(`/orders/${order.id}/move-items`, { item_ids: itemIds, target_table_id: target.id });
      }
      toast.success(`Moved to ${target.name}`);
      setMoveIds(null);
      onTablesChanged?.();
      if (allItems) { onClose(); return; }
      await reloadOrder(order.id);
    } catch (error) {
      toast.error(errorText(error, 'Could not move'));
    }
  };

  const pickAction = (item: OrderItem, action: ItemAction) => {
    setActionItem(null);
    if (action === 'change') setChangeItem(item);
    else if (action === 'note') setNoteItem(item);
    else if (action === 'discount') setDiscountTarget({ kind: 'item', item });
    else if (action === 'free') setCompId(Number(item.id));
    else if (action === 'move') setMoveIds([Number(item.id)]);
    else if (action === 'rush') void rush(item);
    else if (action === 'more') void addOneMore(item);
    else if (action === 'remove') handleRemoveItem(item);
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
  const splitPaidCount = splitBills.filter((bill) => bill.payment_status === 'paid').length;
  const canUndoSplit = splitBills.length > 0 && splitBills.every((bill) => bill.payment_status === 'unpaid' && Number(bill.paid_amount || 0) === 0);

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
          <div className="space-y-2">
            {activeItems.map((item) => {
              const sent = sentAtMs(item);
              return (
                <button key={item.id} type="button" disabled={!canEditOrder} onClick={() => setActionItem(item)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border-2 border-neutral-700 bg-neutral-900 px-4 py-3 text-start hover:border-neutral-500 hover:bg-neutral-800 disabled:hover:border-neutral-700 disabled:hover:bg-neutral-900">
                  <span className="min-w-0 flex-1">
                    <span className="block text-xl font-extrabold text-white">{item.quantity} × {item.product_name}</span>
                    <span className="block text-sm font-semibold text-neutral-400">
                      {sent ? `Sent ${new Date(sent).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                      {item.special_instructions ? ` · ${item.special_instructions}` : ''}
                    </span>
                    {item.comped_at && <span className="mt-0.5 inline-flex items-center gap-1 text-sm font-bold text-sky-300"><Gift size={14} />Free</span>}
                  </span>
                  <span className="text-end">
                    <span className="block text-xl font-extrabold tabular-nums text-white">{formatItemTotal(item.total, item.subtotal)}</span>
                    {Number(item.discount_amount) > 0 && !item.comped_at && <span className="block text-sm font-bold text-green-400">Discount −{fmt(Number(item.discount_amount))}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {canEditOrder && activeItems.length > 0 && <p className="mt-3 text-center text-sm font-semibold text-neutral-400">Tap an item for more options</p>}
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
          {order.bill && splitBills.length === 0 && order.bill.payment_status !== 'paid' && Number(order.bill.balance) > 0 && (
            <div className="flex justify-between text-base font-bold">
              <span className="text-orange-400">{t('balanceDue')}</span>
              <span className="text-orange-400 tabular-nums">{fmt(Number(order.bill.balance))}</span>
            </div>
          )}

          {splitBills.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold uppercase tracking-[0.1em] text-neutral-300">Split bills</p>
                <span className={`rounded-full px-2.5 py-0.5 text-sm font-extrabold ${splitPaidCount === splitBills.length ? 'bg-green-500 text-black' : 'bg-orange-400 text-black'}`}>{splitPaidCount} of {splitBills.length} paid</span>
              </div>
              {splitBills.map((bill, index) => {
                const paid = bill.payment_status === 'paid';
                return (
                  <div key={bill.id} className="flex items-center gap-2 rounded-xl border-2 border-neutral-700 bg-neutral-900 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base font-extrabold">{bill.split_label} <span className="text-sm font-semibold text-neutral-400">· Bill {index + 1} of {splitBills.length}</span></p>
                      <p className="text-sm font-semibold text-neutral-300"><span className="tabular-nums">{fmt(Number(bill.total))}</span> · {paid ? <span className="text-green-400">{t('paid')}</span> : <span className="text-orange-400">{t('unpaid')}</span>}</p>
                    </div>
                    {onPrintBill && (
                      <button type="button" disabled={printingSplitId === bill.id} aria-label={`Print bill for ${bill.split_label}`}
                        onClick={async () => { setPrintingSplitId(bill.id); try { await onPrintBill(order, bill); } finally { setPrintingSplitId(null); } }}
                        className="flex h-12 min-w-12 items-center justify-center gap-1 rounded-xl border-2 border-neutral-600 bg-neutral-950 px-3 font-bold text-white hover:bg-neutral-800 disabled:opacity-40">
                        <Printer size={18} /><span className="hidden sm:inline">Print</span>
                      </button>
                    )}
                    {!paid && <Button className="h-12 bg-green-500 px-5 text-base font-black text-black hover:bg-green-400" onClick={() => onPayment(bill)}>{t('pay')}</Button>}
                  </div>
                );
              })}
              {canUndoSplit && (
                <Button variant="outline" disabled={undoingSplit} onClick={handleUndoSplit}
                  className="h-12 w-full border-2 border-neutral-600 bg-neutral-900 text-base font-bold text-white hover:bg-neutral-800">
                  <Undo2 size={18} className="me-2" />{undoingSplit ? 'Undoing…' : 'Undo split'}
                </Button>
              )}
            </div>
          )}

          {splitBills.length === 0 && order.bill?.payment_status !== 'paid' && (
            <div className="grid grid-cols-2 gap-2">
              {canEditOrder && (
                <Button variant="outline" size="lg" className="h-14 border-2 border-neutral-600 bg-neutral-900 text-lg font-bold text-white hover:bg-neutral-800" onClick={() => setMoveIds(activeItems.map((i) => Number(i.id)))}>
                  <ArrowLeftRight strokeWidth={2.25} className="me-2 size-7" />Move table
                </Button>
              )}
              {canDiscount && canEditOrder && (
                <Button variant="outline" size="lg" className="h-14 border-2 border-neutral-600 bg-neutral-900 text-lg font-bold text-white hover:bg-neutral-800" onClick={() => setDiscountTarget({ kind: 'order' })}>
                  <BadgePercent strokeWidth={2.25} className="me-2 size-7" />{Number(order.discount_amount) > 0 ? 'Change discount' : 'Discount bill'}
                </Button>
              )}
              {cartItemCount === 0 && (
                <Button variant="outline" size="lg" className="h-14 border-2 border-neutral-600 bg-neutral-900 text-lg font-bold text-white hover:bg-neutral-800" onClick={() => onAddItems(table, order)}>
                  <Plus strokeWidth={2.25} className="me-2 size-7" />{t('addItems')}
                </Button>
              )}
              {onPrintBill && (
                <Button variant="outline" size="lg" disabled={printingBill}
                  className="h-14 border-2 border-neutral-600 bg-neutral-900 text-lg font-bold text-white hover:bg-neutral-800"
                  onClick={async () => { setPrintingBill(true); try { await onPrintBill(order); } finally { setPrintingBill(false); } }}>
                  <Printer strokeWidth={2.25} className="me-2 size-7" />{printingBill ? 'Printing…' : 'Print bill'}
                </Button>
              )}
            </div>
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
            <Button size="lg" className="h-16 w-full bg-green-500 text-2xl font-black text-black hover:bg-green-400" onClick={handleCheckout} disabled={generating}>
              {generating ? t('generating') : `${t('checkout')} ${fmt(Number(order.bill?.balance ?? order.total))}`}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
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
    {removingId != null && (
      <VoidCompDialog order={order} itemId={Number(removingId)} action="void" onClose={() => setRemovingId(null)} onDone={refreshAfterRemoval} />
    )}
    {compId != null && (
      <VoidCompDialog order={order} itemId={compId} action="comp" onClose={() => setCompId(null)} onDone={async () => { setCompId(null); await reloadOrder(order.id); }} />
    )}
    {actionItem && (
      <ItemActionsPanel item={actionItem} canDiscount={canDiscount} canRemove={canCancelItems} onClose={() => setActionItem(null)} onPick={(action) => pickAction(actionItem, action)} />
    )}
    {noteItem && <NoteDialog item={noteItem} onClose={() => setNoteItem(null)} onSave={(note) => saveNote(noteItem, note)} />}
    {changeItem && <ChangeItemDialog item={changeItem} onClose={() => setChangeItem(null)} onChange={(product, note, pin) => changeTo(changeItem, product, note, pin)} />}
    {moveIds && (
      <MoveItemsDialog order={order} items={activeItems} currentTableId={table.id} tables={tables} initialIds={moveIds}
        onClose={() => setMoveIds(null)} onMove={(ids, target) => moveItems(ids, target, ids.length === activeItems.length)} />
    )}
    {splitBill && <SplitCheckModal bill={splitBill} order={order} onClose={() => setSplitBill(null)} onSplit={(bills) => { setOrder({ ...order, bill: bills[0], bills }); setSplitBill(null); }} />}
    </>
  );
}
