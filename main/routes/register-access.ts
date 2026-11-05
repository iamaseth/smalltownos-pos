import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getDatabase } from '../db';

/**
 * Staff PIN verification for a register already authenticated to the POS.
 * This is NOT a replacement for the existing bearer authentication.
 * It does not grant privileges or change the JWT identity.
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
    res.json({ operator: { id: matched.id, name: matched.name, role: matched.role } });
  } catch {
    res.status(500).json({ error: 'PIN verification unavailable' });
  }
});

export const registerAccessRoutes = router;
