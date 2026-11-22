'use client';

import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Props = {
  error?: string;
  busy?: boolean;
  onUnlock: (pin: string) => Promise<boolean>;
  /** Leave the locked till by signing this browser out (e.g. a manager without a PIN). */
  onSignOut?: () => void;
};

/** Full-screen lock overlay. Mount only after server PIN auth is available. */
export default function RegisterLockScreen({ error, busy = false, onUnlock, onSignOut }: Props) {
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const waiting = busy || pending;
  const submit = async () => {
    if (pin.length !== 4 || waiting) return;
    setPending(true);
    try { await onUnlock(pin); }
    finally { setPin(''); setPending(false); }
  };
  const addDigit = (digit: string) => {
    if (!waiting) setPin(current => (current + digit).slice(0, 4));
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="Register locked"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-xl space-y-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <LockKeyhole className="h-9 w-9" aria-hidden="true" />
          <h1 className="text-xl font-semibold">Register access</h1>
          <p className="text-sm text-muted-foreground">Register locked. Enter your four-digit staff PIN.</p>
        </div>
        <form onSubmit={e => { e.preventDefault(); void submit(); }} className="space-y-4">
          <input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4}
            autoComplete="off" aria-label="Four-digit staff PIN" value={pin}
            onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className="w-full rounded-lg border bg-background p-3 text-center text-2xl tracking-[0.5em]"
            disabled={waiting} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="grid grid-cols-3 gap-2">
            {['1','2','3','4','5','6','7','8','9','Clear','0','⌫'].map(key => (
              <Button type="button" variant="outline" key={key} disabled={waiting}
                className="h-12 text-lg" onClick={() => {
                  if (key === 'Clear') setPin('');
                  else if (key === '⌫') setPin(value => value.slice(0, -1));
                  else addDigit(key);
                }}>{key}</Button>
            ))}
          </div>
          <Button type="submit" className="w-full" disabled={waiting || pin.length !== 4}>
            {waiting ? 'Checking…' : 'Unlock register'}
          </Button>
          {onSignOut && !confirmSignOut && (
            <Button type="button" variant="ghost" className="w-full" disabled={waiting} onClick={() => setConfirmSignOut(true)}>
              Sign out of this register
            </Button>
          )}
          {onSignOut && confirmSignOut && (
            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p>This signs out the manager. The till then needs the manager&apos;s email and password again. Staff only need their PIN.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" onClick={() => setConfirmSignOut(false)}>Cancel</Button>
                <Button type="button" variant="destructive" onClick={onSignOut}>Sign out manager</Button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
