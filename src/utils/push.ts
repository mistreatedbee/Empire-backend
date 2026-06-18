import Expo, { ExpoPushMessage } from 'expo-server-sdk';
import { pool } from '../db';
import { logger } from './logger';

const expo = new Expo();

export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    const tokenRows = await pool.query(
      'SELECT token FROM push_tokens WHERE user_id = $1',
      [userId]
    );
    if (!tokenRows.rows.length) return;

    const messages: ExpoPushMessage[] = tokenRows.rows
      .filter((r) => Expo.isExpoPushToken(r.token as string))
      .map((r) => ({
        to: r.token as string,
        sound: 'default' as const,
        title,
        body,
        data: data ?? {},
      }));

    if (!messages.length) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        logger.error({ err }, 'push send error');
      }
    }
  } catch (err) {
    logger.error({ err }, 'sendPushToUser error');
  }
}
