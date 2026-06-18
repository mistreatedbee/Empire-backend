import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import { sendPushToUser } from '../utils/push';

const router = Router();

async function insertNotification(userId: string, type: string, title: string, body: string, data: Record<string, unknown> = {}) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, title, body, JSON.stringify(data)]
    );
  } catch {
    // non-fatal
  }
}

// POST /orders
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { restaurantId, items, deliveryAddressId, paymentMethod, couponCode, deliveryNotes, loyaltyPointsToRedeem: rawLoyaltyPts } = req.body;

    if (!restaurantId || !items?.length || !deliveryAddressId || !paymentMethod) {
      fail(res, 400, 'VALIDATION_ERROR', 'restaurantId, items, deliveryAddressId and paymentMethod are required.');
      return;
    }

    const client = await pool.connect();
    try {
      // Verify restaurant exists
      const restRow = await client.query('SELECT id, name, delivery_fee FROM restaurants WHERE id=$1', [restaurantId]);
      if (!restRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Restaurant not found.');
        return;
      }
      const deliveryFee = parseFloat(restRow.rows[0].delivery_fee);
      const restaurantName = restRow.rows[0].name as string;

      // Verify address belongs to user
      const addrRow = await client.query(
        'SELECT id FROM user_addresses WHERE id=$1 AND user_id=$2',
        [deliveryAddressId, req.userId]
      );
      if (!addrRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Delivery address not found.');
        return;
      }

      // Resolve menu item prices
      let subtotal = 0;
      const resolvedItems: { menuItemId: string; quantity: number; unitPrice: number; addonIds: string[]; instructions?: string }[] = [];

      for (const item of items as { menuItemId: string; quantity: number; addonIds?: string[]; instructions?: string }[]) {
        const itemRow = await client.query(
          'SELECT id, price FROM menu_items WHERE id=$1 AND restaurant_id=$2 AND is_available=true',
          [item.menuItemId, restaurantId]
        );
        if (!itemRow.rows.length) {
          fail(res, 400, 'VALIDATION_ERROR', `Menu item ${item.menuItemId} not found or unavailable.`);
          return;
        }
        let unitPrice = parseFloat(itemRow.rows[0].price);

        // Add addon prices
        if (item.addonIds?.length) {
          const addonRows = await client.query(
            'SELECT price FROM addons WHERE id = ANY($1)',
            [item.addonIds]
          );
          for (const a of addonRows.rows) unitPrice += parseFloat(a.price);
        }

        subtotal += unitPrice * item.quantity;
        resolvedItems.push({ menuItemId: item.menuItemId, quantity: item.quantity, unitPrice, addonIds: item.addonIds ?? [], instructions: item.instructions });
      }

      const serviceFee = Math.round(subtotal * 0.05 * 100) / 100;
      let discount = 0;
      if (couponCode) {
        const couponRow = await client.query(
          `SELECT discount_type, discount_value, max_discount, min_order, is_active, expires_at, max_uses, uses_count
           FROM coupons WHERE code = $1`,
          [(couponCode as string).trim().toUpperCase()]
        );
        const c = couponRow.rows[0];
        if (
          c && c.is_active &&
          (!c.expires_at || new Date(c.expires_at) >= new Date()) &&
          (c.max_uses === null || c.uses_count < c.max_uses) &&
          subtotal >= parseFloat(c.min_order)
        ) {
          discount = c.discount_type === 'percentage'
            ? Math.min(subtotal * parseFloat(c.discount_value) / 100, c.max_discount ? parseFloat(c.max_discount) : Infinity)
            : parseFloat(c.discount_value);
          discount = Math.round(discount * 100) / 100;
          await client.query(
            'UPDATE coupons SET uses_count = uses_count + 1 WHERE code = $1',
            [(couponCode as string).trim().toUpperCase()]
          );
        }
      }
      // Loyalty redemption (must be multiple of 100)
      const loyaltyPts = typeof rawLoyaltyPts === 'number' ? Math.floor(rawLoyaltyPts / 100) * 100 : 0;
      let loyaltyDiscount = 0;
      if (loyaltyPts > 0) {
        const balRes = await client.query(
          `SELECT loyalty_points_balance FROM users WHERE id=$1 FOR UPDATE`,
          [req.userId]
        );
        const balance: number = balRes.rows[0]?.loyalty_points_balance ?? 0;
        if (loyaltyPts > balance) {
          await client.query('ROLLBACK');
          fail(res, 400, 'INSUFFICIENT_POINTS', 'Not enough loyalty points.');
          return;
        }
        loyaltyDiscount = (loyaltyPts / 100) * 10;
      }

      const total = Math.max(0, subtotal + deliveryFee + serviceFee - discount - loyaltyDiscount);

      const paymentStatus = paymentMethod === 'cash' ? 'pending_cod' : 'pending';

      const orderRow = await client.query(`
        INSERT INTO orders (user_id, restaurant_id, status, subtotal, delivery_fee, service_fee, discount, total,
          payment_method, payment_status, coupon_code, delivery_address_id, delivery_notes, loyalty_points_redeemed)
        VALUES ($1,$2,'placed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *
      `, [req.userId, restaurantId, subtotal, deliveryFee, serviceFee, discount, total,
          paymentMethod, paymentStatus, couponCode ?? null, deliveryAddressId, deliveryNotes ?? null, loyaltyPts]);

      const orderId = orderRow.rows[0].id as string;
      for (const item of resolvedItems) {
        await client.query(`
          INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, addon_ids, instructions)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [orderId, item.menuItemId, item.quantity, item.unitPrice, JSON.stringify(item.addonIds), item.instructions ?? null]);
      }

      // Deduct loyalty points inside transaction
      if (loyaltyPts > 0) {
        await client.query(
          `UPDATE users SET loyalty_points_balance = loyalty_points_balance - $1 WHERE id = $2`,
          [loyaltyPts, req.userId]
        );
        await client.query(
          `INSERT INTO loyalty_transactions (user_id, order_id, points, type, description)
           VALUES ($1, $2, $3, 'redeemed', $4)`,
          [req.userId, orderId, -loyaltyPts, `Redeemed on order #${orderId.slice(-6).toUpperCase()}`]
        );
      }

      const order = await fetchOrderDetail(client, orderId);
      ok(res, order, undefined, 201);

      // Push notification (fire-and-forget after response)
      const title = 'Order Placed!';
      const body = `Your order from ${restaurantName} has been placed and is awaiting confirmation.`;
      void sendPushToUser(req.userId!, title, body, { type: 'order_update', orderId });
      void insertNotification(req.userId!, 'order_placed', title, body, { orderId });
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'create order');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /orders
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as { status?: string };
    let sql = `
      SELECT o.*, r.name AS restaurant_name, r.logo AS restaurant_logo,
             r.cover_image AS restaurant_cover
      FROM orders o
      JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.user_id = $1
    `;
    const params: unknown[] = [req.userId];
    if (status) {
      params.push(status);
      sql += ` AND o.status = $${params.length}`;
    }
    sql += ' ORDER BY o.placed_at DESC';
    const result = await pool.query(sql, params);
    ok(res, result.rows.map(mapOrderRow));
  } catch (err) {
    logger.error({ err }, 'list orders');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /orders/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await pool.connect();
    try {
      const orderRow = await client.query(
        'SELECT id FROM orders WHERE id=$1 AND user_id=$2',
        [req.params.id, req.userId]
      );
      if (!orderRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Order not found.');
        return;
      }
      const order = await fetchOrderDetail(client, req.params.id);
      ok(res, order);
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'order detail');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

async function getTrackingData(orderId: string, userId: string) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.placed_at,
            d.location_lat, d.location_lng, d.rating AS driver_rating, d.vehicle_type,
            u.first_name || ' ' || u.last_name AS driver_name, u.phone AS driver_phone,
            da.accepted_at, da.picked_up_at
     FROM orders o
     LEFT JOIN driver_assignments da ON da.order_id = o.id
     LEFT JOIN drivers d ON d.id = da.driver_id
     LEFT JOIN users u ON u.id = da.driver_id
     WHERE o.id = $1 AND o.user_id = $2`,
    [orderId, userId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const etaMinutes = computeEta(
    row.status as string,
    row.accepted_at as Date | null,
    row.picked_up_at as Date | null
  );
  return {
    status: row.status,
    etaMinutes,
    driver: row.driver_name ? {
      name: row.driver_name,
      phone: row.driver_phone,
      rating: parseFloat(String(row.driver_rating ?? '0')),
      vehicleType: row.vehicle_type,
      lat: row.location_lat ? parseFloat(String(row.location_lat)) : null,
      lng: row.location_lng ? parseFloat(String(row.location_lng)) : null,
    } : null,
  };
}

// GET /orders/:id/tracking
router.get('/:id/tracking', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const data = await getTrackingData(req.params.id, req.userId!);
    if (!data) { fail(res, 404, 'NOT_FOUND', 'Order not found.'); return; }
    ok(res, data);
  } catch (err) {
    logger.error({ err }, 'tracking');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /orders/:id/tracking/stream — SSE real-time tracking
router.get('/:id/tracking/stream', requireAuth, (req: AuthRequest, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // for Nginx proxies
  res.flushHeaders();

  const send = async () => {
    try {
      const data = await getTrackingData(req.params.id, req.userId!);
      if (data) res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch { /* skip on transient errors */ }
  };

  void send();
  const interval = setInterval(() => { void send(); }, 4000);
  req.on('close', () => clearInterval(interval));
});

function computeEta(status: string, acceptedAt: Date | null, pickedUpAt: Date | null): number {
  const now = Date.now();
  if (status === 'delivered') return 0;
  if (status === 'picked_up' && pickedUpAt) {
    const elapsed = (now - new Date(pickedUpAt).getTime()) / 60000;
    return Math.max(0, Math.round(20 - elapsed));
  }
  if (status === 'confirmed' && acceptedAt) {
    const elapsed = (now - new Date(acceptedAt).getTime()) / 60000;
    return Math.max(0, Math.round(35 - elapsed));
  }
  return 40;
}

// POST /orders/:id/cancel
router.post('/:id/cancel', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `UPDATE orders SET status='cancelled' WHERE id=$1 AND user_id=$2
       AND status IN ('placed','confirmed') RETURNING *`,
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      fail(res, 400, 'CANNOT_CANCEL', 'Order cannot be cancelled at this stage.');
      return;
    }
    ok(res, mapOrderRow(result.rows[0]));

    const orderId = req.params.id;
    const title = 'Order Cancelled';
    const body = 'Your order has been cancelled.';
    void sendPushToUser(req.userId!, title, body, { type: 'order_update', orderId });
    void insertNotification(req.userId!, 'order_cancelled', title, body, { orderId });
  } catch (err) {
    logger.error({ err }, 'cancel order');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /orders/:id/rate
router.post('/:id/rate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      fail(res, 400, 'VALIDATION_ERROR', 'rating must be between 1 and 5.');
      return;
    }
    const client = await pool.connect();
    try {
      const orderRow = await client.query(
        'SELECT id, restaurant_id FROM orders WHERE id=$1 AND user_id=$2 AND status=$3',
        [req.params.id, req.userId, 'delivered']
      );
      if (!orderRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Delivered order not found.');
        return;
      }
      const restaurantId = orderRow.rows[0].restaurant_id as string;

      await client.query(`
        INSERT INTO restaurant_reviews (user_id, restaurant_id, order_id, rating, review)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (order_id) DO UPDATE SET rating=$4, review=$5
      `, [req.userId, restaurantId, req.params.id, rating, review ?? null]);

      // Recalculate restaurant average rating
      await client.query(`
        UPDATE restaurants
        SET rating = (SELECT ROUND(AVG(rating)::NUMERIC, 2) FROM restaurant_reviews WHERE restaurant_id=$1),
            review_count = (SELECT COUNT(*) FROM restaurant_reviews WHERE restaurant_id=$1)
        WHERE id=$1
      `, [restaurantId]);

      ok(res, null);
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'rate order');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

async function fetchOrderDetail(client: import('pg').PoolClient, orderId: string) {
  const [orderRes, itemsRes] = await Promise.all([
    client.query(`
      SELECT o.*, r.name AS restaurant_name, r.logo AS restaurant_logo, r.cover_image AS restaurant_cover,
             ua.label AS addr_label, ua.street AS addr_street, ua.suburb AS addr_suburb,
             ua.city AS addr_city, ua.province AS addr_province
      FROM orders o
      JOIN restaurants r ON r.id = o.restaurant_id
      LEFT JOIN user_addresses ua ON ua.id = o.delivery_address_id
      WHERE o.id = $1
    `, [orderId]),
    client.query(`
      SELECT oi.*, mi.name AS item_name, mi.image AS item_image
      FROM order_items oi
      JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = $1
    `, [orderId]),
  ]);

  const o = orderRes.rows[0];
  return {
    ...mapOrderRow(o),
    deliveryAddress: o.addr_street ? {
      label: o.addr_label,
      street: o.addr_street,
      suburb: o.addr_suburb,
      city: o.addr_city,
      province: o.addr_province,
    } : null,
    items: itemsRes.rows.map((i) => ({
      id: i.id,
      name: i.item_name,
      image: i.item_image,
      quantity: i.quantity,
      unitPrice: parseFloat(i.unit_price),
      addonIds: i.addon_ids,
      instructions: i.instructions,
    })),
  };
}

function mapOrderRow(o: Record<string, unknown>) {
  return {
    id: o.id,
    status: o.status,
    restaurantId: o.restaurant_id,
    subtotal: parseFloat(o.subtotal as string),
    deliveryFee: parseFloat(o.delivery_fee as string),
    serviceFee: parseFloat(o.service_fee as string),
    discount: parseFloat(o.discount as string),
    total: parseFloat(o.total as string),
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    couponCode: o.coupon_code,
    deliveryNotes: o.delivery_notes,
    placedAt: o.placed_at,
    confirmedAt: o.confirmed_at,
    restaurant: {
      name: o.restaurant_name,
      logo: o.restaurant_logo,
      coverImage: o.restaurant_cover,
    },
  };
}

export default router;
