import axios from 'axios';

let authRedirectInProgress = false;
export const REGISTER_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const REGISTER_SESSION_KEY = 'flo.registerSession';

export type RegisterOperator = { id: string; name: string; role: string; permissions: string[] };
type StoredRegisterSession = { token: string; operator: RegisterOperator | null; lastActivity: number };

/**
 * The staff PIN session survives page changes and reloads in this browser tab
 * (sessionStorage, never localStorage) until it has been idle for the timeout.
 */
export function readRegisterSession(): StoredRegisterSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(REGISTER_SESSION_KEY) || 'null') as StoredRegisterSession | null;
    if (!stored?.token || Date.now() - Number(stored.lastActivity || 0) >= REGISTER_IDLE_TIMEOUT_MS) {
      window.sessionStorage.removeItem(REGISTER_SESSION_KEY);
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

let registerSessionToken: string | null = readRegisterSession()?.token ?? null;

export function setRegisterSessionToken(token: string | null, operator: RegisterOperator | null = null): void {
  registerSessionToken = token;
  if (typeof window === 'undefined') return;
  try {
    if (token) window.sessionStorage.setItem(REGISTER_SESSION_KEY, JSON.stringify({ token, operator, lastActivity: Date.now() }));
    else window.sessionStorage.removeItem(REGISTER_SESSION_KEY);
  } catch { /* storage unavailable: the session still lives in memory */ }
}

export function touchRegisterSession(): void {
  if (!registerSessionToken || typeof window === 'undefined') return;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(REGISTER_SESSION_KEY) || 'null') as StoredRegisterSession | null;
    if (stored?.token === registerSessionToken) window.sessionStorage.setItem(REGISTER_SESSION_KEY, JSON.stringify({ ...stored, lastActivity: Date.now() }));
  } catch { /* ignore */ }
}

// Base URL derived from window.location.origin so LAN clients connect to host IP.
const api = axios.create({
  baseURL: typeof window !== 'undefined' ? `${window.location.origin}/api` : '/api',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// Requests sent with a staff PIN token. A 401 on one of these only ends the PIN
// session, even if another request already cleared the token in the meantime.
const sentWithRegisterSession = new WeakSet<object>();

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = registerSessionToken || localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    if (registerSessionToken) sentWithRegisterSession.add(config);
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // BackStreet: a wrong PIN on the register lock screen answers 401 "Invalid PIN".
    // That is a wrong PIN, not an expired login, so it must never sign the device out.
    const requestUrl = String(error.config?.url || '');
    const isPinCheck = requestUrl.endsWith('/register-access/unlock');
    if (error.response?.status === 401 && typeof window !== 'undefined' && !isPinCheck) {
      if (registerSessionToken || (error.config && sentWithRegisterSession.has(error.config))) {
        if (registerSessionToken) {
          registerSessionToken = null;
          window.dispatchEvent(new Event('flo:register-session-expired'));
        }
        return Promise.reject(error);
      }
      // KDS routes render inline login; avoid redirecting away to /auth/login.
      const isKdsPath = window.location.pathname.startsWith('/kds');
      localStorage.removeItem('token');
      if (isKdsPath) return Promise.reject(error);
      // Don't redirect when already on the login page — let the login handler show the error
      if (!window.location.pathname.includes('/auth/login') && !authRedirectInProgress) {
        authRedirectInProgress = true;
        localStorage.removeItem('tenant');
        window.location.href = '/auth/login';
      }
    }
    if (error.response?.status === 403 && error.response?.data?.code === 'permission_denied' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('flo:authorization-denied'));
    }
    return Promise.reject(error);
  }
);

export default api;
