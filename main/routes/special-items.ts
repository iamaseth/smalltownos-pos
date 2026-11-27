/**
 * BackStreet: Special items settings. GET tells the till whether the Special button is on and
 * which hidden items to use; PUT (settings.manage) picks the kitchen and bar categories.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, withTxn } from '../db';
import { hasPermission, requirePermission } from '../services/authorization';
import { SPECIAL_ITEM_PERMISSION, getSpecialItemConfig, saveSpecialItemConfig } from '../services/special-items';

const router = Router();

function fail(res: Response, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (!statusCode) console.error('[SpecialItems]', error);
  res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Internal server error' });
}

router.get('/', requirePermission('orders.read'), (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user?.userId ?? '');
    res.json({ ...getSpecialItemConfig(), can_add: hasPermission(userId, SPECIAL_ITEM_PERMISSION) });
  } catch (error) { fail(res, error); }
});

router.put('/', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const config = withTxn(() => saveSpecialItemConfig(db, req.body || {}));
    res.json(config);
  } catch (error) { fail(res, error); }
});

export { router as specialItemRoutes };
