import { pool } from '../db';
import { sendPushToUser } from './push';

export async function notify(
  userId: string,
  type: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body, JSON.stringify(data ?? {})]
    );
    await sendPushToUser(userId, title, body, data);
  } catch (err) {
    console.error('notify error:', err);
  }
}
