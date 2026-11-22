import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getJWTSecret } from '../security/jwt-secret';
import { getDatabase } from '../db';
import { resolveEffectivePermissions } from '../services/authorization';
import { createRegisterSession, revokeRegisterSession } from '../services/register-session';

/**
 * Staff PIN verification for a register already authenticated to the POS.
 * A successful PIN creates a short-lived bearer token scoped to that employee.
 * Existing API permission middleware then enforces the employee's own access.
 */
const router = Router();
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


/** Keep the server-side idle clock alive only while the signed-in operator is active. */
router.post('/activity', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/** Explicit staff switch/logout revokes the current PIN session immediately. */
router.post('/lock', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (user?.registerSession === true) revokeRegisterSession(user.jti, user.userId);
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
