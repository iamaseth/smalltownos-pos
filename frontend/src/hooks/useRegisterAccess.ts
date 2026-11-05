'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/api';

export const REGISTER_IDLE_TIMEOUT_MS = 300000;

export function useRegisterAccess(enabled: boolean) {
  const [locked, setLocked] = useState(true);
  const [operator, setOperator] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  // An operator session is intentionally not persisted across reloads.
  // A verified PIN must be entered again after a restart.
  useEffect(() => {
    if (!enabled || locked) return;
    let lastActivity = Date.now();
    const activity = () => { lastActivity = Date.now(); };
    const check = () => {
      if (Date.now() - lastActivity >= REGISTER_IDLE_TIMEOUT_MS) {
        setLocked(true);
        setOperator(null);
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
  }, [enabled, locked]);
  async function unlock(pin: string) {
    if (!enabled || !/^\d{4}$/.test(pin)) return false;
    try {
      const { data } = await api.post('/register-access/unlock', { pin });
      if (!data?.operator?.id || !data?.operator?.name) return false;
      setOperator(data.operator);
      setLocked(false);
      setError('');
      return true;
    } catch {
      setError('PIN verification failed');
      return false;
    }
  }
  return { locked, operator, error, unlock, lock: () => { setLocked(true); setOperator(null); } };
}
