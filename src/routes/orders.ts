import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

// POST /orders
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { restaurantId, items, deliveryAddressId, paymentMethod, couponCode, deliveryNotes } = req.body;

    if (!restaurantId || !items?.length || !deliveryAddressId || !paymentMethod) {
      fail(res, 400, 'VALIDATION_ERROR', 'restaurantId, items, deliveryAddressId and paymentMethod are required.');
      return;
    }

    const client = await pool.connect();
    try {
      // Verify restaurant exists
      const restRow = await client.query('SELECT id, delivery_fee FROM restaurants WHERE id=$1', [restaurantId]);
      if (!restRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Restaurant not found.');
        return;
      }
      const deliveryFee = parseFloat(restRow.rows[0].delivery_fee);

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
      const discount = 0; // coupons stubbed out
      const total = subtotal + deliveryFee + serviceFee - discount;

      const paymentStatus = paymentMethod === 'cash' ? 'pending_cod' : 'pending';

      const orderRow = await client.query(`
        INSERT INTO orders (user_id, restaurant_id, status, subtotal, delivery_fee, service_fee, discount, total,
          payment_method, payment_status, coupon_code, delivery_address_id, delivery_notes)
        VALUES ($1,$2,'placed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
      `, [req.userId, restaurantId, subtotal, deliveryFee, serviceFee, discount, total,
          paymentMethod, paymentStatus, couponCode ?? null, deliveryAddressId, deliveryNotes ?? null]);

      const orderId = orderRow.rows[0].id as string;
      for (const item of resolvedItems) {
        await client.query(`
          INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, addon_ids, instructions)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [orderId, item.menuItemId, item.quantity, item.unitPrice, JSON.stringify(item.addonIds), item.instructions ?? null]);
      }

      const order = await fetchOrderDetail(client, orderId);
      ok(res, order, undefined, 201);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('create order error:', err);
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
    console.error('list orders error:', err);
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
    console.error('order detail error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /orders/:id/tracking  — stub for demo
router.get('/:id/tracking', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT id, status FROM orders WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Order not found.');
      return;
    }
    ok(res, {
      status: result.rows[0].status,
      eta: 30,
      message: 'Your order is being prepared',
      driverLocation: null,
    });
  } catch (err) {
    console.error('tracking error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

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
  } catch (err) {
    console.error('cancel order error:', err);
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
