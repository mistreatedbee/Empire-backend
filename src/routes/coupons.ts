import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { ok, fail } from '../utils/response';

const router = Router();

// GET /coupons/validate?code=XXX&amount=NNN
router.get('/validate', async (req: Request, res: Response) => {
  try {
    const code = ((req.query.code as string) ?? '').trim().toUpperCase();
    const amount = parseFloat((req.query.amount as string) ?? '0');

    if (!code) {
      ok(res, { valid: false, message: 'Please enter a coupon code.' });
      return;
    }

    const result = await pool.query(
      `SELECT * FROM coupons WHERE code = $1`,
      [code]
    );

    if (!result.rows.length) {
      ok(res, { valid: false, message: 'Coupon not found.' });
      return;
    }

    const c = result.rows[0];

    if (!c.is_active) {
      ok(res, { valid: false, message: 'This coupon is no longer active.' });
      return;
    }

    if (c.expires_at && new Date(c.expires_at) < new Date()) {
      ok(res, { valid: false, message: 'This coupon has expired.' });
      return;
    }

    if (c.max_uses !== null && c.uses_count >= c.max_uses) {
      ok(res, { valid: false, message: 'This coupon has reached its usage limit.' });
      return;
    }

    if (amount < parseFloat(c.min_order)) {
      ok(res, {
        valid: false,
        message: `Minimum order of R${parseFloat(c.min_order).toFixed(2)} required for this coupon.`,
      });
      return;
    }

    ok(res, {
      valid: true,
      discountType: c.discount_type,
      discountValue: parseFloat(c.discount_value),
      maxDiscount: c.max_discount ? parseFloat(c.max_discount) : null,
      message: c.discount_type === 'percentage'
        ? `${parseFloat(c.discount_value)}% off applied!`
        : `R${parseFloat(c.discount_value).toFixed(2)} off applied!`,
    });
  } catch (err) {
    console.error('coupon validate error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
