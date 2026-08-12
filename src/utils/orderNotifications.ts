import { pool } from '../db';
import { notify } from './notify';
import { logger } from './logger';

/** Notify the restaurant owner that a customer placed a new order. */
export async function notifyRestaurantNewOrder(
  restaurantId: string,
  orderId: string,
  total: number,
): Promise<void> {
  try {
    const row = await pool.query(
      'SELECT owner_id, name FROM restaurants WHERE id=$1',
      [restaurantId],
    );
    const ownerId = row.rows[0]?.owner_id as string | undefined;
    if (!ownerId) return;

    const shortId = orderId.slice(-6).toUpperCase();
    await notify(
      ownerId,
      'restaurant_new_order',
      'New order received',
      `Order #${shortId} — R${Number(total).toFixed(2)}. Tap to view.`,
      { orderId, type: 'restaurant_new_order' },
    );
  } catch (err) {
    logger.error({ err, orderId, restaurantId }, 'notifyRestaurantNewOrder');
  }
}

/** Notify all online drivers that a delivery is available. */
export async function notifyOnlineDriversNewDelivery(
  orderId: string,
  restaurantName: string,
): Promise<void> {
  try {
    const drivers = await pool.query(
      `SELECT id FROM drivers WHERE is_online = true`,
    );
    if (!drivers.rows.length) return;

    const title = 'New delivery available';
    const body = `Pickup from ${restaurantName}. Open the app to accept.`;
    const data = { orderId, type: 'driver_new_delivery' };

    await Promise.all(
      drivers.rows.map((d) =>
        notify(d.id as string, 'driver_new_delivery', title, body, data),
      ),
    );
  } catch (err) {
    logger.error({ err, orderId }, 'notifyOnlineDriversNewDelivery');
  }
}

/** Notify online drivers that a delivery is available (no driver assigned yet). */
export async function notifyOrderDispatchable(orderId: string): Promise<void> {
  try {
    const row = await pool.query(
      `SELECT o.id, o.status, o.driver_id, r.name AS restaurant_name
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = $1`,
      [orderId],
    );
    if (!row.rows.length) return;

    const order = row.rows[0];
    if (order.driver_id) return;
    if (!['placed', 'confirmed', 'preparing', 'ready'].includes(String(order.status))) return;

    await notifyOnlineDriversNewDelivery(orderId, String(order.restaurant_name));
  } catch (err) {
    logger.error({ err, orderId }, 'notifyOrderDispatchable');
  }
}
