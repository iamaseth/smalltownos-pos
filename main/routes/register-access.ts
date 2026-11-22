import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getJWTSecret } from '../security/jwt-secret';
import { getDatabase, now } from '../db';
import { resolveEffectivePermissions, requirePermission } from '../services/authorization';
import { createRegisterSession, revokeRegisterSession } from '../services/register-session';

/**
 * Staff PIN verification for a register already authenticated to the POS.
 * A successful PIN creates a short-lived bearer token scoped to that employee.
 * Existing API permission middleware then enforces the employee's own access.
 */
const router = Router();

function recordAccessEvent(
  req: Request,
  eventType: 'unlock' | 'lock' | 'pin_failed' | 'idle_expired',
  operatorUserId: string | null,
  sessionId: string | null,
): void {
  try {
    const actorUserId = (req as Request & { user?: { userId?: string } }).user?.userId ?? null;
    getDatabase().prepare(`
      INSERT INTO register_access_events
        (event_type, actor_user_id, operator_user_id, session_id, source_ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      actorUserId,
      operatorUserId,
      sessionId,
      req.ip || req.socket.remoteAddress || null,
      now(),
    );
  } catch (error) {
    // Auditing must never expose PINs or block the till; retain a server-side diagnostic.
    console.error('[RegisterAccess] Failed to record access event', error);
  }
}

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  // Count only wrong PINs. Successful staff switches must never lock a busy
  // register out (8 normal switches in 15 minutes is routine at a bar).
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
});

/**
 * Whether the register PIN lock is in use: only once at least one active
 * employee has a PIN. A new install (or a shop not using PINs yet) is never
 * locked out of its own POS.
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const row = getDatabase().prepare(
      'SELECT COUNT(*) AS n FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL'
    ).get() as { n: number };
    res.json({ pin_lock_enabled: row.n > 0 });
  } catch {
    res.status(500).json({ error: 'Register status unavailable' });
  }
});


/** Recent register access history for managers and owners. */
router.get('/events', requirePermission('staff.view'), (req: Request, res: Response) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
      : 50;
    const events = getDatabase().prepare(`
      SELECT e.id, e.event_type, e.actor_user_id, actor.name AS actor_name,
             e.operator_user_id, operator.name AS operator_name,
             e.source_ip, e.created_at
      FROM register_access_events e
      LEFT JOIN users actor ON actor.id = e.actor_user_id
      LEFT JOIN users operator ON operator.id = e.operator_user_id
      ORDER BY e.id DESC
      LIMIT ?
    `).all(limit);
    res.json({ events });
  } catch {
    res.status(500).json({ error: 'Register access history unavailable' });
  }
});

/** Keep the server-side idle clock alive only while the signed-in operator is active. */
router.post('/activity', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/** Explicit staff switch/logout revokes the current PIN session immediately. */
router.post('/lock', (req: Request, res: Response) => {
  const user = (req as Request & { user?: { registerSession?: boolean; userId?: string; jti?: string } }).user;
  if (user?.registerSession === true) {
    recordAccessEvent(req, 'lock', user.userId, user.jti);
    revokeRegisterSession(user.jti ?? null, user.userId ?? null);
  }
  res.json({ ok: true });
});

router.post('/unlock', pinLimiter, async (req: Request, res: Response) => {
  const pin = req.body?.pin;
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    res.status(400).json({ error: 'Four-digit PIN required' });
    return;
  }
  try {
    const db = getDatabase();
    // Existing FloPOS staff schema stores bcrypt PIN hashes.
    const users = db.prepare(
      'SELECT id, name, role, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL'
    ).all() as Array<{ id: string; name: string; role: string; pin_hash: string }>;
    // Check every candidate to avoid revealing which employee has which PIN.
    let matched: (typeof users)[number] | null = null;
    for (const user of users) {
      if (await bcrypt.compare(pin, user.pin_hash)) {
        if (matched) {
          res.status(409).json({ error: 'PIN is not unique. Contact the manager.' });
          return;
        }
        matched = user;
      }
    }
    if (!matched) {
      recordAccessEvent(req, 'pin_failed', null, null);
      res.status(401).json({ error: 'Invalid PIN' });
      return;
    }
    const effective = resolveEffectivePermissions(matched.id);
    if (!effective) {
      res.status(401).json({ error: 'Employee account is no longer active' });
      return;
    }
    // Mint a short-lived normal POS bearer token for the employee. All existing
    // API permission middleware now evaluates this employee, not the manager
    // who originally opened the register. The frontend keeps it in memory only.
    const sessionId = randomUUID();
    createRegisterSession(sessionId, matched.id);
    recordAccessEvent(req, 'unlock', matched.id, sessionId);
    const accessToken = jwt.sign(
      { userId: matched.id, email: null, role: matched.role, tenantId: 1, registerSession: true, jti: sessionId },
      getJWTSecret(),
      { expiresIn: '8h' },
    );
    res.json({
      access_token: accessToken,
      expires_in: 8 * 60 * 60,
      operator: {
        id: matched.id,
        name: matched.name,
        role: matched.role,
        permissions: [...effective.permissionIds],
      },
    });
  } catch {
    res.status(500).json({ error: 'PIN verification unavailable' });
  }
});

export const registerAccessRoutes = router;
