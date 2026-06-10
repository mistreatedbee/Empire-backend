import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

// GET /users/addresses
router.get('/addresses', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_addresses WHERE user_id=$1 ORDER BY is_default DESC, created_at DESC',
      [req.userId]
    );
    ok(res, result.rows.map(mapAddress));
  } catch (err) {
    console.error('list addresses error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /users/addresses
router.post('/addresses', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { label, street, suburb, city, province, postalCode, latitude, longitude, isDefault } = req.body;
    if (!street || !city) {
      fail(res, 400, 'VALIDATION_ERROR', 'street and city are required.');
      return;
    }

    const client = await pool.connect();
    try {
      if (isDefault) {
        await client.query(
          'UPDATE user_addresses SET is_default=false WHERE user_id=$1',
          [req.userId]
        );
      }
      const result = await client.query(`
        INSERT INTO user_addresses (user_id, label, street, suburb, city, province, postal_code, latitude, longitude, is_default)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `, [req.userId, label ?? 'Home', street, suburb ?? null, city, province ?? null,
          postalCode ?? null, latitude ?? null, longitude ?? null, isDefault ?? false]);
      ok(res, mapAddress(result.rows[0]), undefined, 201);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('create address error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /users/addresses/:id
router.put('/addresses/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { label, street, suburb, city, province, postalCode, latitude, longitude } = req.body;
    const result = await pool.query(`
      UPDATE user_addresses
      SET label=$1, street=$2, suburb=$3, city=$4, province=$5, postal_code=$6, latitude=$7, longitude=$8
      WHERE id=$9 AND user_id=$10
      RETURNING *
    `, [label, street, suburb ?? null, city, province ?? null, postalCode ?? null,
        latitude ?? null, longitude ?? null, req.params.id, req.userId]);
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Address not found.');
      return;
    }
    ok(res, mapAddress(result.rows[0]));
  } catch (err) {
    console.error('update address error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// DELETE /users/addresses/:id
router.delete('/addresses/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'DELETE FROM user_addresses WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Address not found.');
      return;
    }
    ok(res, null);
  } catch (err) {
    console.error('delete address error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /users/addresses/:id/default
router.put('/addresses/:id/default', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const client = await pool.connect();
    try {
      await client.query(
        'UPDATE user_addresses SET is_default=false WHERE user_id=$1',
        [req.userId]
      );
      const result = await client.query(
        'UPDATE user_addresses SET is_default=true WHERE id=$1 AND user_id=$2 RETURNING *',
        [req.params.id, req.userId]
      );
      if (!result.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'Address not found.');
        return;
      }
      ok(res, mapAddress(result.rows[0]));
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('set default address error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

function mapAddress(r: Record<string, unknown>) {
  return {
    id: r.id,
    label: r.label,
    street: r.street,
    suburb: r.suburb,
    city: r.city,
    province: r.province,
    postalCode: r.postal_code,
    latitude: r.latitude ? parseFloat(r.latitude as string) : null,
    longitude: r.longitude ? parseFloat(r.longitude as string) : null,
    isDefault: r.is_default,
    createdAt: r.created_at,
  };
}

export default router;
