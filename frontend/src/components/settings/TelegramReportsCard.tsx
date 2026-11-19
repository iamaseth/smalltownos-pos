'use client';

import { useCallback, useEffect, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/hooks/use-confirm';
import api from '@/lib/api';
import { parseDbTimestamp } from '@/lib/utils';

const REPORTS = ['daily', 'shift', 'weekly', 'low_stock', 'purchasing'] as const;
type ReportType = typeof REPORTS[number];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface Schedule { weeklyDay: number; weeklyTime: string; dailyFallbackTime: string; pdf: boolean; csv: boolean }
interface Status { tokenConfigured: boolean; enabled: boolean; connected: boolean; botUsername: string | null; error: string | null; schedule: Schedule }
interface Recipient { id: number; display_name: string; username: string | null; reports: ReportType[]; is_active: number }
interface Delivery { id: number; report_type: string; title: string; status: 'pending' | 'sent' | 'failed'; attempts: number; last_error: string | null; created_at: string; recipient: string }
interface LinkCode { code: string; expiresAt: string; botUsername: string | null }

function errorMessage(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

export function TelegramReportsCard() {
  const t = useTranslations('telegram');
  const { confirm, ConfirmDialog } = useConfirm();
  const [status, setStatus] = useState<Status | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => api.get('/telegram/status').then(({ data }) => {
    setStatus(data.status);
    setRecipients(data.recipients);
    setDeliveries(data.deliveries);
    setLoadFailed(false);
  }, () => setLoadFailed(true)), []);

  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error, t('actionFailed')));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const connect = () => run(async () => { await api.post('/telegram/connect'); }, t('connected'));
  const disconnect = async () => {
    if (!await confirm(t('disconnectConfirm'), { confirmLabel: t('disconnect') })) return;
    await run(async () => { await api.post('/telegram/disconnect'); });
  };
  const sendTest = () => run(async () => { await api.post('/telegram/test', {}); }, t('testSent'));
  const newCode = () => run(async () => { const { data } = await api.post('/telegram/link-code'); setLinkCode(data); });
  const toggleReport = (recipient: Recipient, report: ReportType) => {
    const reports = recipient.reports.includes(report) ? recipient.reports.filter((r) => r !== report) : [...recipient.reports, report];
    setRecipients((list) => list.map((r) => (r.id === recipient.id ? { ...r, reports } : r)));
    void run(async () => { await api.put(`/telegram/recipients/${recipient.id}`, { reports }); });
  };
  const toggleActive = (recipient: Recipient) => run(async () => { await api.put(`/telegram/recipients/${recipient.id}`, { is_active: !recipient.is_active }); });
  const removeRecipient = async (recipient: Recipient) => {
    if (!await confirm(t('removeConfirm', { name: recipient.display_name }), { confirmLabel: t('remove') })) return;
    await run(async () => { await api.delete(`/telegram/recipients/${recipient.id}`); });
  };
  const saveSchedule = (patch: Partial<Schedule>) => {
    setStatus((s) => (s ? { ...s, schedule: { ...s.schedule, ...patch } } : s));
    void run(async () => { await api.put('/telegram/schedule', patch); });
  };

  if (loadFailed) return <Card><CardContent className="py-6 text-sm text-muted-foreground">{t('loadFailed')}</CardContent></Card>;
  if (!status) return null;

  const schedule = status.schedule;
  const badge = status.connected
    ? { label: t('statusConnected'), cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' }
    : status.enabled
      ? { label: t('statusError'), cls: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' }
      : { label: t('statusOff'), cls: 'bg-muted text-muted-foreground' };
  const botLink = linkCode?.botUsername ? `https://t.me/${linkCode.botUsername}?start=${linkCode.code}` : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Send size={20} className="text-brand" />
              <div>
                <h2 className="font-semibold text-foreground">{t('title')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('description')}</p>
              </div>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badge.cls}`}>{badge.label}</span>
          </div>
          {status.botUsername && <p className="text-sm">{t('bot')}: <span className="font-medium">@{status.botUsername}</span></p>}
          {!status.tokenConfigured && <p className="rounded-md border bg-muted/40 p-3 text-sm">{t('tokenMissing')}</p>}
          {status.error && <p className="text-sm text-destructive">{status.error}</p>}
          <div className="flex flex-wrap gap-2">
            {status.enabled ? (
              <>
                <Button size="sm" onClick={sendTest} disabled={busy || !recipients.some((r) => r.is_active)}>{t('sendTest')}</Button>
                <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>{t('disconnect')}</Button>
              </>
            ) : (
              <Button size="sm" onClick={connect} disabled={busy || !status.tokenConfigured}>{t('connect')}</Button>
            )}
          </div>
        </CardContent>
      </Card>

      {status.enabled && (
        <>
          <Card>
            <CardContent className="space-y-4 py-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{t('recipients')}</h3>
                <Button size="sm" variant="outline" onClick={newCode} disabled={busy}>{t('addRecipient')}</Button>
              </div>
              {linkCode && (
                <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-2">
                  <p>{t('linkStep', { bot: linkCode.botUsername ? `@${linkCode.botUsername}` : t('theBot') })}</p>
                  <p className="font-mono text-2xl tracking-widest">/start {linkCode.code}</p>
                  {botLink && <a className="text-brand underline" href={botLink} target="_blank" rel="noreferrer">{t('openInTelegram')}</a>}
                  <p className="text-xs text-muted-foreground">{t('linkExpiry')}</p>
                </div>
              )}
              {recipients.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noRecipients')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="py-2 pe-3 font-medium">{t('name')}</th>
                        {REPORTS.map((r) => <th key={r} className="py-2 px-2 font-medium text-center">{t(`report_${r}` as `report_${ReportType}`)}</th>)}
                        <th className="py-2 px-2 font-medium text-center">{t('active')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {recipients.map((r) => (
                        <tr key={r.id} className="border-t border-border">
                          <td className="py-2 pe-3">
                            <div className="font-medium">{r.display_name}</div>
                            {r.username && <div className="text-xs text-muted-foreground">@{r.username}</div>}
                          </td>
                          {REPORTS.map((report) => (
                            <td key={report} className="py-2 px-2 text-center">
                              <input type="checkbox" className="size-4 accent-primary" checked={r.reports.includes(report)} onChange={() => toggleReport(r, report)} disabled={busy} aria-label={`${r.display_name} ${t(`report_${report}` as `report_${ReportType}`)}`} />
                            </td>
                          ))}
                          <td className="py-2 px-2 text-center">
                            <input type="checkbox" className="size-4 accent-primary" checked={Boolean(r.is_active)} onChange={() => toggleActive(r)} disabled={busy} aria-label={`${r.display_name} ${t('active')}`} />
                          </td>
                          <td className="py-2 ps-2 text-end">
                            <button type="button" onClick={() => removeRecipient(r)} className="text-muted-foreground hover:text-destructive" aria-label={t('remove')}><Trash2 size={16} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-4 py-6">
              <h3 className="font-semibold">{t('schedule')}</h3>
              <p className="text-sm text-muted-foreground">{t('dailyNote')}</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="text-sm space-y-1">
                  <span className="block text-muted-foreground">{t('dailyBackup')}</span>
                  <input type="time" className="h-9 w-full rounded-md border border-input bg-background px-2" value={schedule.dailyFallbackTime} onChange={(e) => e.target.value && saveSchedule({ dailyFallbackTime: e.target.value })} />
                </label>
                <label className="text-sm space-y-1">
                  <span className="block text-muted-foreground">{t('weeklyDay')}</span>
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2" value={schedule.weeklyDay} onChange={(e) => saveSchedule({ weeklyDay: Number(e.target.value) })}>
                    {DAYS.map((d, i) => <option key={d} value={i}>{t(`day_${d}` as `day_${typeof d}`)}</option>)}
                  </select>
                </label>
                <label className="text-sm space-y-1">
                  <span className="block text-muted-foreground">{t('weeklyTime')}</span>
                  <input type="time" className="h-9 w-full rounded-md border border-input bg-background px-2" value={schedule.weeklyTime} onChange={(e) => e.target.value && saveSchedule({ weeklyTime: e.target.value })} />
                </label>
              </div>
              <div className="flex flex-wrap gap-6 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={schedule.pdf} onChange={(e) => saveSchedule({ pdf: e.target.checked })} />{t('attachPdf')}</label>
                <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={schedule.csv} onChange={(e) => saveSchedule({ csv: e.target.checked })} />{t('attachCsv')}</label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-6">
              <h3 className="font-semibold">{t('recentDeliveries')}</h3>
              {deliveries.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noDeliveries')}</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {deliveries.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <div className="font-medium">{d.title}</div>
                        <div className="text-xs text-muted-foreground">{d.recipient} · {parseDbTimestamp(d.created_at).toLocaleString()}</div>
                        {d.last_error && d.status !== 'sent' && <div className="text-xs text-destructive break-words">{d.last_error}</div>}
                      </div>
                      <span className={`text-xs font-semibold ${d.status === 'sent' ? 'text-emerald-600' : d.status === 'failed' ? 'text-destructive' : 'text-amber-600'}`}>
                        {t(`delivery_${d.status}` as `delivery_${Delivery['status']}`)}{d.attempts > 1 ? ` · ${t('attempts', { count: d.attempts })}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {ConfirmDialog}
    </div>
  );
}
