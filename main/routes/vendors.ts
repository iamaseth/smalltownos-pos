import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { getDatabase, now } from '../db';
import { requirePermission } from '../services/authorization';

const router = Router();

interface VendorRow {
  id: string;
  name: string;
  phone: string | null;
  contact_name: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function getVendor(id: string): VendorRow | undefined {
  return getDatabase().prepare('SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL').get(id) as VendorRow | undefined;
}

router.get('/', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
  const vendors = getDatabase().prepare(`
    SELECT * FROM vendors
    WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND is_active = 1'}
    ORDER BY name COLLATE NOCASE
  `).all();
  res.json({ vendors });
});

router.post('/', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  const body = req.body || {};
  const name = cleanText(body.name, 200);
  if (!name) return fail(res, 400, 'name is required');
  const db = getDatabase();
  const duplicate = db.prepare('SELECT 1 FROM vendors WHERE deleted_at IS NULL AND name = ? COLLATE NOCASE').get(name);
  if (duplicate) return fail(res, 409, 'A vendor with this name already exists');
  const id = `ven_${randomBytes(8).toString('hex')}`;
  const timestamp = now();
  db.prepare(`
    INSERT INTO vendors (id, name, phone, contact_name, email, address, notes, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, name, cleanText(body.phone, 60), cleanText(body.contact_name, 120), cleanText(body.email, 200), cleanText(body.address, 300), cleanText(body.notes, 500), timestamp, timestamp);
  res.status(201).json({ vendor: getVendor(id) });
});

router.put('/:id', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  const existing = getVendor(String(req.params.id));
  if (!existing) return fail(res, 404, 'Vendor not found');
  const body = req.body || {};
  const name = body.name === undefined ? existing.name : cleanText(body.name, 200);
  if (!name) return fail(res, 400, 'name is required');
  const db = getDatabase();
  const duplicate = db.prepare('SELECT 1 FROM vendors WHERE deleted_at IS NULL AND id != ? AND name = ? COLLATE NOCASE').get(existing.id, name);
  if (duplicate) return fail(res, 409, 'A vendor with this name already exists');
  db.prepare(`
    UPDATE vendors SET name = ?, phone = ?, contact_name = ?, email = ?, address = ?, notes = ?, is_active = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(
    name,
    body.phone === undefined ? existing.phone : cleanText(body.phone, 60),
    body.contact_name === undefined ? existing.contact_name : cleanText(body.contact_name, 120),
    body.email === undefined ? existing.email : cleanText(body.email, 200),
    body.address === undefined ? existing.address : cleanText(body.address, 300),
    body.notes === undefined ? existing.notes : cleanText(body.notes, 500),
    body.is_active === undefined ? existing.is_active : (body.is_active ? 1 : 0),
    now(),
    existing.id,
  );
  res.json({ vendor: getVendor(existing.id) });
});

router.delete('/:id', requirePermission('supplies.manage'), (req: Request, res: Response) => {
  const existing = getVendor(String(req.params.id));
  if (!existing) return fail(res, 404, 'Vendor not found');
  const timestamp = now();
  getDatabase().prepare('UPDATE vendors SET deleted_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, existing.id);
  res.json({ success: true });
});

export const vendorRoutes = router;
