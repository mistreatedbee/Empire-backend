import { pool } from '../db';
import { notify } from '../utils/notify';

interface Transition {
  from: string;
  to: string;
  afterMinutes: number;
  timestampCol?: string;
  push: { title: string; body: string };
}

const TRANSITIONS: Transition[] = [
  {
    from: 'confirmed', to: 'preparing', afterMinutes: 2,
    push: { title: 'Being Prepared 👨‍🍳', body: 'The restaurant is preparing your order.' },
  },
  {
    from: 'preparing', to: 'picked_up', afterMinutes: 5,
    timestampCol: 'picked_up_at',
    push: { title: 'Driver Picked Up 🛵', body: 'Your order has been picked up by the driver.' },
  },
  {
    from: 'picked_up', to: 'on_way', afterMinutes: 2,
    push: { title: 'On the Way! 🚀', body: 'Your driver is heading to you.' },
  },
  {
    from: 'on_way', to: 'delivered', afterMinutes: 8,
    timestampCol: 'delivered_at',
    push: { title: 'Delivered! 🎊', body: 'Your order has been delivered. Enjoy your meal!' },
  },
];

export function startOrderAdvanceJob(): void {
  advanceOrders().catch(console.error);
  setInterval(() => advanceOrders().catch(console.error), 30_000);
  console.log('Order advance job started.');
}

async function advanceOrders(): Promise<void> {
  const client = await pool.connect();
  try {
    // Auto-confirm COD orders still sitting at 'placed'
    const codRows = await client.query(`
      UPDATE orders
      SET status = 'confirmed', confirmed_at = NOW(), status_updated_at = NOW()
      WHERE status = 'placed'
        AND payment_method = 'cash'
      RETURNING id, user_id
    `);
    for (const r of codRows.rows) {
      await notify(r.user_id as string, 'order_update',
        'Order Confirmed! 🎉', 'Your order has been confirmed and is being prepared.',
        { orderId: r.id, status: 'confirmed' });
    }

    // Advance through each lifecycle transition
    for (const t of TRANSITIONS) {
      const extraSet = t.timestampCol ? `, ${t.timestampCol} = NOW()` : '';
      const rows = await client.query(`
        UPDATE orders
        SET status = $1, status_updated_at = NOW()${extraSet}
        WHERE status = $2
          AND status_updated_at <= NOW() - ($3 || ' minutes')::INTERVAL
        RETURNING id, user_id
      `, [t.to, t.from, t.afterMinutes]);

      for (const r of rows.rows) {
        await notify(r.user_id as string, 'order_update',
          t.push.title, t.push.body,
          { orderId: r.id, status: t.to });
      }
    }
  } catch (err) {
    console.error('orderAdvance error:', err);
  } finally {
    client.release();
  }
}
