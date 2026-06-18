import { logger } from '../utils/logger';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { signAccessToken, signRefreshToken, refreshTokenExpiresAt } from '../utils/jwt';
import { sendOtp, checkOtp } from '../utils/otp';
import { ok, fail } from '../utils/response';

const router = Router();

function isStrongPassword(pw: string): boolean {
  return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw);
}

// POST /auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { firstName, lastName, email, phone, password } = req.body;
  try {
    if (!firstName || !lastName || !email || !phone || !password) {
      fail(res, 400, 'VALIDATION_ERROR', 'All fields are required.');
      return;
    }

    if (!isStrongPassword(password as string)) {
      fail(res, 400, 'WEAK_PASSWORD', 'Password must be at least 8 characters and include uppercase, lowercase, and a number.', 'password');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If the account exists but is unverified, just resend the OTP
      const byEmail = await client.query(
        'SELECT id, is_verified FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      if (byEmail.rows.length > 0) {
        if (!byEmail.rows[0].is_verified) {
          await client.query('ROLLBACK');
          await sendOtp(email.toLowerCase().trim());
          ok(res, { message: 'A verification code has been sent to your email.' }, undefined, 200);
          return;
        }
        await client.query('ROLLBACK');
        fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.', 'email');
        return;
      }

      const byPhone = await client.query(
        'SELECT id, is_verified FROM users WHERE phone = $1',
        [phone]
      );
      if (byPhone.rows.length > 0) {
        if (!byPhone.rows[0].is_verified) {
          await client.query('ROLLBACK');
          await sendOtp(phone);
          ok(res, { message: 'A verification code has been sent to your phone.' }, undefined, 200);
          return;
        }
        await client.query('ROLLBACK');
        fail(res, 409, 'PHONE_TAKEN', 'An account with this phone number already exists.', 'phone');
        return;
      }

      const allowedRoles = ['customer', 'driver', 'restaurant'];
      const role = allowedRoles.includes(req.body.role as string) ? (req.body.role as string) : 'customer';
      const approvalStatus = role === 'customer' ? 'approved' : 'pending';

      const passwordHash = await bcrypt.hash(password, 12);
      await client.query(
        `INSERT INTO users (first_name, last_name, email, phone, password_hash, role, approval_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [firstName.trim(), lastName.trim(), email.toLowerCase().trim(), phone, passwordHash, role, approvalStatus]
      );

      // Send email code while still in transaction — if it throws, INSERT rolls back
      await sendOtp(email.toLowerCase().trim());

      await client.query('COMMIT');
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }

    ok(res, { message: 'Account created. Please verify your email address.' }, undefined, 201);
  } catch (err) {
    logger.error({ err }, 'register');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/verify-otp
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { email, otp, purpose } = req.body;
    if (!email || !otp || !purpose) {
      fail(res, 400, 'VALIDATION_ERROR', 'email, otp, and purpose are required.');
      return;
    }

    const approved = await checkOtp(email.toLowerCase(), otp);
    if (!approved) {
      fail(res, 400, 'OTP_INVALID', 'Invalid or expired code. Please try again.');
      return;
    }

    const client = await pool.connect();
    try {
      const userRow = await client.query(
        `UPDATE users SET is_verified = true, updated_at = NOW()
         WHERE email = $1 RETURNING id, first_name, last_name, email, phone, role, profile_image, is_verified, created_at, updated_at`,
        [email.toLowerCase()]
      );
      if (!userRow.rows.length) {
        fail(res, 404, 'NOT_FOUND', 'No account found for this email address.');
        return;
      }
      const user = mapUser(userRow.rows[0]);
      const accessToken = signAccessToken(user.id, user.role);
      const refreshToken = signRefreshToken();
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshToken, refreshTokenExpiresAt()]
      );
      ok(res, { user, tokens: { accessToken, refreshToken } });
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'verify-otp');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/resend-otp
router.post('/resend-otp', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      fail(res, 400, 'VALIDATION_ERROR', 'Email address is required.');
      return;
    }

    const row = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!row.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'No account found with this email address.');
      return;
    }

    await sendOtp(email.toLowerCase());
    ok(res, { message: 'A new verification code has been sent to your email.' });
  } catch (err) {
    logger.error({ err }, 'resend-otp');
    fail(res, 500, 'Something went wrong. Please try again.');
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, phone, password } = req.body;
    if ((!email && !phone) || !password) {
      fail(res, 400, 'VALIDATION_ERROR', 'Email or phone and password are required.');
      return;
    }

    const client = await pool.connect();
    try {
      const userRow = await client.query(
        `SELECT id, first_name, last_name, email, phone, password_hash, role, profile_image, is_verified, approval_status, suspension_reason, created_at, updated_at
         FROM users WHERE email = $1 OR phone = $2 LIMIT 1`,
        [email?.toLowerCase() ?? '', phone ?? '']
      );

      if (!userRow.rows.length) {
        fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.', 'email');
        return;
      }

      const row = userRow.rows[0];
      const valid = await bcrypt.compare(password, row.password_hash);
      if (!valid) {
        fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password.', 'password');
        return;
      }

      if (!row.is_verified) {
        fail(res, 403, 'UNVERIFIED', 'Please verify your email address before signing in.');
        return;
      }

      const approvalStatus = (row.approval_status as string) ?? 'approved';
      if (approvalStatus === 'pending') {
        fail(res, 403, 'PENDING_APPROVAL', 'Your account is pending review. You will be notified once approved.');
        return;
      }
      if (approvalStatus === 'suspended') {
        fail(res, 403, 'ACCOUNT_SUSPENDED', (row.suspension_reason as string) || 'Your account has been suspended. Please contact support.');
        return;
      }
      if (approvalStatus === 'rejected') {
        fail(res, 403, 'APPLICATION_REJECTED', 'Your application was not approved. Please contact support for more information.');
        return;
      }

      const user = mapUser(row);
      const accessToken = signAccessToken(user.id, user.role);
      const refreshToken = signRefreshToken();
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshToken, refreshTokenExpiresAt()]
      );
      ok(res, { user, tokens: { accessToken, refreshToken } });
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'login');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.userId]);
    ok(res, null);
  } catch (err) {
    logger.error({ err }, 'logout');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const row = await pool.query(
      `SELECT id, first_name, last_name, email, phone, role, profile_image, is_verified, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!row.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    ok(res, mapUser(row.rows[0]));
  } catch (err) {
    logger.error({ err }, 'me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      fail(res, 400, 'VALIDATION_ERROR', 'refreshToken is required.');
      return;
    }

    const client = await pool.connect();
    try {
      const tokenRow = await client.query(
        'SELECT user_id, expires_at FROM refresh_tokens WHERE token = $1',
        [refreshToken]
      );
      if (!tokenRow.rows.length || new Date(tokenRow.rows[0].expires_at) < new Date()) {
        fail(res, 401, 'TOKEN_INVALID', 'Session expired. Please log in again.');
        return;
      }

      const { user_id } = tokenRow.rows[0];
      const userRow = await client.query('SELECT role FROM users WHERE id = $1', [user_id]);
      if (!userRow.rows.length) {
        fail(res, 401, 'TOKEN_INVALID', 'Session expired. Please log in again.');
        return;
      }

      await client.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
      const newRefreshToken = signRefreshToken();
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user_id, newRefreshToken, refreshTokenExpiresAt()]
      );

      const accessToken = signAccessToken(user_id, userRow.rows[0].role as string);
      ok(res, { accessToken, refreshToken: newRefreshToken });
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'refresh');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      fail(res, 400, 'VALIDATION_ERROR', 'Email is required.');
      return;
    }

    const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    // Always respond with success to prevent email enumeration
    if (userRow.rows.length > 0) {
      await sendOtp(email.toLowerCase());
    }
    ok(res, { message: 'If an account exists, a reset code has been sent to your email.' });
  } catch (err) {
    logger.error({ err }, 'forgot-password');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      fail(res, 400, 'VALIDATION_ERROR', 'token and newPassword are required.');
      return;
    }
    if (!isStrongPassword(newPassword as string)) {
      fail(res, 400, 'WEAK_PASSWORD', 'Password must be at least 8 characters with uppercase, lowercase, and a number.', 'newPassword');
      return;
    }

    // token is "email:otp" — passed by the mobile OTP screen
    const colonIdx = (token as string).indexOf(':');
    if (colonIdx === -1) {
      fail(res, 400, 'TOKEN_INVALID', 'Invalid reset token.');
      return;
    }
    const email = (token as string).slice(0, colonIdx).toLowerCase();
    const otp = (token as string).slice(colonIdx + 1);
    if (!email || !otp) {
      fail(res, 400, 'TOKEN_INVALID', 'Invalid reset token.');
      return;
    }

    const approved = await checkOtp(email, otp);
    if (!approved) {
      fail(res, 400, 'TOKEN_INVALID', 'Invalid or expired reset code.');
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2',
      [passwordHash, email]
    );
    ok(res, { message: 'Password updated successfully.' });
  } catch (err) {
    logger.error({ err }, 'reset-password');
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
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export default router;
