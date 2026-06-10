import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

const SANDBOX = process.env.PAYFAST_SANDBOX === 'true';
const PAYFAST_URL = SANDBOX
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';
const MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID ?? '10000100';
const MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY ?? '46f0cd694581a';
const PASSPHRASE = process.env.PAYFAST_PASSPHRASE ?? 'jt7NOE43FZPn';
const BACKEND_URL = process.env.BACKEND_URL ?? 'https://empire-backend-8066.onrender.com';

// POST /payments/payfast/initiate
router.post('/payfast/initiate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      fail(res, 400, 'VALIDATION_ERROR', 'orderId is required.');
      return;
    }

    const orderRow = await pool.query(
      `SELECT o.total, o.payment_status, u.email, u.first_name, u.last_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id=$1 AND o.user_id=$2`,
      [orderId, req.userId]
    );
    if (!orderRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Order not found.');
      return;
    }
    const order = orderRow.rows[0];
    if (order.payment_status === 'paid') {
      fail(res, 400, 'ALREADY_PAID', 'This order has already been paid.');
      return;
    }

    const params: Record<string, string> = {
      merchant_id: MERCHANT_ID,
      merchant_key: MERCHANT_KEY,
      return_url: 'empire://payment-success',
      cancel_url: 'empire://payment-cancel',
      notify_url: `${BACKEND_URL}/payments/payfast/notify`,
      name_first: order.first_name as string,
      name_last: order.last_name as string,
      email_address: order.email as string,
      m_payment_id: orderId as string,
      amount: parseFloat(order.total as string).toFixed(2),
      item_name: `Empire Deliveries Order #${(orderId as string).slice(0, 8)}`,
    };

    const signature = buildPayFastSignature(params, PASSPHRASE);
    const queryString = new URLSearchParams({ ...params, signature }).toString();

    ok(res, { redirectUrl: `${PAYFAST_URL}?${queryString}` });
  } catch (err) {
    console.error('payfast initiate error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /payments/payfast/notify  — PayFast ITN webhook (no auth)
router.post('/payfast/notify', async (req: Request, res: Response) => {
  try {
    const data = req.body as Record<string, string>;
    const receivedSignature = data.signature;
    delete data.signature;

    const expectedSignature = buildPayFastSignature(data, PASSPHRASE);
    if (receivedSignature !== expectedSignature) {
      res.status(400).send('Invalid signature');
      return;
    }

    const { m_payment_id, payment_status } = data;
    if (payment_status === 'COMPLETE' && m_payment_id) {
      await pool.query(
        `UPDATE orders SET payment_status='paid', status='confirmed', confirmed_at=NOW()
         WHERE id=$1`,
        [m_payment_id]
      );
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('payfast notify error:', err);
    res.status(500).send('error');
  }
});

// POST /payments/confirm  — called by app after WebBrowser returns
router.post('/confirm', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      fail(res, 400, 'VALIDATION_ERROR', 'orderId is required.');
      return;
    }
    const result = await pool.query(
      'SELECT id, payment_status, status FROM orders WHERE id=$1 AND user_id=$2',
      [orderId, req.userId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Order not found.');
      return;
    }
    ok(res, { paymentStatus: result.rows[0].payment_status, status: result.rows[0].status });
  } catch (err) {
    console.error('payment confirm error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// All other payment providers — not implemented for this milestone
router.post('/ozow/initiate', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Ozow payments coming soon.' }));
router.post('/peach/initiate', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Peach Payments coming soon.' }));
router.post('/wallet/pay', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Wallet payments coming soon.' }));

function buildPayFastSignature(params: Record<string, string>, passphrase: string): string {
  const sorted = Object.keys(params)
    .sort()
    .filter((k) => params[k] !== '' && params[k] !== undefined)
    .map((k) => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`)
    .join('&');
  const withPass = passphrase ? `${sorted}&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}` : sorted;
  return crypto.createHash('md5').update(withPass).digest('hex');
}

export default router;
