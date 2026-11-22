/**
 * Server-side idle enforcement for PIN-authenticated register sessions.
 * Sessions intentionally live only in memory: a server restart invalidates
 * every register PIN session, while the normal owner/manager login remains.
 */
export const REGISTER_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

type RegisterSession = { userId: string; lastActivity: number };
const sessions = new Map<string, RegisterSession>();
const expiredSessions = new Set<string>();

function pruneExpired(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - session.lastActivity >= REGISTER_SESSION_IDLE_TIMEOUT_MS) {
      sessions.delete(id);
      expiredSessions.add(id);
    }
  }
}

export function createRegisterSession(sessionId: string, userId: string): void {
  const now = Date.now();
  pruneExpired(now);
  expiredSessions.delete(sessionId);
  sessions.set(sessionId, { userId, lastActivity: now });
}

export function touchRegisterSession(sessionId: unknown, userId: unknown): boolean {
  if (typeof sessionId !== 'string' || !sessionId || typeof userId !== 'string' || !userId) return false;
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return false;
  const now = Date.now();
  if (now - session.lastActivity >= REGISTER_SESSION_IDLE_TIMEOUT_MS) {
    sessions.delete(sessionId);
    expiredSessions.add(sessionId);
    return false;
  }
  session.lastActivity = now;
  return true;
}

export function revokeRegisterSession(sessionId: unknown, userId: unknown): void {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const session = sessions.get(sessionId);
  if (session && session.userId === userId) sessions.delete(sessionId);
  expiredSessions.delete(sessionId);
}

/** Test-only reset to prevent module state leaking between suites. */
export function consumeExpiredRegisterSession(sessionId: unknown, userId: unknown): boolean {
  if (typeof sessionId !== 'string' || typeof userId !== 'string') return false;
  const wasExpired = expiredSessions.has(sessionId);
  if (wasExpired) expiredSessions.delete(sessionId);
  return wasExpired;
}

export function resetRegisterSessionsForTests(): void {
  sessions.clear();
  expiredSessions.clear();
}
