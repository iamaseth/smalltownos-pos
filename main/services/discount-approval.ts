/**
 * Discount approval by PIN. Anyone with the `discounts.approve` permission can approve with their
 * own PIN (by default owners and managers; the owner can give it to one cashier in Staff →
 * permissions). The approver is always recorded so reports show whose PIN approved each discount.
 */
import { getDatabase, verifyPin } from '../db';
import { hasPermission } from './authorization';

type Db = ReturnType<typeof getDatabase>;

export interface DiscountApprover { id: string; name: string }

/** The active person whose PIN matches and who may approve discounts, or null. `preferredId` is tried first. */
export function findDiscountApprover(db: Db, pin: unknown, preferredId?: unknown): DiscountApprover | null {
  if (typeof pin !== 'string' && typeof pin !== 'number') return null;
  const entered = String(pin).trim();
  if (!entered) return null;
  const users = db.prepare('SELECT id, name, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL').all() as { id: string; name: string; pin_hash: string }[];
  const ordered = typeof preferredId === 'string' && preferredId
    ? [...users.filter((u) => u.id === preferredId), ...users.filter((u) => u.id !== preferredId)]
    : users;
  const match = ordered.find((u) => hasPermission(u.id, 'discounts.approve') && verifyPin(u.pin_hash, entered));
  return match ? { id: match.id, name: match.name } : null;
}
