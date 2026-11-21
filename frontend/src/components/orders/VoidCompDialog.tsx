'use client';

import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Send, X } from 'lucide-react';
import api from '@/lib/api';
import type { Order, OrderItem } from '@/lib/types';

type Action = 'void' | 'comp';
interface Config {
  removalRequiresApproval: boolean;
  entertainerAllowance: number;
  entertainerUsedToday: number;
  telegramApprovers: { void: number; comp: number };
}

const REASONS: Record<Action, [string, string][]> = {
  comp: [['entertainer', '🎤 Entertainer / band drink'], ['complaint', 'Customer complaint'], ['wrong_item', 'Wrong item'], ['staff_meal', 'Staff meal'], ['friends_owner', 'Friends / owner'], ['too_slow', 'Took too long'], ['other', 'Other']],
  void: [['wrong_item', 'Wrong item'], ['customer_changed_mind', 'Customer changed mind'], ['customer_left', 'Customer left'], ['duplicate', 'Rung in twice'], ['too_slow', 'Took too long'], ['other', 'Other']],
};
const REMOVED = ['cancelled', 'voided', 'void_adjustment', 'refunded'];

function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

/** Void (take off the bill) or comp (made, given free) one item, with a reason and manager approval. */
export function VoidCompDialog({ order, itemId, action: initialAction, onClose, onDone }: {
  order: Order; itemId?: number | null; action?: Action; onClose: () => void; onDone: () => void;
}) {
  const items = (order.items || []).filter((i) => !REMOVED.includes(i.status) && Number(i.unit_price) >= 0);
  const [action, setAction] = useState<Action>(initialAction ?? 'void');
  const [selectedId, setSelectedId] = useState<number | null>(itemId ?? (items.length === 1 ? items[0].id : null));
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [waiting, setWaiting] = useState<{ id: number; sentTo: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const item: OrderItem | undefined = items.find((i) => i.id === selectedId);
  const choices = items.filter((i) => action === 'void' || !i.comped_at);

  useEffect(() => {
    api.get('/item-approvals/config').then(({ data }) => setConfig(data)).catch(() => setConfig({ removalRequiresApproval: true, entertainerAllowance: 0, entertainerUsedToday: 0, telegramApprovers: { void: 0, comp: 0 } }));
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const execute = async (approval: { override_pin?: string; approval_request_id?: number }) => {
    if (!item) return;
    setBusy(true);
    try {
      const path = action === 'comp' ? `/orders/${order.id}/items/${item.id}/comp` : `/orders/${order.id}/items/${item.id}/cancel`;
      await api.patch(path, { reason, note: note.trim() || undefined, ...approval });
      toast.success(action === 'comp' ? `${item.product_name} comped` : `${item.product_name} taken off the bill`);
      onDone();
    } catch (error) {
      toast.error(errorText(error, action === 'comp' ? 'Could not comp the item' : 'Could not remove the item'));
    } finally {
      setBusy(false);
    }
  };

  const askTelegram = async () => {
    if (!item) return;
    setBusy(true);
    try {
      const { data } = await api.post('/item-approvals', { order_id: order.id, item_id: item.id, action, reason, note: note.trim() || undefined });
      setWaiting({ id: data.id, sentTo: data.sentTo });
      pollRef.current = setInterval(async () => {
        try {
          const { data: st } = await api.get(`/item-approvals/${data.id}`);
          if (st.status === 'approved') {
            if (pollRef.current) clearInterval(pollRef.current);
            toast.success(`Approved by ${st.decidedBy}`);
            await execute({ approval_request_id: data.id });
          } else if (['rejected', 'expired', 'cancelled'].includes(st.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            setWaiting(null);
            toast.error(st.status === 'rejected' ? `Rejected by ${st.decidedBy}` : `Request ${st.status}`);
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (error) {
      toast.error(errorText(error, 'Could not send to Telegram'));
    } finally {
      setBusy(false);
    }
  };

  const cancelWaiting = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (waiting) await api.delete(`/item-approvals/${waiting.id}`).catch(() => undefined);
    setWaiting(null);
  };

  const strict = config?.removalRequiresApproval ?? true;
  const needsApproval = action === 'comp' || strict;
  const allowanceLeft = config ? config.entertainerAllowance - config.entertainerUsedToday : 0;
  const withinAllowance = action === 'comp' && reason === 'entertainer' && config != null && config.entertainerAllowance > 0 && allowanceLeft >= Number(item?.quantity ?? 1);
  const ready = !!item && !!reason;
  const notMade = item?.status === 'pending';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => !waiting && onClose()}>
      <div role="dialog" aria-label={action === 'comp' ? 'Comp an item' : 'Void an item'} onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl bg-background p-5 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold">{item ? `${item.quantity} × ${item.product_name} · $${Number(item.total).toFixed(2)}` : 'Which item?'}</h2>
            <p className="text-sm text-muted-foreground">{order.tab_name || order.table?.name || (order.type === 'takeaway' ? 'To Go' : 'Walk-in')} · {order.order_number}</p>
          </div>
          <button type="button" aria-label="Close" onClick={() => (waiting ? cancelWaiting().then(onClose) : onClose())} className="rounded-md p-1 hover:bg-muted"><X className="size-5" /></button>
        </div>

        {!itemId && (
          <div className="mt-3 space-y-1">
            {choices.map((i) => (
              <button key={i.id} type="button" onClick={() => setSelectedId(i.id)} aria-pressed={selectedId === i.id}
                className={`flex w-full justify-between rounded-lg border px-3 py-2 text-sm ${selectedId === i.id ? 'border-blue-600 bg-blue-50 dark:bg-blue-950' : 'border-border hover:bg-muted'}`}>
                <span>{i.quantity} × {i.product_name}{i.comped_at ? ' (comped)' : ''}</span><span className="font-semibold">${Number(i.total).toFixed(2)}</span>
              </button>
            ))}
            {choices.length === 0 && <p className="text-sm text-muted-foreground">No items can be changed on this order.</p>}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2">
          {(['void', 'comp'] as const).map((a) => (
            <button key={a} type="button" disabled={!!waiting} onClick={() => { setAction(a); setReason(''); }} aria-pressed={action === a}
              className={`rounded-xl border-2 p-3 text-start ${action === a ? 'border-blue-600 bg-blue-50 dark:bg-blue-950' : 'border-border'}`}>
              <b className="block">{a === 'void' ? 'Void' : '🎁 Comp'}</b>
              <small className="text-muted-foreground">{a === 'void' ? (notMade ? 'Take it off the bill (not made yet)' : 'Take it off the bill') : 'Made — given away free'}</small>
            </button>
          ))}
        </div>

        <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</h3>
        <div className="flex flex-wrap gap-2">
          {REASONS[action].map(([key, label]) => (
            <button key={key} type="button" disabled={!!waiting} onClick={() => setReason(key)} aria-pressed={reason === key}
              className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${reason === key ? 'border-foreground bg-foreground text-background' : 'border-border hover:bg-muted'}`}>
              {label}
            </button>
          ))}
        </div>
        <input value={note} onChange={(e) => setNote(e.target.value)} disabled={!!waiting} placeholder="Note (optional)" maxLength={200}
          className="mt-3 w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-sm" />

        {waiting ? (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            ⏳ Sent to {waiting.sentTo} manager{waiting.sentTo === 1 ? '' : 's'} on Telegram. Waiting for approval… The item stays on the bill until someone approves.
            <button type="button" onClick={cancelWaiting} className="mt-2 block font-semibold underline">Cancel request</button>
          </div>
        ) : withinAllowance ? (
          <button type="button" disabled={!ready || busy} onClick={() => execute({})}
            className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-3 font-bold text-white disabled:opacity-50">
            Give free drink ({allowanceLeft} of {config!.entertainerAllowance} left tonight)
          </button>
        ) : needsApproval ? (
          <>
            <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manager approval</h3>
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="Manager PIN" aria-label="Manager PIN"
              className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-center text-lg tracking-widest" />
            <button type="button" disabled={!ready || !pin || busy} onClick={() => execute({ override_pin: pin })}
              className="mt-2 w-full rounded-xl border-2 border-border px-4 py-3 font-bold hover:bg-muted disabled:opacity-50">
              Approve with manager PIN
            </button>
            {(config?.telegramApprovers[action] ?? 0) > 0 && (
              <>
                <p className="my-2 text-center text-xs text-muted-foreground">— or —</p>
                <button type="button" disabled={!ready || busy} onClick={askTelegram}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#229ED9] px-4 py-3 font-bold text-white disabled:opacity-50">
                  <Send className="size-4" /> Ask manager on Telegram
                </button>
              </>
            )}
          </>
        ) : (
          <button type="button" disabled={!ready || busy} onClick={() => execute({})}
            className="mt-4 w-full rounded-xl bg-red-600 px-4 py-3 font-bold text-white disabled:opacity-50">
            Take it off the bill
          </button>
        )}
      </div>
    </div>
  );
}
