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
      // Older server or no answer: keep the till usable rather than locking everyone out.
      .catch(() => { if (active) setPinLockEnabled(false); });
    return () => { active = false; };
  }, [onRegister]);

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
        void restoreAppUser();
      }
    };
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
    };
  }, [enabled, locked, restoreAppUser]);

  useEffect(() => () => {
    // If the POS page is left while an employee is active, restore the
    // original email/password identity before the rest of the app is used.
    setRegisterSessionToken(null);
    void useAuthStore.getState().refreshAuthContext().catch(() => {});
  }, []);

  useEffect(() => {
    if (enabled || !operator || (onRegister && pinLockEnabled === null)) return;
    // Defer the identity restore until after this route-state effect.
    const restore = window.setTimeout(() => { void restoreAppUser(); }, 0);
    return () => window.clearTimeout(restore);
  }, [enabled, operator, onRegister, pinLockEnabled, restoreAppUser]);

  useEffect(() => {
    if (!enabled) return;
    const expired = () => { void restoreAppUser(); };
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
        await restoreAppUser();
        setError('This employee does not have permission to use the register');
        return false;
      }
      setOperator(data.operator);
      setLocked(false);
      setError('');
      return true;
    } catch {
      await restoreAppUser();
      setError('PIN verification failed or employee session could not be started');
      return false;
    } finally {
      switching.current = false;
    }
  }, [enabled, restoreAppUser]);

  const lock = useCallback(() => {
    if (!switching.current) void restoreAppUser();
  }, [restoreAppUser]);

  return { locked: enabled && locked, operator, error, unlock, lock };
}
