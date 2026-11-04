'use client';

import { useEffect, useState } from 'react';

export default function TrainingModePanel() {
  const [demo, setDemo] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getTrainingStatus) return;
    void api.getTrainingStatus().then((result) => setDemo(result.demo)).catch(() => setError('Unable to read training status.'));
  }, []);
  if (demo === null && !error) return null;
  return (
    <section className="mb-6 rounded-xl border border-border bg-card p-5" aria-label="Training and Demo Mode">
      <h2 className="text-lg font-semibold">Training & Demo Mode</h2>
      <p className="mt-1 text-sm text-muted-foreground">Practice with a separate training database. Changes made in Demo Mode should never be used for real sales.</p>
      <p className="mt-3 text-sm font-semibold">{demo === null ? 'Status unavailable' : demo ? 'DEMO MODE ACTIVE' : 'LIVE MODE ACTIVE'}</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <button type="button" disabled={busy || demo === null}
        className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        onClick={async () => {
          const api = window.electronAPI;
          if (!api?.switchTrainingMode || demo === null) return;
          setBusy(true);
          setError('');
          try {
            const result = await api.switchTrainingMode(!demo);
            if (result.error) setError(result.error);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to switch training mode.');
          } finally { setBusy(false); }
        }}>
        {busy ? 'Switching…' : demo ? 'Return to Live Mode…' : 'Enter Demo Mode…'}
      </button>
      <p className="mt-2 text-xs text-muted-foreground">Switching requires confirmation and restarts the app. Do not use printers or payment devices for training until demo isolation is verified.</p>
    </section>
  );
}
