'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';

interface Recipient { id: number; display_name: string; username: string | null; is_active: number; approver_user_id: string | null }
interface Staff { id: string; name: string; role: string; is_active?: number | boolean }

function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

/** Who must approve voids/comps, the band's free drinks per night, and which Telegram chats can approve. */
export function VoidCompSettingsCard() {
  const [strict, setStrict] = useState(false);
  const [allowance, setAllowance] = useState(0);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [managers, setManagers] = useState<Staff[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => Promise.all([api.get('/settings/item-control'), api.get('/telegram/status'), api.get('/staff')])
    .then(([control, tg, staff]) => {
      setStrict(control.data.item_removal_requires_approval);
      setAllowance(control.data.entertainer_comp_allowance);
      setRecipients(tg.data.recipients || []);
      const list: Staff[] = Array.isArray(staff.data) ? staff.data : (staff.data.users || staff.data.staff || []);
      setManagers(list.filter((u) => ['owner', 'manager'].includes(u.role) && u.is_active !== 0 && u.is_active !== false));
    })
    .catch((error) => toast.error(errorText(error, 'Could not load void & comp settings'))), []);

  useEffect(() => { void load(); }, [load]);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const { data } = await api.put('/settings/item-control', body);
      setStrict(data.item_removal_requires_approval);
      setAllowance(data.entertainer_comp_allowance);
      toast.success('Saved');
    } catch (error) {
      toast.error(errorText(error, 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  const setApprover = async (recipient: Recipient, userId: string) => {
    setBusy(true);
    try {
      await api.put(`/telegram/recipients/${recipient.id}`, { approver_user_id: userId || null });
      setRecipients((list) => list.map((r) => (r.id === recipient.id ? { ...r, approver_user_id: userId || null } : r)));
      toast.success(userId ? 'Can now approve from Telegram' : 'No longer approves');
    } catch (error) {
      toast.error(errorText(error, 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        <div>
          <h3 className="font-semibold">Voids &amp; comps</h3>
          <p className="text-sm text-muted-foreground">Every void, comp and removed item is listed on the X, Z and daily reports with who asked and who approved.</p>
        </div>

        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 size-4 accent-primary" checked={strict} disabled={busy} onChange={(e) => save({ item_removal_requires_approval: e.target.checked })} />
          <span>
            <span className="font-medium">Manager approval to remove anything already sent to the kitchen or bar</span>
            <span className="block text-sm text-muted-foreground">A manager PIN at the till or Approve on Telegram, plus a reason, whoever is signed in. Items not yet sent can still be removed freely. Comps always need approval.</span>
          </span>
        </label>

        <label className="flex flex-wrap items-center gap-3">
          <span className="font-medium">Free entertainer / band drinks per night without approval</span>
          <input type="number" min={0} max={50} value={allowance} disabled={busy} onChange={(e) => setAllowance(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
            onBlur={() => save({ entertainer_comp_allowance: allowance })}
            className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-center" aria-label="Entertainer drinks per night" />
          <span className="text-sm text-muted-foreground">0 = every entertainer drink needs a manager</span>
        </label>

        <div>
          <h4 className="mb-2 text-sm font-semibold">Approve on Telegram</h4>
          {recipients.length === 0 ? (
            <p className="text-sm text-muted-foreground">Link a manager&apos;s Telegram above first, then choose who they are here.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-2 font-medium">Telegram</th><th className="py-2 font-medium">Approves as</th></tr></thead>
              <tbody>
                {recipients.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-2">{r.display_name}{r.username ? <span className="ms-1 text-xs text-muted-foreground">@{r.username}</span> : null}{!r.is_active ? <span className="ms-1 text-xs text-muted-foreground">(off)</span> : null}</td>
                    <td className="py-2">
                      <select value={r.approver_user_id ?? ''} disabled={busy} onChange={(e) => setApprover(r, e.target.value)}
                        className="rounded-lg border border-border bg-background px-2 py-1" aria-label={`${r.display_name} approves as`}>
                        <option value="">Does not approve</option>
                        {managers.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
