import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getJWTSecret } from '../security/jwt-secret';
import { getDatabase } from '../db';
import { resolveEffectivePermissions } from '../services/authorization';

/**
 * Staff PIN verification for a register already authenticated to the POS.
 * A successful PIN creates a short-lived bearer token scoped to that employee.
 * Existing API permission middleware then enforces the employee's own access.
 */
const router = Router();
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' },
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
    const accessToken = jwt.sign(
      { userId: matched.id, email: null, role: matched.role, tenantId: 1, registerSession: true, jti: randomUUID() },
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
