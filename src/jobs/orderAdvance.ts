import { pool } from '../db';
import { notify } from '../utils/notify';
import { logger } from '../utils/logger';

/** Only auto-confirms cash-on-delivery orders still at `placed`. Status transitions are manual (restaurant + driver). */
export function startOrderAdvanceJob(): void {
  void confirmCodOrders();
  setInterval(() => { void confirmCodOrders(); }, 30_000);
  console.log('Order COD confirm job started (auto-advance disabled).');
}

async function confirmCodOrders(): Promise<void> {
  const client = await pool.connect();
  try {
    const codRows = await client.query(`
      UPDATE orders
      SET status = 'confirmed', confirmed_at = NOW(), status_updated_at = NOW()
      WHERE status = 'placed'
        AND payment_method = 'cash'
      RETURNING id, user_id
    `);
    for (const r of codRows.rows) {
      await notify(
        r.user_id as string,
        'order_update',
        'Order Confirmed!',
        'Your cash order has been confirmed and sent to the restaurant.',
        { orderId: r.id, status: 'confirmed' },
      );
    }
  } catch (err) {
    logger.error({ err }, 'orderAdvance COD confirm error');
  } finally {
    client.release();
  }
}
