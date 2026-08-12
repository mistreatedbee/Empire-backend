import { distanceKmBetween, isValidCoord, parseCoord } from '../utils/distance';
import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import { sendPushToUser } from '../utils/push';
import { quoteOrder } from '../utils/orderPricing';
import { notifyOrderDispatchable, notifyRestaurantNewOrder } from '../utils/orderNotifications';

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

// POST /orders/quote — transparent pricing before checkout
router.post('/quote', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const {
      restaurantId,
      items,
      deliveryAddressId,
      couponCode,
      loyaltyPointsToRedeem,
      deliveryLatitude,
      deliveryLongitude,
      restaurantLatitude,
      restaurantLongitude,
    } = req.body as {
      restaurantId?: string;
      items?: Array<{ menuItemId: string; quantity: number; addonIds?: string[] }>;
      deliveryAddressId?: string;
      couponCode?: string;
      loyaltyPointsToRedeem?: number;
      deliveryLatitude?: number;
      deliveryLongitude?: number;
      restaurantLatitude?: number;
      restaurantLongitude?: number;
    };

    if (!restaurantId || !items?.length) {
      fail(res, 400, 'VALIDATION_ERROR', 'restaurantId and items are required.');
      return;
    }

    const restRow = await pool.query('SELECT id FROM restaurants WHERE id=$1', [restaurantId]);
    if (!restRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Restaurant not found.');
      return;
    }

    if (deliveryAddressId) {
      const addrRow = await pool.query(
        'SELECT id FROM user_addresses WHERE id=$1 AND user_id=$2',
        [deliveryAddressId, req.userId],
      );
      if (!addrRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Delivery address not found.');
        return;
      }
    }

    const quote = await quoteOrder(pool, {
      restaurantId,
      items,
      deliveryAddressId,
      userId: req.userId,
      couponCode,
      loyaltyPointsToRedeem,
      deliveryLatitude,
      deliveryLongitude,
      restaurantLatitude,
      restaurantLongitude,
    });

    ok(res, {
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      serviceFee: quote.serviceFee,
      smallOrderFee: quote.smallOrderFee,
      discount: quote.discount,
      loyaltyDiscount: quote.loyaltyDiscount,
      total: quote.total,
      distanceKm: quote.distanceKm,
      estimatedDeliveryMinutes: quote.estimatedDeliveryMinutes,
      breakdown: quote.breakdown,
      driverPayout: quote.driverPayout,
      addressRequired: !deliveryAddressId,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      fail(res, 400, 'VALIDATION_ERROR', err.message);
      return;
    }
    logger.error({ err }, 'order quote');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /orders
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const {
      restaurantId,
      items,
      deliveryAddressId,
      paymentMethod,
      couponCode,
      deliveryNotes,
      loyaltyPointsToRedeem: rawLoyaltyPts,
      deliveryLatitude,
      deliveryLongitude,
      restaurantLatitude,
      restaurantLongitude,
    } = req.body;

    if (!restaurantId || !items?.length || !deliveryAddressId || !paymentMethod) {
      fail(res, 400, 'VALIDATION_ERROR', 'restaurantId, items, deliveryAddressId and paymentMethod are required.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const restRow = await client.query('SELECT id, name FROM restaurants WHERE id=$1', [restaurantId]);
      if (!restRow.rows.length) {
        await client.query('ROLLBACK');
        fail(res, 404, 'NOT_FOUND', 'Restaurant not found.');
        return;
      }
      const restaurantName = restRow.rows[0].name as string;

      const addrRow = await client.query(
        'SELECT id FROM user_addresses WHERE id=$1 AND user_id=$2',
        [deliveryAddressId, req.userId],
      );
      if (!addrRow.rows.length) {
        await client.query('ROLLBACK');
        fail(res, 404, 'NOT_FOUND', 'Delivery address not found.');
        return;
      }

      const loyaltyPts = typeof rawLoyaltyPts === 'number' ? Math.floor(rawLoyaltyPts / 100) * 100 : 0;
      if (loyaltyPts > 0) {
        const balRes = await client.query(
          `SELECT loyalty_points_balance FROM users WHERE id=$1 FOR UPDATE`,
          [req.userId],
        );
        const balance: number = balRes.rows[0]?.loyalty_points_balance ?? 0;
        if (loyaltyPts > balance) {
          await client.query('ROLLBACK');
          fail(res, 400, 'INSUFFICIENT_POINTS', 'Not enough loyalty points.');
          return;
        }
      }

      let quote;
      try {
        quote = await quoteOrder(client, {
          restaurantId,
          items,
          deliveryAddressId,
          userId: req.userId,
          couponCode,
          loyaltyPointsToRedeem: loyaltyPts,
          deliveryLatitude,
          deliveryLongitude,
          restaurantLatitude,
          restaurantLongitude,
        });
      } catch (quoteErr) {
        await client.query('ROLLBACK');
        if (quoteErr instanceof Error && quoteErr.message.includes('not found')) {
          fail(res, 400, 'VALIDATION_ERROR', quoteErr.message);
          return;
        }
        throw quoteErr;
      }

      if (couponCode && quote.discount > 0) {
        await client.query(
          'UPDATE coupons SET uses_count = uses_count + 1 WHERE code = $1',
          [(couponCode as string).trim().toUpperCase()],
        );
      }

      const {
        subtotal,
        deliveryFee,
        serviceFee,
        smallOrderFee,
        discount,
        loyaltyDiscount,
        total,
        distanceKm,
        estimatedDeliveryMinutes,
        resolvedItems,
      } = quote;

      const paymentStatus = paymentMethod === 'cash' ? 'pending_cod' : 'pending';

      const orderRow = await client.query(`
        INSERT INTO orders (user_id, restaurant_id, status, subtotal, delivery_fee, service_fee, small_order_fee,
          discount, total, payment_method, payment_status, coupon_code, delivery_address_id, delivery_notes,
          loyalty_points_redeemed, distance_km, estimated_delivery_minutes)
        VALUES ($1,$2,'placed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING *
      `, [
        req.userId, restaurantId, subtotal, deliveryFee, serviceFee, smallOrderFee,
        discount, total, paymentMethod, paymentStatus,
        couponCode ?? null, deliveryAddressId, deliveryNotes ?? null, loyaltyPts,
        distanceKm, estimatedDeliveryMinutes,
      ]);

      const orderId = orderRow.rows[0].id as string;
      for (const item of resolvedItems) {
        await client.query(`
          INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, addon_ids, instructions)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [orderId, item.menuItemId, item.quantity, item.unitPrice, JSON.stringify(item.addonIds), item.instructions ?? null]);
      }

      if (loyaltyPts > 0) {
        await client.query(
          `UPDATE users SET loyalty_points_balance = loyalty_points_balance - $1 WHERE id = $2`,
          [loyaltyPts, req.userId],
        );
        await client.query(
          `INSERT INTO loyalty_transactions (user_id, order_id, points, type, description)
           VALUES ($1, $2, $3, 'redeemed', $4)`,
          [req.userId, orderId, -loyaltyPts, `Redeemed on order #${orderId.slice(-6).toUpperCase()}`],
        );
      }

      await client.query('COMMIT');

      const order = await fetchOrderDetail(client, orderId);
      ok(res, order, undefined, 201);

      const title = 'Order Placed!';
      const body = `Your order from ${restaurantName} has been placed and is awaiting confirmation.`;
      void sendPushToUser(req.userId!, title, body, { type: 'order_update', orderId });
      void insertNotification(req.userId!, 'order_placed', title, body, { orderId });
      void notifyRestaurantNewOrder(restaurantId, orderId, total);
      if (paymentMethod === 'cash') {
        void notifyOrderDispatchable(orderId);
      }
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
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
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        params.push(statuses[0]);
        sql += ` AND o.status = $${params.length}`;
      } else if (statuses.length > 1) {
        params.push(statuses);
        sql += ` AND o.status = ANY($${params.length}::text[])`;
      }
    }
    sql += ' ORDER BY o.placed_at DESC';
    const result = await pool.query(sql, params);
    ok(res, result.rows.map(mapOrderRow));
  } catch (err) {
    logger.error({ err }, 'list orders');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /orders/:id/payment-status
router.get('/:id/payment-status', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, payment_status, status, payment_method FROM orders WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Order not found.');
      return;
    }
    const row = result.rows[0];
    ok(res, {
      orderId: row.id,
      paymentStatus: row.payment_status,
      status: row.status,
      paymentMethod: row.payment_method,
    });
  } catch (err) {
    logger.error({ err }, 'order payment-status');
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
    `SELECT o.id, o.status, o.placed_at, o.estimated_delivery_minutes, o.driver_id,
            da.accepted_at, da.picked_up_at, da.created_at AS assignment_created_at,
            ua.latitude AS dest_lat, ua.longitude AS dest_lng,
            r.latitude AS restaurant_lat, r.longitude AS restaurant_lng,
            d.location_lat, d.location_lng, d.rating AS driver_rating, d.vehicle_type,
            u.first_name AS driver_first_name, u.last_name AS driver_last_name,
            u.phone AS driver_phone, u.avatar_url AS driver_avatar
     FROM orders o
     LEFT JOIN user_addresses ua ON ua.id = o.delivery_address_id
     LEFT JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN users u ON u.id = o.driver_id
     LEFT JOIN driver_assignments da ON da.order_id = o.id AND da.driver_id = o.driver_id
     WHERE o.id = $1 AND o.user_id = $2`,
    [orderId, userId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const computedEta = computeEta(
    row.status as string,
    row.accepted_at as Date | null,
    row.picked_up_at as Date | null,
  );
  const storedEta = row.estimated_delivery_minutes != null
    ? parseInt(String(row.estimated_delivery_minutes), 10)
    : null;
  const etaMinutes = storedEta && storedEta > 0 ? storedEta : computedEta;

  const destLat = parseCoord(row.dest_lat);
  const destLng = parseCoord(row.dest_lng);
  const driverLat = parseCoord(row.location_lat);
  const driverLng = parseCoord(row.location_lng);
  const restaurantLat = parseCoord(row.restaurant_lat);
  const restaurantLng = parseCoord(row.restaurant_lng);

  const driverAccepted = Boolean(row.driver_id);
  const driverAcceptedAt = row.accepted_at ?? row.assignment_created_at ?? null;
  const driverDistanceKm = driverAccepted
    ? distanceKmBetween(driverLat, driverLng, destLat, destLng)
    : null;
  const restaurantDistanceKm = distanceKmBetween(restaurantLat, restaurantLng, destLat, destLng);

  return {
    orderId: row.id,
    status: row.status,
    eta: etaMinutes,
    etaMinutes,
    estimatedDeliveryMinutes: etaMinutes,
    updatedAt: new Date().toISOString(),
    driverAccepted,
    driverAcceptedAt,
    driverDistanceKm,
    restaurantDistanceKm,
    customerLocation: isValidCoord(destLat, destLng)
      ? { latitude: destLat, longitude: destLng }
      : null,
    restaurantLocation: isValidCoord(restaurantLat, restaurantLng)
      ? { latitude: restaurantLat, longitude: restaurantLng }
      : null,
    driver: row.driver_id ? {
      id: row.driver_id,
      firstName: row.driver_first_name,
      lastName: row.driver_last_name,
      name: `${row.driver_first_name ?? ''} ${row.driver_last_name ?? ''}`.trim(),
      phone: row.driver_phone,
      avatar: row.driver_avatar,
      rating: parseFloat(String(row.driver_rating ?? '0')),
      vehicleType: row.vehicle_type,
      latitude: driverLat,
      longitude: driverLng,
      lat: driverLat,
      lng: driverLng,
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
      if (data) res.write(`data: ${JSON.stringify(data)}\r\n\r\n`);
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

// PATCH /orders/:id/notes — update delivery instructions before pickup
router.patch('/:id/notes', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { deliveryNotes } = req.body as { deliveryNotes?: string };
    if (typeof deliveryNotes !== 'string') {
      fail(res, 400, 'VALIDATION_ERROR', 'deliveryNotes is required.');
      return;
    }
    const trimmed = deliveryNotes.trim();
    if (trimmed.length > 500) {
      fail(res, 400, 'VALIDATION_ERROR', 'Delivery instructions must be 500 characters or less.');
      return;
    }

    const result = await pool.query(
      `UPDATE orders SET delivery_notes=$1
       WHERE id=$2 AND user_id=$3
       AND status IN ('placed','confirmed','preparing')
       RETURNING *`,
      [trimmed || null, req.params.id, req.userId],
    );
    if (!result.rows.length) {
      fail(res, 400, 'CANNOT_UPDATE', 'Delivery instructions can no longer be changed for this order.');
      return;
    }
    ok(res, mapOrderRow(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'update order notes');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /orders/:id/cancel
router.post('/:id/cancel', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `UPDATE orders SET status='cancelled', cancelled_at=NOW()
       WHERE id=$1 AND user_id=$2
       AND status IN ('pending_payment','placed','confirmed','preparing') RETURNING *`,
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
             ua.city AS addr_city, ua.province AS addr_province,
             ua.latitude AS addr_latitude, ua.longitude AS addr_longitude,
             ua.postal_code AS addr_postal_code
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
      postalCode: o.addr_postal_code,
      coordinates: o.addr_latitude != null && o.addr_longitude != null
        ? {
          latitude: parseFloat(String(o.addr_latitude)),
          longitude: parseFloat(String(o.addr_longitude)),
        }
        : undefined,
      formattedAddress: [o.addr_street, o.addr_suburb, o.addr_city, o.addr_province].filter(Boolean).join(', '),
    } : null,
    items: itemsRes.rows.map((i) => ({
      id: i.id,
      menuItemId: i.menu_item_id,
      menuItemName: i.item_name,
      menuItemImage: i.item_image,
      name: i.item_name,
      image: i.item_image,
      quantity: i.quantity,
      unitPrice: parseFloat(i.unit_price),
      totalPrice: parseFloat(i.unit_price) * i.quantity,
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
    restaurantName: o.restaurant_name,
    restaurantLogo: o.restaurant_logo,
    subtotal: parseFloat(o.subtotal as string),
    deliveryFee: parseFloat(o.delivery_fee as string),
    serviceFee: parseFloat(o.service_fee as string),
    discount: parseFloat(o.discount as string),
    total: parseFloat(o.total as string),
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    couponCode: o.coupon_code,
    deliveryNotes: o.delivery_notes,
    estimatedDeliveryTime: o.estimated_delivery_minutes != null
      ? parseInt(String(o.estimated_delivery_minutes), 10)
      : undefined,
    placedAt: o.placed_at,
    confirmedAt: o.confirmed_at,
    cancelledAt: o.cancelled_at,
    restaurant: {
      name: o.restaurant_name,
      logo: o.restaurant_logo,
      coverImage: o.restaurant_cover,
    },
  };
}

export default router;
