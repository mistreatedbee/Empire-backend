import { logger } from '../utils/logger';
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import https from 'https';
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

    const expectedSignature = buildPayFastSignature(data, PASSPHRASE);
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
          `UPDATE orders SET payment_status='paid', status='confirmed', confirmed_at=NOW()
           WHERE id=$1`,
          [m_payment_id]
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
      return_url: 'empire://wallet-topup-success',
      cancel_url: 'empire://wallet-topup-cancel',
      notify_url: `${BACKEND_URL}/payments/payfast/notify`,
      name_first: u.first_name as string,
      name_last: u.last_name as string,
      email_address: u.email as string,
      m_payment_id: reference,
      amount: amount.toFixed(2),
      item_name: 'Empire Deliveries Wallet Top-up',
    };
    const signature = buildPayFastSignature(params, PASSPHRASE);
    const queryString = new URLSearchParams({ ...params, signature }).toString();

    ok(res, { redirectUrl: `${PAYFAST_URL}?${queryString}` });
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

// ─── Ozow ─────────────────────────────────────────────────────────────────────

const OZOW_SITE_CODE = process.env.OZOW_SITE_CODE ?? '';
const OZOW_PRIVATE_KEY = process.env.OZOW_PRIVATE_KEY ?? '';
const OZOW_IS_TEST = process.env.OZOW_IS_TEST !== 'false';
const OZOW_URL = OZOW_IS_TEST ? 'https://pay.ozow.com/' : 'https://pay.ozow.com/';

// POST /payments/ozow/initiate
router.post('/ozow/initiate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!OZOW_SITE_CODE || !OZOW_PRIVATE_KEY) {
      fail(res, 503, 'NOT_CONFIGURED', 'Ozow payments are not yet configured. Please use PayFast or Cash.');
      return;
    }
    const { orderId } = req.body;
    if (!orderId) {
      fail(res, 400, 'VALIDATION_ERROR', 'orderId is required.');
      return;
    }
    const orderRow = await pool.query(
      `SELECT o.total, o.payment_status FROM orders WHERE o.id=$1 AND o.user_id=$2`,
      [orderId, req.userId]
    );
    if (!orderRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Order not found.');
      return;
    }
    if (orderRow.rows[0].payment_status === 'paid') {
      fail(res, 400, 'ALREADY_PAID', 'This order has already been paid.');
      return;
    }

    const amount = parseFloat(String(orderRow.rows[0].total)).toFixed(2);
    const successUrl = 'empire://payment-success';
    const cancelUrl = 'empire://payment-cancel';
    const errorUrl = 'empire://payment-cancel';
    const notifyUrl = `${BACKEND_URL}/payments/ozow/notify`;
    const isTest = OZOW_IS_TEST ? 'true' : 'false';

    // Ozow SHA512 hash: lowercase concatenation of specific fields + private key
    const hashInput = [
      OZOW_SITE_CODE, 'ZA', 'ZAR', amount, orderId, orderId,
      successUrl, cancelUrl, errorUrl, notifyUrl, isTest, OZOW_PRIVATE_KEY
    ].join('').toLowerCase();
    const hashCheck = crypto.createHash('sha512').update(hashInput).digest('hex');

    const params = new URLSearchParams({
      SiteCode: OZOW_SITE_CODE,
      CountryCode: 'ZA',
      CurrencyCode: 'ZAR',
      Amount: amount,
      TransactionReference: orderId,
      BankReference: orderId.slice(0, 8),
      SuccessUrl: successUrl,
      CancelUrl: cancelUrl,
      ErrorUrl: errorUrl,
      NotifyUrl: notifyUrl,
      IsTest: isTest,
      HashCheck: hashCheck,
    });

    ok(res, { redirectUrl: `${OZOW_URL}?${params.toString()}` });
  } catch (err) {
    logger.error({ err }, 'ozow initiate');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /payments/ozow/notify — Ozow webhook
router.post('/ozow/notify', async (req: Request, res: Response) => {
  try {
    const data = req.body as Record<string, string>;
    const { HashCheck, Status, TransactionReference } = data;

    if (!OZOW_PRIVATE_KEY) {
      res.status(200).send('OK');
      return;
    }

    // Validate hash (re-hash without HashCheck field)
    const { HashCheck: _removed, ...rest } = data;
    const hashInput = Object.values(rest).join('').toLowerCase() + OZOW_PRIVATE_KEY.toLowerCase();
    const expected = crypto.createHash('sha512').update(hashInput).digest('hex');

    if (HashCheck?.toLowerCase() !== expected) {
      res.status(400).send('Invalid hash');
      return;
    }

    if (Status === 'Complete' && TransactionReference) {
      await pool.query(
        `UPDATE orders SET payment_status='paid', status='confirmed', confirmed_at=NOW() WHERE id=$1`,
        [TransactionReference]
      );
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error({ err }, 'ozow notify');
    res.status(500).send('error');
  }
});

// ─── Peach Payments ───────────────────────────────────────────────────────────

const PEACH_ENTITY_ID = process.env.PEACH_ENTITY_ID ?? '';
const PEACH_ACCESS_TOKEN = process.env.PEACH_ACCESS_TOKEN ?? '';
const PEACH_IS_TEST = process.env.PEACH_IS_TEST !== 'false';
const PEACH_BASE = PEACH_IS_TEST
  ? 'https://eu-test.oppwa.com'
  : 'https://eu.oppwa.com';

// POST /payments/peach/initiate
router.post('/peach/initiate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!PEACH_ENTITY_ID || !PEACH_ACCESS_TOKEN) {
      fail(res, 503, 'NOT_CONFIGURED', 'Peach Payments are not yet configured. Please use PayFast or Cash.');
      return;
    }
    const { orderId } = req.body;
    if (!orderId) {
      fail(res, 400, 'VALIDATION_ERROR', 'orderId is required.');
      return;
    }
    const orderRow = await pool.query(
      `SELECT total, payment_status FROM orders WHERE id=$1 AND user_id=$2`,
      [orderId, req.userId]
    );
    if (!orderRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Order not found.');
      return;
    }
    if (orderRow.rows[0].payment_status === 'paid') {
      fail(res, 400, 'ALREADY_PAID', 'This order has already been paid.');
      return;
    }

    const amount = parseFloat(String(orderRow.rows[0].total)).toFixed(2);
    const body = new URLSearchParams({
      entityId: PEACH_ENTITY_ID,
      amount,
      currency: 'ZAR',
      paymentType: 'DB',
      merchantTransactionId: orderId,
    }).toString();

    // Call Peach server-side to create a checkout session
    const checkoutId = await new Promise<string>((resolve, reject) => {
      const options = {
        hostname: PEACH_BASE.replace('https://', ''),
        path: '/v1/checkouts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${PEACH_ACCESS_TOKEN}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const r = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { id?: string };
            if (parsed.id) resolve(parsed.id); else reject(new Error(data));
          } catch { reject(new Error(data)); }
        });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    const shopperResultUrl = 'empire://payment-success';
    ok(res, {
      checkoutId,
      shopperResultUrl,
      scriptUrl: `${PEACH_BASE}/v1/paymentWidgets.js?checkoutId=${checkoutId}`,
    });
  } catch (err) {
    logger.error({ err }, 'peach initiate');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /payments/peach/notify — Peach result URL handler
router.post('/peach/notify', async (req: Request, res: Response) => {
  try {
    const { resourcePath, merchantTransactionId } = req.body as { resourcePath?: string; merchantTransactionId?: string };
    if (!resourcePath && !merchantTransactionId) {
      res.status(200).send('OK');
      return;
    }

    const orderId = merchantTransactionId;
    if (orderId && PEACH_ACCESS_TOKEN) {
      // Fetch payment status from Peach
      const path = resourcePath ?? `/v1/query/${orderId}?entityId=${PEACH_ENTITY_ID}`;
      const statusData = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const options = {
          hostname: PEACH_BASE.replace('https://', ''),
          path: `${path}?entityId=${PEACH_ENTITY_ID}`,
          method: 'GET',
          headers: { Authorization: `Bearer ${PEACH_ACCESS_TOKEN}` },
        };
        const r = https.request(options, (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => { try { resolve(JSON.parse(data) as Record<string, unknown>); } catch { reject(new Error(data)); } });
        });
        r.on('error', reject);
        r.end();
      });

      const resultCode = (statusData.result as { code?: string })?.code ?? '';
      // Success codes per Peach docs: /^(000\.000\.|000\.100\.1|000\.[36])/
      if (/^(000\.000\.|000\.100\.1|000\.[36])/.test(resultCode)) {
        await pool.query(
          `UPDATE orders SET payment_status='paid', status='confirmed', confirmed_at=NOW() WHERE id=$1`,
          [orderId]
        );
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    logger.error({ err }, 'peach notify');
    res.status(500).send('error');
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
