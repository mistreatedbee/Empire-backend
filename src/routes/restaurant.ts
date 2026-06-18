import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireRestaurant, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import { sendPushToUser } from '../utils/push';

const router = Router();

// Helper: get restaurant owned by logged-in user
async function getMyRestaurant(userId: string): Promise<string | null> {
  const res = await pool.query('SELECT id FROM restaurants WHERE owner_id=$1', [userId]);
  return res.rows[0]?.id ?? null;
}

// ─── Profile ──────────────────────────────────────────────────────────────────

// GET /restaurant/me
router.get('/me', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT r.*, c.name AS category_name
       FROM restaurants r
       LEFT JOIN categories c ON c.id = r.category_id
       WHERE r.owner_id = $1`,
      [req.userId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account. Contact support.');
      return;
    }
    const r = result.rows[0];
    ok(res, {
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      address: r.address,
      logo: r.logo,
      coverImage: r.cover_image,
      deliveryFee: parseFloat(String(r.delivery_fee ?? '0')),
      minOrder: parseFloat(String(r.min_order ?? '0')),
      deliveryTimeMin: r.delivery_time_min,
      deliveryTimeMax: r.delivery_time_max,
      isOpen: r.is_open,
      rating: parseFloat(String(r.rating ?? '0')),
      reviewCount: Number(r.review_count ?? 0),
      categoryName: r.category_name,
    });
  } catch (err) {
    logger.error({ err }, 'GET /restaurant/me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /restaurant/me
router.put('/me', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }
    const { name, address, deliveryFee, minOrder } = req.body as {
      name?: string;
      address?: string;
      deliveryFee?: number;
      minOrder?: number;
    };
    if (!name?.trim()) {
      fail(res, 400, 'VALIDATION_ERROR', 'name is required.');
      return;
    }
    if (deliveryFee !== undefined && (isNaN(Number(deliveryFee)) || Number(deliveryFee) < 0)) {
      fail(res, 400, 'VALIDATION_ERROR', 'deliveryFee must be a non-negative number.');
      return;
    }
    if (minOrder !== undefined && (isNaN(Number(minOrder)) || Number(minOrder) < 0)) {
      fail(res, 400, 'VALIDATION_ERROR', 'minOrder must be a non-negative number.');
      return;
    }
    const result = await pool.query(
      `UPDATE restaurants
         SET name=$1, address=$2, delivery_fee=$3, min_order=$4, updated_at=NOW()
       WHERE id=$5
       RETURNING id, name, address, delivery_fee, min_order`,
      [name.trim(), address?.trim() ?? null, Number(deliveryFee ?? 0), Number(minOrder ?? 0), restaurantId]
    );
    const r = result.rows[0];
    ok(res, {
      id: r.id,
      name: r.name,
      address: r.address,
      deliveryFee: parseFloat(String(r.delivery_fee)),
      minOrder: parseFloat(String(r.min_order)),
    });
  } catch (err) {
    logger.error({ err }, 'PUT /restaurant/me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────

// GET /restaurant/stats
router.get('/stats', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }
    const result = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE placed_at >= CURRENT_DATE) AS orders_today,
        COALESCE(SUM(total) FILTER (WHERE placed_at >= CURRENT_DATE), 0) AS revenue_today,
        COALESCE(AVG(total) FILTER (WHERE placed_at >= CURRENT_DATE), 0) AS avg_order_today,
        COUNT(*) FILTER (WHERE status IN ('placed','confirmed','preparing','ready')) AS active_orders
       FROM orders
       WHERE restaurant_id = $1`,
      [restaurantId]
    );
    const row = result.rows[0];
    ok(res, {
      ordersToday: Number(row.orders_today ?? 0),
      revenueToday: parseFloat(String(row.revenue_today ?? '0')),
      avgOrderValue: parseFloat(String(row.avg_order_today ?? '0')),
      activeOrders: Number(row.active_orders ?? 0),
    });
  } catch (err) {
    logger.error({ err }, 'GET /restaurant/stats');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Orders ───────────────────────────────────────────────────────────────────

// GET /restaurant/orders?status=placed,confirmed,preparing
router.get('/orders', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }

    const { status } = req.query as { status?: string };
    const statuses = status ? status.split(',').map((s) => s.trim()) : null;

    let sql = `
      SELECT o.id, o.status, o.total, o.placed_at, o.confirmed_at, o.delivery_notes,
             u.first_name || ' ' || u.last_name AS customer_name, u.phone AS customer_phone,
             (SELECT json_agg(json_build_object('name', mi.name, 'quantity', oi.quantity, 'unitPrice', oi.unit_price))
              FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
              WHERE oi.order_id = o.id) AS items
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.restaurant_id = $1
    `;
    const params: unknown[] = [restaurantId];
    if (statuses) {
      params.push(statuses);
      sql += ` AND o.status = ANY($${params.length})`;
    }
    sql += ' ORDER BY o.placed_at DESC LIMIT 50';

    const result = await pool.query(sql, params);
    ok(res, result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      total: parseFloat(String(row.total)),
      placedAt: row.placed_at,
      confirmedAt: row.confirmed_at,
      deliveryNotes: row.delivery_notes,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      items: row.items ?? [],
    })));
  } catch (err) {
    logger.error({ err }, 'GET /restaurant/orders');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

async function updateOrderStatus(
  req: AuthRequest,
  res: Response,
  newStatus: string,
  pushTitle: string,
  pushBody: string
) {
  const restaurantId = await getMyRestaurant(req.userId!);
  if (!restaurantId) {
    fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
    return;
  }

  const result = await pool.query(
    `UPDATE orders SET status=$1, status_updated_at=NOW()
     WHERE id=$2 AND restaurant_id=$3
     RETURNING id, user_id`,
    [newStatus, req.params.id, restaurantId]
  );
  if (!result.rows.length) {
    fail(res, 404, 'NOT_FOUND', 'Order not found.');
    return;
  }

  ok(res, { id: result.rows[0].id, status: newStatus });

  const customerId = result.rows[0].user_id as string;
  void sendPushToUser(customerId, pushTitle, pushBody, { type: 'order_update', orderId: req.params.id });
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1,$2,$3,$4,$5)`,
      [customerId, 'order_update', pushTitle, pushBody, JSON.stringify({ orderId: req.params.id })]
    );
  } catch { /* non-fatal */ }
}

// PUT /restaurant/orders/:id/confirm
router.put('/orders/:id/confirm', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    await updateOrderStatus(req, res, 'confirmed', 'Order Confirmed!', 'The restaurant has confirmed your order and is getting started.');
  } catch (err) {
    logger.error({ err }, 'PUT /restaurant/orders/:id/confirm');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /restaurant/orders/:id/preparing
router.put('/orders/:id/preparing', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    await updateOrderStatus(req, res, 'preparing', 'Order Being Prepared', 'Your food is now being prepared!');
  } catch (err) {
    logger.error({ err }, 'PUT /restaurant/orders/:id/preparing');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /restaurant/orders/:id/ready
router.put('/orders/:id/ready', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    await updateOrderStatus(req, res, 'ready', 'Order Ready for Pickup', 'Your order is packed and ready for the driver.');
  } catch (err) {
    logger.error({ err }, 'PUT /restaurant/orders/:id/ready');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Menu ─────────────────────────────────────────────────────────────────────

// GET /restaurant/menu
router.get('/menu', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }

    const result = await pool.query(
      `SELECT mc.id AS cat_id, mc.name AS cat_name, mc.display_order,
              mi.id, mi.name, mi.description, mi.price, mi.image, mi.is_available, mi.display_order AS item_order
       FROM menu_categories mc
       LEFT JOIN menu_items mi ON mi.menu_category_id = mc.id AND mi.restaurant_id = $1
       WHERE mc.restaurant_id = $1
       ORDER BY mc.display_order, mi.display_order`,
      [restaurantId]
    );

    const catMap: Record<string, { id: string; name: string; items: unknown[] }> = {};
    for (const row of result.rows) {
      if (!catMap[row.cat_id as string]) {
        catMap[row.cat_id as string] = { id: row.cat_id, name: row.cat_name, items: [] };
      }
      if (row.id) {
        catMap[row.cat_id as string].items.push({
          id: row.id,
          name: row.name,
          description: row.description,
          price: parseFloat(String(row.price)),
          image: row.image,
          isAvailable: row.is_available,
          categoryId: row.cat_id,
          categoryName: row.cat_name,
        });
      }
    }
    ok(res, Object.values(catMap));
  } catch (err) {
    logger.error({ err }, 'GET /restaurant/menu');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /restaurant/menu/items
router.post('/menu/items', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }
    const { name, description, price, imageUrl, categoryId, isAvailable } = req.body;
    if (!name || price == null || !categoryId) {
      fail(res, 400, 'VALIDATION_ERROR', 'name, price and categoryId are required.');
      return;
    }

    const catCheck = await pool.query(
      'SELECT id FROM menu_categories WHERE id=$1 AND restaurant_id=$2',
      [categoryId, restaurantId]
    );
    if (!catCheck.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Menu category not found.');
      return;
    }

    const result = await pool.query(
      `INSERT INTO menu_items (menu_category_id, restaurant_id, name, description, price, image, is_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [categoryId, restaurantId, name, description ?? null, price, imageUrl ?? null, isAvailable !== false]
    );
    const item = result.rows[0];
    ok(res, {
      id: item.id,
      name: item.name,
      description: item.description,
      price: parseFloat(String(item.price)),
      image: item.image,
      isAvailable: item.is_available,
    }, undefined, 201);
  } catch (err) {
    logger.error({ err }, 'POST /restaurant/menu/items');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /restaurant/menu/items/:id
router.put('/menu/items/:id', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }
    const { name, description, price, imageUrl, categoryId, isAvailable } = req.body;
    const result = await pool.query(
      `UPDATE menu_items SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         price         = COALESCE($3, price),
         image         = COALESCE($4, image),
         menu_category_id = COALESCE($5, menu_category_id),
         is_available  = COALESCE($6, is_available)
       WHERE id=$7 AND restaurant_id=$8
       RETURNING *`,
      [name, description, price, imageUrl, categoryId, isAvailable, req.params.id, restaurantId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Menu item not found.');
      return;
    }
    const item = result.rows[0];
    ok(res, {
      id: item.id,
      name: item.name,
      description: item.description,
      price: parseFloat(String(item.price)),
      image: item.image,
      isAvailable: item.is_available,
    });
  } catch (err) {
    logger.error({ err }, 'PUT /restaurant/menu/items/:id');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// DELETE /restaurant/menu/items/:id — soft-delete (mark unavailable)
router.delete('/menu/items/:id', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }
    const result = await pool.query(
      `UPDATE menu_items SET is_available=false WHERE id=$1 AND restaurant_id=$2 RETURNING id`,
      [req.params.id, restaurantId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Menu item not found.');
      return;
    }
    ok(res, { id: req.params.id, isAvailable: false });
  } catch (err) {
    logger.error({ err }, 'DELETE /restaurant/menu/items/:id');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurant/analytics
router.get('/analytics', requireRestaurant, async (req: AuthRequest, res: Response) => {
  try {
    const restaurantId = await getMyRestaurant(req.userId!);
    if (!restaurantId) {
      fail(res, 404, 'NOT_FOUND', 'No restaurant linked to this account.');
      return;
    }

    const [weeklyRes, topItemsRes] = await Promise.all([
      pool.query(
        `SELECT TO_CHAR(o.placed_at AT TIME ZONE 'Africa/Johannesburg', 'Dy') AS day,
                EXTRACT(DOW FROM o.placed_at AT TIME ZONE 'Africa/Johannesburg') AS dow,
                COUNT(*) AS orders,
                COALESCE(SUM(o.total), 0) AS revenue
         FROM orders o
         WHERE o.restaurant_id = $1
           AND o.placed_at >= NOW() - INTERVAL '7 days'
           AND o.status != 'cancelled'
         GROUP BY day, dow
         ORDER BY dow`,
        [restaurantId]
      ),
      pool.query(
        `SELECT mi.name, COUNT(oi.id) AS order_count
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         JOIN orders o ON o.id = oi.order_id
         WHERE o.restaurant_id = $1
           AND o.placed_at >= NOW() - INTERVAL '30 days'
           AND o.status = 'delivered'
         GROUP BY mi.name
         ORDER BY order_count DESC
         LIMIT 5`,
        [restaurantId]
      ),
    ]);

    ok(res, {
      weeklyData: weeklyRes.rows.map((r) => ({
        day: r.day,
        orders: parseInt(r.orders, 10),
        revenue: parseFloat(r.revenue),
      })),
      topItems: topItemsRes.rows.map((r) => ({
        name: r.name,
        orderCount: parseInt(r.order_count, 10),
      })),
    });
  } catch (err) {
    logger.error({ err }, 'GET /restaurant/analytics');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
