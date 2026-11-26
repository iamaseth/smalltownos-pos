'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import api, { readRegisterSession, REGISTER_IDLE_TIMEOUT_MS, setRegisterSessionToken, touchRegisterSession, type RegisterOperator as Operator } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export { REGISTER_IDLE_TIMEOUT_MS };

/**
 * Staff PIN access for every staff page except the kitchen display. One PIN unlock lasts
 * across pages and reloads until 5 minutes without activity, then the PIN screen returns.
 */
export function useRegisterAccess(onRegister: boolean) {
  // null = not known yet. The lock only applies once staff PINs exist.
  const [pinLockEnabled, setPinLockEnabled] = useState<boolean | null>(null);
  const enabled = onRegister && pinLockEnabled === true;
  const [locked, setLocked] = useState(true);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [error, setError] = useState('');
  const switching = useRef(false);

  const restoreAppUser = useCallback(async () => {
    setRegisterSessionToken(null);
    setOperator(null);
    setLocked(true);
    try {
      await useAuthStore.getState().refreshAuthContext();
    } catch {
      // The original email/password session remains in localStorage. AuthGuard
      // will handle it normally if that session is no longer valid.
    }
  }, []);

  const lock = useCallback(async () => {
    if (switching.current) return;
    switching.current = true;
    try {
      // This endpoint revokes the current server-side PIN session immediately.
      await api.post('/register-access/lock');
    } catch {
      // The token may already have expired; restoring the owner session still locks this UI.
    } finally {
      await restoreAppUser();
      switching.current = false;
    }
  }, [restoreAppUser]);

  useEffect(() => {
    const saved = readRegisterSession();
    if (!saved?.operator) return;
    queueMicrotask(() => { setOperator(saved.operator); setLocked(false); });
  }, []);

  useEffect(() => {
    if (!onRegister) return;
    let active = true;
    api.get('/register-access/status')
      .then(({ data }) => { if (active) setPinLockEnabled(Boolean(data?.pin_lock_enabled)); })
      .catch(async () => {
        // A saved PIN token may have expired while this tab was closed. Restore
        // the original login and retry status rather than treating 401 as "no PINs".
        try {
          await restoreAppUser();
          const { data } = await api.get('/register-access/status');
          if (active) setPinLockEnabled(Boolean(data?.pin_lock_enabled));
        } catch {
          // Unknown policy is not permission to bypass the register lock.
          if (active) setPinLockEnabled(true);
        }
      });
    return () => { active = false; };
  }, [onRegister, restoreAppUser]);

  useEffect(() => {
    if (!enabled || locked) return;
    let lastActivity = readRegisterSession()?.lastActivity ?? Date.now();
    let lastSaved = 0;
    const activity = () => {
      lastActivity = Date.now();
      if (lastActivity - lastSaved > 5000) { lastSaved = lastActivity; touchRegisterSession(); }
    };
    const check = () => {
      if (Date.now() - lastActivity >= REGISTER_IDLE_TIMEOUT_MS && !switching.current) {
        void lock();
      }
    };
    const heartbeat = window.setInterval(() => {
      if (Date.now() - lastActivity < REGISTER_IDLE_TIMEOUT_MS) {
        void api.post('/register-access/activity').catch(() => {});
      }
    }, 60_000);
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach(e => window.addEventListener(e, activity));
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 1000);
    return () => {
      events.forEach(e => window.removeEventListener(e, activity));
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
      window.clearInterval(heartbeat);
    };
  }, [enabled, locked, lock]);

  useEffect(() => () => {
    // Revoke the PIN token before leaving POS, then restore the original login.
    if (readRegisterSession()?.token) {
      void api.post('/register-access/lock').catch(() => {}).finally(() => {
        setRegisterSessionToken(null);
        void useAuthStore.getState().refreshAuthContext().catch(() => {});
      });
    } else {
      setRegisterSessionToken(null);
      void useAuthStore.getState().refreshAuthContext().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (enabled || !operator || (onRegister && pinLockEnabled === null)) return;
    // Defer the identity restore until after this route-state effect.
    const restore = window.setTimeout(() => { void restoreAppUser(); }, 0);
    return () => window.clearTimeout(restore);
  }, [enabled, operator, onRegister, pinLockEnabled, restoreAppUser]);

  useEffect(() => {
    if (!enabled) return;
    const expired = () => { if (!switching.current) void restoreAppUser(); };
    window.addEventListener('flo:register-session-expired', expired);
    return () => window.removeEventListener('flo:register-session-expired', expired);
  }, [enabled, restoreAppUser]);

  // Leaving the POS always restores the original email/password identity.
  const unlock = useCallback(async (pin: string) => {
    if (!enabled || !/^\d{4}$/.test(pin) || switching.current) return false;
    switching.current = true;
    try {
      const { data } = await api.post('/register-access/unlock', { pin });
      if (!data?.access_token || !data?.operator?.id || !data?.operator?.name) {
        setError('Employee session could not be created');
        return false;
      }
      setRegisterSessionToken(data.access_token, data.operator);
      await useAuthStore.getState().refreshAuthContext();
      const freshTenant = useAuthStore.getState().currentTenant;
      if (!freshTenant?.permission_ids?.includes('pos.use')) {
        await api.post('/register-access/lock').catch(() => {});
        await restoreAppUser();
        setError('This employee does not have permission to use the register');
        return false;
      }
      setOperator(data.operator);
      setLocked(false);
      setError('');
      return true;
    } catch (err) {
      const response = (err as { response?: { status?: number; data?: { error?: string } } })?.response;
      // BackStreet: a wrong PIN is just a wrong PIN. Say so plainly and keep the device signed in.
      if (response?.status === 401 && response.data?.error === 'Invalid PIN') {
        setError('Wrong PIN. Try again.');
        return false;
      }
      if (response?.status === 429) {
        setError('Too many wrong PINs. Wait 15 minutes, or ask a manager.');
        return false;
      }
      // If the PIN endpoint succeeded but auth-context refresh failed, revoke
      // the just-created token before restoring the original account.
      await api.post('/register-access/lock').catch(() => {});
      await restoreAppUser();
      setError(response?.data?.error || 'PIN verification failed or employee session could not be started');
      return false;
    } finally {
      switching.current = false;
    }
  }, [enabled, restoreAppUser]);

  return {
    // Fail closed while the PIN policy is loading; the lock disappears only
    // when the server explicitly reports that no staff PINs are configured.
    locked: onRegister && pinLockEnabled !== false && locked,
    checking: onRegister && pinLockEnabled === null,
    operator, error, unlock, lock,
  };
}
