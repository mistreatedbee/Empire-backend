import { Router, Request, Response } from 'express';
import { ok } from '../utils/response';

const router = Router();

// GET /coupons/validate  — stub for Phase 0
router.get('/validate', (_req: Request, res: Response) => {
  ok(res, { valid: false, message: 'Invalid or expired coupon.' });
});

export default router;
