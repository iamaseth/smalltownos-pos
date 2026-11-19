'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';

interface Recipient { id: number; display_name: string; reports: string[]; is_active: number }
type Kind = 'daily' | 'weekly' | 'period';

function kindFor(startDate: string, endDate: string): Kind {
  if (startDate === endDate) return 'daily';
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return start.getUTCDay() === 1 && end.toISOString().slice(0, 10) === endDate ? 'weekly' : 'period';
}

const formatDay = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export default function TelegramSendButton({ startDate, endDate }: { startDate: string; endDate: string }) {
  const t = useTranslations('telegram');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(true);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [alignStart, setAlignStart] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const kind = kindFor(startDate, endDate);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggleOpen = async () => {
    if (open) { setOpen(false); return; }
    const rect = box.current?.getBoundingClientRect();
    setAlignStart(Boolean(rect && rect.left < window.innerWidth / 2));
    setOpen(true);
    setLoading(true);
    try {
      const { data } = await api.get('/telegram/status');
      const active = (data.recipients as Recipient[]).filter((r) => r.is_active);
      const wanted = kind === 'daily' ? 'daily' : 'weekly';
      setConnected(Boolean(data.status?.enabled));
      setRecipients(active);
      setChosen(new Set(active.filter((r) => r.reports.includes(wanted)).map((r) => r.id)));
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  };

  const send = async () => {
    if (!chosen.size) { toast.error(t('chooseRecipient')); return; }
    setSending(true);
    try {
      const { data } = await api.post('/telegram/send-now', { start_date: startDate, end_date: endDate, recipient_ids: [...chosen] });
      if (data.failed) toast.error(t('sendFailed'));
      else toast.success(data.pending ? t('sendQueued') : t('sendDone', { count: data.sent }));
      setOpen(false);
    } catch (error) {
      toast.error((error as { response?: { data?: { error?: string } } })?.response?.data?.error || t('actionFailed'));
    } finally {
      setSending(false);
    }
  };

  const heading = kind === 'daily'
    ? t('sendDaily', { date: formatDay(startDate) })
    : kind === 'weekly'
      ? t('sendWeekly', { start: formatDay(startDate), end: formatDay(endDate) })
      : t('sendPeriod', { start: formatDay(startDate), end: formatDay(endDate) });

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={toggleOpen} aria-expanded={open}
        className="inline-flex h-10 items-center gap-2 rounded-xl border-2 border-border bg-card px-4 text-sm font-semibold text-foreground hover:bg-muted">
        <Send size={15} />{t('sendToTelegram')}
      </button>
      {open && (
        <div className={`absolute ${alignStart ? 'start-0' : 'end-0'} top-12 z-30 w-80 rounded-xl border-2 border-border bg-card p-4 text-sm shadow-lg`}>
          {loading ? (
            <p className="text-muted-foreground">…</p>
          ) : !connected ? (
            <p>{t('notConnectedHint')} <Link href="/settings?tab=telegram" className="text-brand underline">{t('title')}</Link></p>
          ) : (
            <>
              <p className="font-semibold">{heading}</p>
              <p className="mb-3 text-xs text-muted-foreground">{t('sendAttachmentsNote')}</p>
              {recipients.length === 0 ? (
                <p className="text-muted-foreground">{t('noRecipients')}</p>
              ) : (
                <>
                  <p className="mb-1 text-xs text-muted-foreground">{t('sendTo')}</p>
                  {recipients.map((r) => (
                    <label key={r.id} className="flex cursor-pointer items-center gap-2 py-1">
                      <input type="checkbox" className="size-4 accent-primary" checked={chosen.has(r.id)}
                        onChange={() => setChosen((prev) => { const next = new Set(prev); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); return next; })} />
                      {r.display_name}
                    </label>
                  ))}
                </>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-lg border-2 border-border px-3 font-semibold hover:bg-muted">{t('cancel')}</button>
                <button type="button" onClick={send} disabled={sending || recipients.length === 0}
                  className="h-9 rounded-lg bg-foreground px-4 font-semibold text-background disabled:opacity-50">{sending ? '…' : t('send')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
