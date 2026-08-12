import { logger } from '../utils/logger';
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import {
  buildPayFastItnSignature,
  buildPayFastCheckoutSignature,
} from '../utils/payfast';
import {
  buildPayfastCheckoutPage,
  createPayfastCheckoutToken,
  parsePayfastCheckoutToken,
} from '../utils/payfastCheckout';
import { notifyOrderDispatchable, notifyRestaurantNewOrder } from '../utils/orderNotifications';

const router = Router();

const MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID ?? '10000100';
const MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY ?? '46f0cd694581a';

/** Sandbox unless explicitly disabled. Test merchant id always uses sandbox. */
function isPayfastSandbox(): boolean {
  if (process.env.PAYFAST_SANDBOX === 'true') return true;
  if (process.env.PAYFAST_SANDBOX === 'false') return false;
  return MERCHANT_ID === '10000100';
}

const SANDBOX = isPayfastSandbox();
const PAYFAST_URL = SANDBOX
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

function resolvePayfastPassphrase(): string {
  const fromEnv = process.env.PAYFAST_PASSPHRASE?.trim();
  if (fromEnv) return fromEnv;
  if (SANDBOX) return 'jt7NOE43FZPn';
  return '';
}

const PASSPHRASE = resolvePayfastPassphrase();
const BACKEND_URL = (process.env.BACKEND_URL ?? 'https://empire-backend-8066.onrender.com').replace(/\/$/, '');
const APP_SCHEME = process.env.APP_SCHEME ?? 'empire';
const PAYFAST_RETURN_URL = `${BACKEND_URL}/payments/payfast/return`;
const PAYFAST_CANCEL_URL = `${BACKEND_URL}/payments/payfast/cancel`;

function payfastRedirectPage(deepLink: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Empire Deliveries</title>
  <meta http-equiv="refresh" content="0;url=${deepLink}">
  <script>window.location.replace(${JSON.stringify(deepLink)});</script>
</head>
<body>
  <p>${message}</p>
  <p><a href="${deepLink}">Continue in Empire Deliveries</a></p>
</body>
</html>`;
}

// PayFast redirects here after a successful payment (must be a public https URL).
router.get('/payfast/return', (_req: Request, res: Response) => {
  res
    .type('html')
    .send(payfastRedirectPage(`${APP_SCHEME}://payment/success`, 'Payment complete. Returning to the app…'));
});

// PayFast redirects here when the customer cancels (must be a public https URL).
router.get('/payfast/cancel', (_req: Request, res: Response) => {
  res
    .type('html')
    .send(payfastRedirectPage(`${APP_SCHEME}://payment/cancelled`, 'Payment cancelled. Returning to the app…'));
});

// Serves an auto-submit POST form to PayFast (avoids GET query-string signature issues).
router.get('/payfast/checkout/:token', (req: Request, res: Response) => {
  const session = parsePayfastCheckoutToken(String(req.params.token ?? ''));
  if (!session) {
    res.status(400).type('html').send('<p>This payment link has expired. Return to the app and try again.</p>');
    return;
  }

  res
    .type('html')
    .send(buildPayfastCheckoutPage(session.params, session.actionUrl, {
      signature: session.signature,
      passphrase: PASSPHRASE || undefined,
    }));
});

// ─── PayFast ──────────────────────────────────────────────────────────────────

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
      return_url: PAYFAST_RETURN_URL,
      cancel_url: PAYFAST_CANCEL_URL,
      notify_url: `${BACKEND_URL}/payments/payfast/notify`,
      name_first: String(order.first_name ?? '').trim(),
      name_last: String(order.last_name ?? '').trim(),
      email_address: String(order.email ?? '').trim(),
      m_payment_id: String(orderId),
      amount: parseFloat(String(order.total)).toFixed(2),
      item_name: `Empire Order ${String(orderId).slice(0, 8)}`,
    };

    const signature = buildPayFastCheckoutSignature(params, PASSPHRASE || undefined);
    const token = createPayfastCheckoutToken({ params, actionUrl: PAYFAST_URL, signature });
    logger.info(
      { sandbox: SANDBOX, merchantId: MERCHANT_ID, hasPassphrase: Boolean(PASSPHRASE), payfastHost: SANDBOX ? 'sandbox' : 'live' },
      'payfast initiate',
    );

    ok(res, { redirectUrl: `${BACKEND_URL}/payments/payfast/checkout/${token}` });
  } catch (err) {
    logger.error({ err }, 'payfast initiate');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /payments/payfast/notify  — PayFast ITN webhook (no auth)
router.post('/payfast/notify', async (req: Request, res: Response) => {
  try {
    const data = { ...req.body } as Record<string, string>;
    const receivedSignature = data.signature;
    delete data.signature;

    const expectedSignature = buildPayFastItnSignature(data, PASSPHRASE);
    if (receivedSignature !== expectedSignature) {
      res.status(400).send('Invalid signature');
      return;
    }

    const { m_payment_id, payment_status } = data;
    if (payment_status === 'COMPLETE' && m_payment_id) {
      // Check if this is a wallet top-up (reference: 'wallet_topup:<userId>:<amount>')
      if (m_payment_id.startsWith('wallet_topup:')) {
        const parts = m_payment_id.split(':');
        const userId = parts[1];
        const amount = parseFloat(parts[2]);
        if (userId && !isNaN(amount) && amount > 0) {
          await pool.query(
            `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
            [amount, userId]
          );
          await pool.query(
            `INSERT INTO wallet_transactions (user_id, type, amount, reference, description)
             VALUES ($1, 'topup', $2, $3, 'Wallet top-up via PayFast')`,
            [userId, amount, m_payment_id]
          );
        }
      } else {
        // Regular order payment
        await pool.query(
          `UPDATE orders SET payment_status='paid', status='confirmed', confirmed_at=NOW(), payment_method='payfast'
           WHERE id=$1`,
          [m_payment_id]
        );
        void notifyOrderDispatchable(m_payment_id as string);
        const paidOrder = await pool.query(
          'SELECT restaurant_id, total FROM orders WHERE id=$1',
          [m_payment_id],
        );
        if (paidOrder.rows.length) {
          void notifyRestaurantNewOrder(
            paidOrder.rows[0].restaurant_id as string,
            m_payment_id as string,
            parseFloat(String(paidOrder.rows[0].total)),
          );
        }
        await pool.query(
          `INSERT INTO payment_transactions (order_id, provider, external_id, amount, status, raw_payload)
           VALUES ($1, 'payfast', $2, $3, 'complete', $4)
           ON CONFLICT (provider, external_id) DO NOTHING`,
          [m_payment_id, data.pf_payment_id ?? m_payment_id, data.amount_gross ?? null, JSON.stringify(data)]
        );
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error({ err }, 'payfast notify');
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
    logger.error({ err }, 'payment confirm');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Wallet ───────────────────────────────────────────────────────────────────

// GET /payments/wallet/balance
router.get('/wallet/balance', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [req.userId]);
    ok(res, { balance: parseFloat(String(rows[0]?.wallet_balance ?? '0')) });
  } catch (err) {
    logger.error({ err }, 'wallet balance');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /payments/wallet/transactions
router.get('/wallet/transactions', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, amount, description, reference, created_at
       FROM wallet_transactions WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 20`,
      [req.userId]
    );
    ok(res, rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: parseFloat(String(r.amount)),
      description: r.description,
      reference: r.reference,
      createdAt: r.created_at,
    })));
  } catch (err) {
    logger.error({ err }, 'wallet transactions');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /payments/wallet/topup — initiates PayFast for wallet top-up
router.post('/wallet/topup', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { amount } = req.body;
    if (!amount || typeof amount !== 'number' || amount < 10) {
      fail(res, 400, 'VALIDATION_ERROR', 'amount must be at least R10.');
      return;
    }

    const userRow = await pool.query('SELECT email, first_name, last_name FROM users WHERE id=$1', [req.userId]);
    if (!userRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    const u = userRow.rows[0];

    const reference = `wallet_topup:${req.userId}:${amount.toFixed(2)}`;
    const params: Record<string, string> = {
      merchant_id: MERCHANT_ID,
      merchant_key: MERCHANT_KEY,
      return_url: PAYFAST_RETURN_URL,
      cancel_url: PAYFAST_CANCEL_URL,
      notify_url: `${BACKEND_URL}/payments/payfast/notify`,
      name_first: String(u.first_name ?? '').trim(),
      name_last: String(u.last_name ?? '').trim(),
      email_address: String(u.email ?? '').trim(),
      m_payment_id: reference,
      amount: amount.toFixed(2),
      item_name: 'Empire Wallet Top-up',
    };
    const signature = buildPayFastCheckoutSignature(params, PASSPHRASE || undefined);
    const token = createPayfastCheckoutToken({ params, actionUrl: PAYFAST_URL, signature });

    ok(res, { redirectUrl: `${BACKEND_URL}/payments/payfast/checkout/${token}` });
  } catch (err) {
    logger.error({ err }, 'wallet topup');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /payments/wallet/pay — pay for an order using wallet balance
router.post('/wallet/pay', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      fail(res, 400, 'VALIDATION_ERROR', 'orderId is required.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const [orderRes, userRes] = await Promise.all([
        client.query(
          `SELECT id, total, payment_status FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE`,
          [orderId, req.userId]
        ),
        client.query(
          `SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE`,
          [req.userId]
        ),
      ]);

      if (!orderRes.rows.length) {
        await client.query('ROLLBACK');
        fail(res, 404, 'NOT_FOUND', 'Order not found.');
        return;
      }
      if (orderRes.rows[0].payment_status === 'paid') {
        await client.query('ROLLBACK');
        fail(res, 400, 'ALREADY_PAID', 'This order has already been paid.');
        return;
      }

      const total = parseFloat(String(orderRes.rows[0].total));
      const balance = parseFloat(String(userRes.rows[0]?.wallet_balance ?? '0'));

      if (balance < total) {
        await client.query('ROLLBACK');
        fail(res, 402, 'INSUFFICIENT_FUNDS', `Insufficient wallet balance. Available: R${balance.toFixed(2)}, Required: R${total.toFixed(2)}.`);
        return;
      }

      await client.query(
        `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
        [total, req.userId]
      );
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, reference, description)
         VALUES ($1, 'payment', $2, $3, 'Order payment')`,
        [req.userId, total, orderId]
      );
      await client.query(
        `UPDATE orders SET payment_status='paid', status='confirmed', confirmed_at=NOW(), payment_method='wallet'
         WHERE id=$1`,
        [orderId]
      );

      await client.query('COMMIT');
      const newBalance = balance - total;
      ok(res, { success: true, newBalance });
      void notifyOrderDispatchable(orderId);
      const paidOrder = await pool.query(
        'SELECT restaurant_id, total FROM orders WHERE id=$1',
        [orderId],
      );
      if (paidOrder.rows.length) {
        void notifyRestaurantNewOrder(
          paidOrder.rows[0].restaurant_id as string,
          orderId,
          parseFloat(String(paidOrder.rows[0].total)),
        );
      }
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'wallet pay');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
