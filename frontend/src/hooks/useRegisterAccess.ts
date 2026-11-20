'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import api, { setRegisterSessionToken } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export const REGISTER_IDLE_TIMEOUT_MS = 300000;

type Operator = { id: string; name: string; role: string; permissions: string[] };

export function useRegisterAccess(enabled: boolean) {
  const [locked, setLocked] = useState(enabled);
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
    if (!enabled || locked) return;
    let lastActivity = Date.now();
    const activity = () => { lastActivity = Date.now(); };
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
    if (enabled || !operator) return;
    // Defer the identity restore until after this route-state effect.
    const restore = window.setTimeout(() => { void restoreAppUser(); }, 0);
    return () => window.clearTimeout(restore);
  }, [enabled, operator, restoreAppUser]);

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
      setRegisterSessionToken(data.access_token);
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
