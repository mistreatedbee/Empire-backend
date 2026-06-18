import { logger } from '../utils/logger';
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

const INSFORGE_URL = process.env.INSFORGE_URL ?? 'https://mnf8bzhv.us-east.insforge.app';

// POST /auth/sync
// Called after InsForge email verification to create/return our user record.
router.post('/sync', async (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return;
  }
  const token = header.slice(7);

  try {
    // Validate InsForge token and get email
    const insforgeRes = await fetch(`${INSFORGE_URL}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!insforgeRes.ok) {
      fail(res, 401, 'TOKEN_INVALID', 'Invalid token.');
      return;
    }
    const { user: insforgeUser } = await insforgeRes.json() as { user: { email: string } };
    const email = insforgeUser.email.toLowerCase();

    // Return existing user if already in our DB
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      ok(res, mapUser(existing.rows[0]));
      return;
    }

    // Create new user from registration data
    const { firstName, lastName, phone, role } = req.body as {
      firstName?: string;
      lastName?: string;
      phone?: string;
      role?: string;
    };

    const allowedRoles = ['customer', 'driver', 'restaurant'];
    const userRole = allowedRoles.includes(role ?? '') ? role! : 'customer';
    const approvalStatus = userRole === 'customer' ? 'approved' : 'pending';

    const result = await pool.query(
      `INSERT INTO users
         (first_name, last_name, email, phone, password_hash, role, approval_status, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [
        (firstName ?? '').trim(),
        (lastName ?? '').trim(),
        email,
        phone ?? '',
        'insforge_managed',
        userRole,
        approvalStatus,
      ]
    );
    ok(res, mapUser(result.rows[0]), undefined, 201);
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'users_phone_key') {
      fail(res, 409, 'PHONE_TAKEN', 'This phone number is already registered to a different account.');
      return;
    }
    logger.error({ err }, 'auth/sync');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const row = await pool.query(
      `SELECT id, first_name, last_name, email, phone, role, profile_image,
              is_verified, approval_status, suspension_reason, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!row.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    ok(res, mapUser(row.rows[0]));
  } catch (err) {
    logger.error({ err }, 'auth/me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Remove push tokens on logout
    await pool.query('DELETE FROM push_tokens WHERE user_id = $1', [req.userId]);
    ok(res, null);
  } catch (err) {
    logger.error({ err }, 'auth/logout');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// GET /health
router.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

function mapUser(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    email: row.email as string,
    phone: row.phone as string,
    role: row.role as string,
    profileImage: (row.profile_image ?? null) as string | null,
    approvalStatus: (row.approval_status ?? 'approved') as string,
    suspensionReason: (row.suspension_reason ?? null) as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export default router;
