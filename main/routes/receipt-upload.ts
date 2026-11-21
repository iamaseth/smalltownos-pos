import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { rateLimit } from '../middleware/security';
import { phoneUploadInfo, sendError, storePhoneReceipt } from './cash-handover';

/**
 * Public phone page for receipt photos. No login: the signed, 30-minute link from the
 * till's QR code is the only credential, and it can only add photos to that one open shift.
 */
const router = Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 120, message: 'Too many requests. Please try again later.', bypassPrivateIp: false }));

router.get('/info', (req: Request, res: Response) => {
  try {
    res.json(phoneUploadInfo(getDatabase(), req.query.t));
  } catch (error) { sendError(res, error, 'Could not check the link'); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const media = storePhoneReceipt(getDatabase(), (req.body || {}).t, (req.body || {}).data);
    res.status(201).json({ ok: true, id: media.id });
  } catch (error) { sendError(res, error, 'Could not save the photo'); }
});

export const receiptUploadRoutes = router;
