import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireDriver, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import { sendPushToUser } from '../utils/push';

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapDriver(row: Record<string, unknown>) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    profileImage: row.profile_image ?? null,
    vehicleType: row.vehicle_type,
    vehicleMake: row.vehicle_make,
    vehicleReg: row.vehicle_reg,
    isOnline: row.is_online,
    rating: parseFloat(String(row.rating ?? '0')),
    reviewCount: Number(row.review_count ?? 0),
    totalTrips: Number(row.total_trips ?? 0),
    completionRate: parseFloat(String(row.completion_rate ?? '100')),
    acceptanceRate: parseFloat(String(row.acceptance_rate ?? '100')),
    walletBalance: parseFloat(String(row.wallet_balance ?? '0')),
    bankName: row.bank_name ?? null,
    bankAccountNo: row.bank_account_no ?? null,
    bankAccountType: row.bank_account_type ?? null,
    bankHolderName: row.bank_holder_name ?? null,
  };
}

async function ensureDriverProfile(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO drivers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [userId]
  );
}

async function notifyCustomer(orderId: string, title: string, body: string, type: string) {
  try {
    const row = await pool.query('SELECT user_id FROM orders WHERE id=$1', [orderId]);
    if (!row.rows.length) return;
    const customerId = row.rows[0].user_id as string;
    void sendPushToUser(customerId, title, body, { type, orderId });
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [customerId, type, title, body, JSON.stringify({ orderId })]
    );
  } catch {
    // non-fatal
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

// GET /drivers/me
router.get('/me', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    await ensureDriverProfile(req.userId!);
    const result = await pool.query(
      `SELECT u.first_name, u.last_name, u.email, u.phone, u.profile_image,
              d.*
       FROM drivers d
       JOIN users u ON u.id = d.id
       WHERE d.id = $1`,
      [req.userId]
    );
    ok(res, mapDriver(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'GET /drivers/me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /drivers/me
router.put('/me', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleType, vehicleMake, vehicleReg, bankName, bankAccountNo, bankAccountType, bankHolderName } = req.body;
    await ensureDriverProfile(req.userId!);
    const result = await pool.query(
      `UPDATE drivers SET
         vehicle_type      = COALESCE($1, vehicle_type),
         vehicle_make      = COALESCE($2, vehicle_make),
         vehicle_reg       = COALESCE($3, vehicle_reg),
         bank_name         = COALESCE($4, bank_name),
         bank_account_no   = COALESCE($5, bank_account_no),
         bank_account_type = COALESCE($6, bank_account_type),
         bank_holder_name  = COALESCE($7, bank_holder_name)
       WHERE id = $8
       RETURNING *`,
      [vehicleType, vehicleMake, vehicleReg, bankName, bankAccountNo, bankAccountType, bankHolderName, req.userId]
    );
    const userRow = await pool.query('SELECT first_name, last_name, email, phone, profile_image FROM users WHERE id=$1', [req.userId]);
    ok(res, mapDriver({ ...userRow.rows[0], ...result.rows[0] }));
  } catch (err) {
    logger.error({ err }, 'PUT /drivers/me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/status
router.post('/status', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const { online, lat, lng } = req.body;
    if (typeof online !== 'boolean') {
      fail(res, 400, 'VALIDATION_ERROR', 'online (boolean) is required.');
      return;
    }
    await ensureDriverProfile(req.userId!);
    await pool.query(
      `UPDATE drivers SET is_online=$1, location_lat=$2, location_lng=$3 WHERE id=$4`,
      [online, lat ?? null, lng ?? null, req.userId]
    );
    ok(res, { online, lat: lat ?? null, lng: lng ?? null });
  } catch (err) {
    logger.error({ err }, 'POST /drivers/status');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /drivers/location — called periodically while driver is online
router.put('/location', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) {
      fail(res, 400, 'VALIDATION_ERROR', 'lat and lng are required.');
      return;
    }
    await pool.query(
      `UPDATE drivers SET location_lat=$1, location_lng=$2 WHERE id=$3`,
      [lat, lng, req.userId]
    );
    ok(res, { lat, lng });
  } catch (err) {
    logger.error({ err }, 'PUT /drivers/location');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────

// GET /drivers/stats/today
router.get('/stats/today', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    await ensureDriverProfile(req.userId!);
    const [earningsRes, driverRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS earnings, COUNT(*) AS trips
         FROM driver_transactions
         WHERE driver_id=$1 AND type='earning' AND created_at >= CURRENT_DATE`,
        [req.userId]
      ),
      pool.query('SELECT acceptance_rate FROM drivers WHERE id=$1', [req.userId]),
    ]);
    ok(res, {
      earnings: parseFloat(String(earningsRes.rows[0].earnings ?? '0')),
      trips: Number(earningsRes.rows[0].trips ?? 0),
      acceptanceRate: parseFloat(String(driverRes.rows[0]?.acceptance_rate ?? '100')),
    });
  } catch (err) {
    logger.error({ err }, 'GET /drivers/stats/today');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Delivery dispatch ────────────────────────────────────────────────────────

// GET /drivers/deliveries/available
router.get('/deliveries/available', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.delivery_fee, o.subtotal,
              r.name AS restaurant_name, r.address AS restaurant_address,
              ua.street AS customer_street, ua.suburb AS customer_suburb,
              ua.city AS customer_city,
              u.first_name AS customer_first_name, u.last_name AS customer_last_name,
              u.phone AS customer_phone,
              (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) AS item_count
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN user_addresses ua ON ua.id = o.delivery_address_id
       JOIN users u ON u.id = o.user_id
       WHERE o.driver_id IS NULL
         AND o.status IN ('placed','confirmed')
         AND NOT EXISTS (
           SELECT 1 FROM driver_assignments da
           WHERE da.order_id = o.id AND da.driver_id = $1
         )
       ORDER BY o.created_at ASC
       LIMIT 1`,
      [req.userId]
    );
    if (!result.rows.length) {
      ok(res, null);
      return;
    }
    const row = result.rows[0];
    const payout = Math.round(parseFloat(String(row.delivery_fee)) * 0.80 * 100) / 100;
    const addrParts = [row.customer_street, row.customer_suburb, row.customer_city].filter(Boolean);
    ok(res, {
      orderId: row.id,
      restaurantName: row.restaurant_name,
      restaurantAddress: row.restaurant_address ?? '',
      customerName: `${row.customer_first_name} ${row.customer_last_name}`.trim(),
      customerAddress: addrParts.join(', '),
      customerPhone: row.customer_phone,
      itemCount: Number(row.item_count ?? 0),
      payout,
      etaMinutes: 20,
    });
  } catch (err) {
    logger.error({ err }, 'GET /drivers/deliveries/available');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /drivers/deliveries/active
router.get('/deliveries/active', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.status, o.delivery_fee,
              r.name AS restaurant_name, r.logo AS restaurant_logo,
              r.address AS restaurant_address,
              r.latitude AS restaurant_lat, r.longitude AS restaurant_lng,
              ua.street AS dest_street, ua.suburb AS dest_suburb, ua.city AS dest_city,
              ua.latitude AS dest_lat, ua.longitude AS dest_lng,
              u.first_name AS customer_first_name, u.last_name AS customer_last_name,
              u.phone AS customer_phone,
              o.delivery_notes,
              da.payout, da.picked_up_at,
              (SELECT json_agg(json_build_object('name', mi.name, 'quantity', oi.quantity))
               FROM order_items oi JOIN menu_items mi ON mi.id=oi.menu_item_id
               WHERE oi.order_id=o.id) AS items
       FROM orders o
       JOIN driver_assignments da ON da.order_id=o.id AND da.driver_id=$1
       JOIN restaurants r ON r.id=o.restaurant_id
       LEFT JOIN user_addresses ua ON ua.id=o.delivery_address_id
       JOIN users u ON u.id=o.user_id
       WHERE o.driver_id=$1 AND o.status NOT IN ('delivered','cancelled')
       ORDER BY da.accepted_at DESC
       LIMIT 1`,
      [req.userId]
    );
    if (!result.rows.length) {
      ok(res, null);
      return;
    }
    const row = result.rows[0];
    const addrParts = [row.dest_street, row.dest_suburb, row.dest_city].filter(Boolean);
    ok(res, {
      orderId: row.id,
      status: row.status,
      restaurantName: row.restaurant_name,
      restaurantAddress: row.restaurant_address ?? '',
      restaurantLat: row.restaurant_lat != null ? parseFloat(row.restaurant_lat) : null,
      restaurantLng: row.restaurant_lng != null ? parseFloat(row.restaurant_lng) : null,
      customerName: `${row.customer_first_name} ${row.customer_last_name}`.trim(),
      customerAddress: addrParts.join(', '),
      customerPhone: row.customer_phone,
      destLat: row.dest_lat != null ? parseFloat(row.dest_lat) : null,
      destLng: row.dest_lng != null ? parseFloat(row.dest_lng) : null,
      deliveryNotes: row.delivery_notes ?? null,
      items: row.items ?? [],
      payout: parseFloat(String(row.payout ?? '0')),
      pickedUpAt: row.picked_up_at ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'GET /drivers/deliveries/active');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/deliveries/:id/accept
router.post('/deliveries/:id/accept', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = req.params.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderRes = await client.query(
        `SELECT id, delivery_fee, status FROM orders WHERE id=$1 AND driver_id IS NULL AND status IN ('placed','confirmed') FOR UPDATE`,
        [orderId]
      );
      if (!orderRes.rows.length) {
        await client.query('ROLLBACK');
        fail(res, 409, 'CONFLICT', 'Order is no longer available.');
        return;
      }

      const payout = Math.round(parseFloat(String(orderRes.rows[0].delivery_fee)) * 0.80 * 100) / 100;

      await client.query(
        `UPDATE orders SET driver_id=$1, status='confirmed' WHERE id=$2`,
        [req.userId, orderId]
      );
      await client.query(
        `INSERT INTO driver_assignments (driver_id, order_id, payout) VALUES ($1,$2,$3)`,
        [req.userId, orderId, payout]
      );
      await client.query(
        `INSERT INTO driver_transactions (driver_id, type, amount, description, order_id) VALUES ($1,'earning',$2,'Delivery payout',$3)`,
        [req.userId, payout, orderId]
      );

      await client.query('COMMIT');
      ok(res, { orderId, payout });
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }

    void notifyCustomer(orderId, 'Driver Assigned', 'A driver is on the way to pick up your order.', 'order_update');
  } catch (err) {
    logger.error({ err }, 'POST /drivers/deliveries/:id/accept');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/deliveries/:id/reject
router.post('/deliveries/:id/reject', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = req.params.id;
    await pool.query(
      `INSERT INTO driver_assignments (driver_id, order_id, payout, status)
       VALUES ($1, $2, 0, 'rejected')
       ON CONFLICT DO NOTHING`,
      [req.userId, orderId]
    );
    ok(res, { rejected: true });
  } catch (err) {
    logger.error({ err }, 'POST /drivers/deliveries/:id/reject');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/deliveries/:id/pickup
router.post('/deliveries/:id/pickup', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = req.params.id;
    const [, assignRes] = await Promise.all([
      pool.query(
        `UPDATE orders SET status='picked_up' WHERE id=$1 AND driver_id=$2 AND status='confirmed'`,
        [orderId, req.userId]
      ),
      pool.query(
        `UPDATE driver_assignments SET picked_up_at=NOW() WHERE order_id=$1 AND driver_id=$2 RETURNING *`,
        [orderId, req.userId]
      ),
    ]);
    if (!assignRes.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Active delivery not found.');
      return;
    }
    ok(res, { orderId, pickedUpAt: assignRes.rows[0].picked_up_at });

    void notifyCustomer(orderId, 'Order Picked Up', 'Your order is on the way! Estimated arrival in ~20 minutes.', 'order_update');
  } catch (err) {
    logger.error({ err }, 'POST /drivers/deliveries/:id/pickup');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/deliveries/:id/complete
router.post('/deliveries/:id/complete', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = req.params.id;
    const { photoBase64 } = req.body as { photoBase64?: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const assignRes = await client.query(
        `UPDATE driver_assignments
         SET delivered_at=NOW(), status='delivered',
             delivery_photo=COALESCE($3, delivery_photo)
         WHERE order_id=$1 AND driver_id=$2
         RETURNING payout`,
        [orderId, req.userId, photoBase64 ?? null]
      );
      if (!assignRes.rows.length) {
        await client.query('ROLLBACK');
        fail(res, 404, 'NOT_FOUND', 'Active delivery not found.');
        return;
      }
      const payout = parseFloat(String(assignRes.rows[0].payout));

      const orderRes = await client.query(
        `UPDATE orders SET status='delivered', status_updated_at=NOW() WHERE id=$1 AND driver_id=$2 RETURNING user_id, total`,
        [orderId, req.userId]
      );
      await client.query(
        `UPDATE drivers SET wallet_balance=wallet_balance+$1, total_trips=total_trips+1 WHERE id=$2`,
        [payout, req.userId]
      );

      // Award loyalty points to customer: 1 pt per R10 spent
      if (orderRes.rows.length) {
        const { user_id: customerId, total } = orderRes.rows[0] as { user_id: string; total: string };
        const points = Math.floor(parseFloat(total) / 10);
        if (points > 0) {
          await client.query(
            `INSERT INTO loyalty_transactions (user_id, order_id, points, type, description)
             VALUES ($1, $2, $3, 'earned', $4)`,
            [customerId, orderId, points, `Order #${orderId.slice(-6).toUpperCase()}`]
          );
          await client.query(
            `UPDATE users SET loyalty_points_balance = loyalty_points_balance + $1 WHERE id = $2`,
            [points, customerId]
          );
        }
      }

      await client.query('COMMIT');
      ok(res, { orderId, payout });
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }

    void notifyCustomer(orderId, 'Order Delivered!', 'Your order has been delivered. Enjoy your meal! Tap to rate.', 'order_delivered');
  } catch (err) {
    logger.error({ err }, 'POST /drivers/deliveries/:id/complete');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /drivers/deliveries/history
router.get('/deliveries/history', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT o.id, r.name AS restaurant_name, r.logo AS restaurant_logo,
              da.payout, da.delivered_at
       FROM driver_assignments da
       JOIN orders o ON o.id=da.order_id
       JOIN restaurants r ON r.id=o.restaurant_id
       WHERE da.driver_id=$1 AND da.status='delivered'
       ORDER BY da.delivered_at DESC
       LIMIT 20`,
      [req.userId]
    );
    ok(res, result.rows.map((row) => ({
      orderId: row.id,
      restaurantName: row.restaurant_name,
      restaurantLogo: row.restaurant_logo,
      payout: parseFloat(String(row.payout ?? '0')),
      deliveredAt: row.delivered_at,
    })));
  } catch (err) {
    logger.error({ err }, 'GET /drivers/deliveries/history');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Earnings ─────────────────────────────────────────────────────────────────

// GET /drivers/earnings?period=today|week|month
router.get('/earnings', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const period = (req.query.period as string) ?? 'today';
    let since: string;
    if (period === 'today') since = 'CURRENT_DATE';
    else if (period === 'week') since = "date_trunc('week', NOW())";
    else since = "date_trunc('month', NOW())";

    const result = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS trips
       FROM driver_transactions
       WHERE driver_id=$1 AND type='earning' AND created_at >= ${since}`,
      [req.userId]
    );
    const trips = Number(result.rows[0].trips ?? 0);
    ok(res, {
      period,
      totalEarnings: parseFloat(String(result.rows[0].total ?? '0')),
      tripCount: trips,
      hoursWorked: Math.round((trips * 25) / 60 * 10) / 10,
    });
  } catch (err) {
    logger.error({ err }, 'GET /drivers/earnings');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /drivers/earnings/breakdown
router.get('/earnings/breakdown', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT TO_CHAR(created_at, 'Dy') AS day,
              EXTRACT(DOW FROM created_at) AS dow,
              COUNT(*) AS trips,
              COALESCE(SUM(amount), 0) AS earnings
       FROM driver_transactions
       WHERE driver_id=$1 AND type='earning'
         AND created_at >= date_trunc('week', NOW())
       GROUP BY TO_CHAR(created_at, 'Dy'), EXTRACT(DOW FROM created_at)
       ORDER BY EXTRACT(DOW FROM created_at)`,
      [req.userId]
    );
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dataMap: Record<string, { trips: number; earnings: number }> = {};
    for (const row of result.rows) {
      dataMap[row.day as string] = {
        trips: Number(row.trips ?? 0),
        earnings: parseFloat(String(row.earnings ?? '0')),
      };
    }
    ok(res, DAYS.map((day) => ({
      day,
      trips: dataMap[day]?.trips ?? 0,
      earnings: dataMap[day]?.earnings ?? 0,
    })));
  } catch (err) {
    logger.error({ err }, 'GET /drivers/earnings/breakdown');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Wallet ───────────────────────────────────────────────────────────────────

// GET /drivers/wallet
router.get('/wallet', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    await ensureDriverProfile(req.userId!);
    const [driverRes, txRes] = await Promise.all([
      pool.query(
        'SELECT wallet_balance, bank_name, bank_account_no, bank_account_type, bank_holder_name FROM drivers WHERE id=$1',
        [req.userId]
      ),
      pool.query(
        `SELECT id, type, amount, description, order_id, created_at
         FROM driver_transactions WHERE driver_id=$1
         ORDER BY created_at DESC LIMIT 10`,
        [req.userId]
      ),
    ]);
    const d = driverRes.rows[0];
    ok(res, {
      balance: parseFloat(String(d?.wallet_balance ?? '0')),
      bankAccount: d?.bank_name ? {
        bankName: d.bank_name,
        accountNo: d.bank_account_no,
        accountType: d.bank_account_type,
        holderName: d.bank_holder_name,
      } : null,
      transactions: txRes.rows.map((t) => ({
        id: t.id,
        type: t.type,
        amount: parseFloat(String(t.amount)),
        description: t.description,
        orderId: t.order_id,
        createdAt: t.created_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'GET /drivers/wallet');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/wallet/withdraw
router.post('/wallet/withdraw', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const { amount } = req.body;
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      fail(res, 400, 'VALIDATION_ERROR', 'amount must be a positive number.');
      return;
    }

    const driverRes = await pool.query('SELECT wallet_balance FROM drivers WHERE id=$1', [req.userId]);
    const balance = parseFloat(String(driverRes.rows[0]?.wallet_balance ?? '0'));

    if (amount > balance) {
      fail(res, 400, 'INSUFFICIENT_FUNDS', `Insufficient balance. Available: R${balance.toFixed(2)}.`);
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE drivers SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
        [amount, req.userId]
      );
      await client.query(
        `INSERT INTO withdrawal_requests (driver_id, amount, status) VALUES ($1,$2,'pending')`,
        [req.userId, amount]
      );
      await client.query(
        `INSERT INTO driver_transactions (driver_id, type, amount, description) VALUES ($1,'withdrawal',$2,'Bank withdrawal request')`,
        [req.userId, amount]
      );
      await client.query('COMMIT');
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }

    const newBalance = balance - amount;
    ok(res, {
      success: true,
      newBalance,
      message: 'Withdrawal requested. Funds will be processed within 2–3 business days.',
    });
  } catch (err) {
    logger.error({ err }, 'POST /drivers/wallet/withdraw');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Driver Documents ─────────────────────────────────────────────────────────

// GET /drivers/documents
router.get('/documents', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, type, reference_no, expiry_date, status, created_at
       FROM driver_documents WHERE driver_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
    ok(res, result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      referenceNo: r.reference_no,
      expiryDate: r.expiry_date,
      status: r.status,
      createdAt: r.created_at,
    })));
  } catch (err) {
    logger.error({ err }, 'GET /drivers/documents');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /drivers/documents
router.post('/documents', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const { type, referenceNo, expiryDate } = req.body as { type?: string; referenceNo?: string; expiryDate?: string };
    const VALID = ["Driver's Licence", 'ID Document', 'Vehicle Licence Disc', 'PDP Certificate', 'Insurance Certificate'];
    if (!type || !VALID.includes(type)) { fail(res, 400, 'VALIDATION_ERROR', 'Invalid document type.'); return; }
    if (!referenceNo?.trim())           { fail(res, 400, 'VALIDATION_ERROR', 'Reference number required.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate ?? '')) { fail(res, 400, 'VALIDATION_ERROR', 'Expiry must be YYYY-MM-DD.'); return; }
    const r = (await pool.query(
      `INSERT INTO driver_documents (driver_id, type, reference_no, expiry_date)
       VALUES ($1,$2,$3,$4) RETURNING id, type, reference_no, expiry_date, status, created_at`,
      [req.userId, type, referenceNo.trim(), expiryDate]
    )).rows[0];
    ok(res, {
      id: r.id, type: r.type, referenceNo: r.reference_no,
      expiryDate: r.expiry_date, status: r.status, createdAt: r.created_at,
    }, undefined, 201);
  } catch (err) {
    logger.error({ err }, 'POST /drivers/documents');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// DELETE /drivers/documents/:docId
router.delete('/documents/:docId', requireDriver, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `DELETE FROM driver_documents WHERE id=$1 AND driver_id=$2 RETURNING id`,
      [req.params.docId, req.userId]
    );
    if (!result.rows.length) { fail(res, 404, 'NOT_FOUND', 'Document not found.'); return; }
    ok(res, { deleted: true });
  } catch (err) {
    logger.error({ err }, 'DELETE /drivers/documents/:docId');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
