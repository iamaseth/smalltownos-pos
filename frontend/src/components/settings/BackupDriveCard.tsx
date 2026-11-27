'use client';

/**
 * BackStreet: nightly backups are also sent to the owner's Google Drive by the server.
 * Shows whether it is set up, when the last copy was sent, and a "Send newest backup now" button.
 * The Google login itself is set in Railway variables, never here.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudUpload } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

export interface BackupDriveStatus {
  configured: boolean;
  folderName: string;
  lastSentAt: string | null;
  lastSentFile: string | null;
  lastError: string | null;
  failCount: number;
}

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error || fallback;
}

export function BackupDriveCard() {
  const [status, setStatus] = useState<BackupDriveStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<BackupDriveStatus>('/db-tools/backup-drive')
    .then(({ data }) => setStatus(data))
    .catch(() => setStatus(null)), []);

  useEffect(() => { void load(); }, [load]);

  if (!status) return null;

  const sendNow = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<BackupDriveStatus>('/db-tools/backup-drive/send-now');
      setStatus(data);
      toast.success(`Sent ${data.lastSentFile ?? 'the newest backup'} to Google Drive`);
    } catch (error) {
      toast.error(errorText(error, 'Sending failed'));
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="backup-drive-card">
      <div className="flex items-center gap-2 mb-2">
        <CloudUpload size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Send backups to Google Drive</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Every night&apos;s backup is sent to the folder <b>{status.folderName}</b> in the owner&apos;s Google Drive.
        It keeps the last 30 nights plus one backup per month.
      </p>

      {!status.configured ? (
        <p className="text-sm text-muted-foreground rounded-lg bg-muted px-3 py-2">
          Not set up yet. The Google Drive login is added once in the Railway settings.
        </p>
      ) : (
        <>
          <div className="text-sm">
            {status.lastError ? (
              <p className="flex items-center gap-1 text-red-600">
                <AlertTriangle size={14} /> Last send failed: {status.lastError}
              </p>
            ) : status.lastSentAt ? (
              <p className="flex items-center gap-1 text-green-700">
                <CheckCircle2 size={14} /> Last sent: {new Date(status.lastSentAt).toLocaleString()} ({status.lastSentFile})
              </p>
            ) : (
              <p className="text-muted-foreground">Nothing sent yet. The first one goes tonight, or press Send newest backup now.</p>
            )}
          </div>
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={sendNow}>
              {busy ? 'Sending…' : 'Send newest backup now'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
