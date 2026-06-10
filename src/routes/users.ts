import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
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

// PUT /users/profile
router.put('/profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { firstName, lastName, phone, profileImage } = req.body;
    if (!firstName || !lastName) {
      fail(res, 400, 'VALIDATION_ERROR', 'firstName and lastName are required.');
      return;
    }
    const result = await pool.query(`
      UPDATE users
      SET first_name=$1, last_name=$2, phone=COALESCE($3, phone),
          profile_image=COALESCE($4, profile_image), updated_at=NOW()
      WHERE id=$5
      RETURNING id, first_name, last_name, email, phone, role, profile_image, is_verified
    `, [firstName, lastName, phone ?? null, profileImage ?? null, req.userId]);
    ok(res, mapUser(result.rows[0]));
  } catch (err) {
    console.error('update profile error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /users/change-password
router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      fail(res, 400, 'VALIDATION_ERROR', 'currentPassword and newPassword are required.');
      return;
    }
    if (newPassword.length < 8) {
      fail(res, 400, 'VALIDATION_ERROR', 'New password must be at least 8 characters.');
      return;
    }
    const userRow = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.userId]);
    const valid = await bcrypt.compare(currentPassword as string, userRow.rows[0].password_hash as string);
    if (!valid) {
      fail(res, 400, 'WRONG_PASSWORD', 'Current password is incorrect.');
      return;
    }
    const hash = await bcrypt.hash(newPassword as string, 12);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.userId]);
    ok(res, null);
  } catch (err) {
    console.error('change password error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /users/payment-methods  — stub (Phase 5: saved cards)
router.get('/payment-methods', requireAuth, (_req: AuthRequest, res: Response) => {
  ok(res, []);
});

// GET /users/favourites
router.get('/favourites', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT r.*, c.name AS category_name, c.slug AS category_slug
      FROM favourites f
      JOIN restaurants r ON r.id = f.restaurant_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `, [req.userId]);
    ok(res, result.rows.map(mapRestaurant));
  } catch (err) {
    console.error('favourites error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

function mapUser(r: Record<string, unknown>) {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    role: r.role,
    profileImage: r.profile_image,
    isVerified: r.is_verified,
  };
}

function mapRestaurant(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    coverImage: r.cover_image,
    logo: r.logo,
    category: r.category_name ? { name: r.category_name, slug: r.category_slug } : null,
    rating: parseFloat(r.rating as string),
    reviewCount: r.review_count,
    deliveryTimeMin: r.delivery_time_min,
    deliveryTimeMax: r.delivery_time_max,
    deliveryFee: parseFloat(r.delivery_fee as string),
    minOrder: parseFloat(r.min_order as string),
    isOpen: r.is_open,
    isFeatured: r.is_featured,
  };
}

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
