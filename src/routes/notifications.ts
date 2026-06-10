import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

// GET /notifications?page=1&limit=20
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) ?? '1', 10);
    const limit = Math.min(parseInt((req.query.limit as string) ?? '20', 10), 50);
    const offset = (page - 1) * limit;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.userId, limit, offset]
      ),
      pool.query('SELECT COUNT(*) FROM notifications WHERE user_id=$1', [req.userId]),
    ]);

    ok(res, {
      data: dataRes.rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        isRead: n.is_read,
        createdAt: n.created_at,
      })),
      total: parseInt(countRes.rows[0].count as string, 10),
      page,
      limit,
      unreadCount: dataRes.rows.filter((n) => !n.is_read).length,
    });
  } catch (err) {
    console.error('list notifications error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /notifications/read-all
router.put('/read-all', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.userId]);
    ok(res, null);
  } catch (err) {
    console.error('read-all error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /notifications/:id/read
router.put('/:id/read', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Notification not found.');
      return;
    }
    ok(res, null);
  } catch (err) {
    console.error('read notification error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /notifications/token — register push token
router.post('/token', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { token, platform } = req.body;
    if (!token) {
      fail(res, 400, 'VALIDATION_ERROR', 'token is required.');
      return;
    }
    await pool.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id=$1, platform=$3`,
      [req.userId, token, platform ?? 'unknown']
    );
    ok(res, null);
  } catch (err) {
    console.error('register token error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// DELETE /notifications/token/:token — remove push token on logout
router.delete('/token/:token', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query(
      'DELETE FROM push_tokens WHERE token=$1 AND user_id=$2',
      [req.params.token, req.userId]
    );
    ok(res, null);
  } catch (err) {
    console.error('delete token error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
