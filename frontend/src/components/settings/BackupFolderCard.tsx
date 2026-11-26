'use client';

/**
 * BackStreet: "Also save backups to this folder". Each nightly backup is copied into a folder
 * on the POS computer, e.g. a Google Drive for desktop folder, so a copy leaves the building.
 * Saving the folder needs the Master PIN (handled by the settings page).
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FolderSync, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

export interface BackupFolderStatus {
  available: boolean;
  folder: string;
  lastCopyAt: string | null;
  lastCopyFile: string | null;
  lastError: string | null;
  failCount: number;
}

interface Props {
  /** Opens the Master PIN prompt; the page saves the folder once the PIN is right. */
  onSave: (folder: string) => void;
  /** Bumped by the page after a save so the card reloads its status. */
  version?: number;
}

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error || fallback;
}

export function BackupFolderCard({ onSave, version = 0 }: Props) {
  const [status, setStatus] = useState<BackupFolderStatus | null>(null);
  const [folder, setFolder] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [busy, setBusy] = useState<'' | 'test' | 'copy'>('');

  const load = useCallback(() => api.get<BackupFolderStatus>('/db-tools/backup-folder')
    .then(({ data }) => { setStatus(data); setFolder(data.folder || ''); setTestResult(null); })
    .catch(() => setStatus(null)), []);

  useEffect(() => { void load(); }, [load, version]);

  if (!status) return null;

  const changed = folder.trim() !== (status.folder || '');

  const test = async () => {
    setBusy('test');
    try {
      const { data } = await api.post<{ ok: boolean; error: string | null }>('/db-tools/backup-folder/test', { folder });
      setTestResult(data);
    } catch (error) {
      setTestResult({ ok: false, error: errorText(error, 'Test failed') });
    } finally {
      setBusy('');
    }
  };

  const copyNow = async () => {
    setBusy('copy');
    try {
      const { data } = await api.post<BackupFolderStatus>('/db-tools/backup-folder/copy-now');
      setStatus(data);
      toast.success(`Copied ${data.lastCopyFile ?? 'the newest backup'} to the folder`);
    } catch (error) {
      toast.error(errorText(error, 'Copy failed'));
      void load();
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-2 mb-2">
        <FolderSync size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Also save backups to this folder</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Every night&apos;s backup is also copied here. Use a Google Drive for desktop folder so a copy leaves the
        building. The folder keeps the last 30 nights plus one backup per month.
      </p>

      {!status.available ? (
        <p className="text-sm text-muted-foreground rounded-lg bg-muted px-3 py-2">
          Available when the POS runs on a computer in the restaurant. On the cloud server, use Download in Backup History.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium text-foreground mb-1" htmlFor="backup-folder">Folder location</label>
          <input
            id="backup-folder"
            value={folder}
            onChange={(e) => { setFolder(e.target.value); setTestResult(null); }}
            placeholder="C:\Users\Bobo\Google Drive\BackStreet POS backups"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
            spellCheck={false}
          />
          {testResult && (
            <p className={`mt-2 text-sm flex items-center gap-1 ${testResult.ok ? 'text-green-700' : 'text-red-600'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {testResult.ok ? 'Works: the POS can save backups here.' : testResult.error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!folder.trim() || busy !== ''} onClick={test}>
              {busy === 'test' ? 'Testing…' : 'Test folder'}
            </Button>
            <Button type="button" size="sm" disabled={!changed || busy !== '' || (!!folder.trim() && !testResult?.ok)} onClick={() => onSave(folder.trim())}>
              {folder.trim() ? 'Save (Master PIN)' : 'Turn off (Master PIN)'}
            </Button>
            {status.folder && !changed && (
              <Button type="button" variant="outline" size="sm" disabled={busy !== ''} onClick={copyNow}>
                {busy === 'copy' ? 'Copying…' : 'Copy newest backup now'}
              </Button>
            )}
          </div>
          {folder.trim() && changed && !testResult?.ok && (
            <p className="mt-2 text-xs text-muted-foreground">Press Test folder first; Save unlocks when the test works.</p>
          )}

          {status.folder && (
            <div className="mt-4 text-sm">
              {status.lastError ? (
                <p className="flex items-center gap-1 text-red-600">
                  <AlertTriangle size={14} /> Last copy failed: {status.lastError}
                </p>
              ) : status.lastCopyAt ? (
                <p className="flex items-center gap-1 text-green-700">
                  <CheckCircle2 size={14} /> Last copy: {new Date(status.lastCopyAt).toLocaleString()} ({status.lastCopyFile})
                </p>
              ) : (
                <p className="text-muted-foreground">No copy yet. The first one is made tonight, or press Copy newest backup now.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
