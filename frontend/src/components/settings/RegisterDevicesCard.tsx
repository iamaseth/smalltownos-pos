'use client';

/**
 * BackStreet: connect the Register iPad (the small screen next to the till). "Add this iPad" makes
 * a private link; open it once on the iPad and it stays connected. Remove a device to cut it off.
 * The iPad can only see open tables, print a bill and add one of the 5 best-sellers.
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Copy, Tablet, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

interface Device { id: string; name: string; created_at: string; last_seen_at: string | null }

function when(ts: string | null): string {
  if (!ts) return 'never';
  const d = new Date(`${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function RegisterDevicesCard() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [name, setName] = useState('Register iPad');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<{ devices: Device[] }>('/register-devices')
    .then(({ data }) => setDevices(data.devices || []))
    .catch(() => setDevices([])), []);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<{ device: Device; token: string }>('/register-devices', { name });
      setLink(`${window.location.origin}/mini.html#t=${data.token}`);
      await load();
    } catch (error) {
      toast.error((error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not add the device');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (device: Device) => {
    if (!window.confirm(`Disconnect "${device.name}"? It stops working straight away.`)) return;
    try {
      await api.delete(`/register-devices/${device.id}`);
      toast.success('Disconnected');
      await load();
    } catch {
      toast.error('Could not remove it');
    }
  };

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); toast.success('Link copied'); } catch { toast.error('Copy did not work. Select the link and copy it.'); }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="register-devices-card">
      <div className="flex items-center gap-2 mb-2">
        <Tablet size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Register iPad</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        A small screen next to the till that shows the tables. Staff can print a table&apos;s bill and add the 5
        best-sellers (the ticket prints at the bar or kitchen). It cannot take payments, give discounts or change anything else.
      </p>
      <ol className="mb-4 list-decimal space-y-1 ps-5 text-sm text-foreground">
        <li>Press <b>Add this iPad</b> and send the link to the iPad (for example by Telegram).</li>
        <li>Open the link on the iPad in Safari. Then tap Share → <b>Add to Home Screen</b>.</li>
        <li>On the till computer with the printer: menu ⋯ → <b>Printer settings</b> → turn on <b>Print for the Register iPad</b>.</li>
      </ol>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
        <Button type="button" size="sm" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add this iPad'}</Button>
      </div>

      {link && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="mb-2 font-semibold">Open this link on the iPad. It is shown only once and works like a key: don&apos;t post it in a group.</p>
          <div className="flex gap-2">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded border border-amber-300 bg-white px-2 py-1 font-mono text-xs" />
            <Button type="button" variant="outline" size="sm" onClick={copy}><Copy size={14} /> Copy</Button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-sm font-medium text-foreground mb-1">Connected devices</div>
        {devices === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : devices.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p>
            : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      <b>{d.name}</b>
                      <span className="block text-xs text-muted-foreground">Added {when(d.created_at)} · last used {when(d.last_seen_at)}</span>
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => remove(d)}><Trash2 size={14} /> Remove</Button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </div>
  );
}
