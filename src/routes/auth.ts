import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { signAccessToken, signRefreshToken, verifyAccessToken, refreshTokenExpiresAt } from '../utils/jwt';
import { sendOtp, checkOtp } from '../utils/otp';
import { ok, fail } from '../utils/response';

const router = Router();

// POST /auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { firstName, lastName, email, phone, password } = req.body;

  if (!firstName || !lastName || !email || !phone || !password) {
    fail(res, 400, 'VALIDATION_ERROR', 'All fields are required.');
    return;
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1 OR phone = $2',
      [email.toLowerCase(), phone]
    );
    if (existing.rows.length > 0) {
      const taken = existing.rows[0];
      const byEmail = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (byEmail.rows.length > 0) {
        fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.', 'email');
        return;
      }
      fail(res, 409, 'PHONE_TAKEN', 'An account with this phone number already exists.', 'phone');
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await client.query(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'customer')`,
      [firstName.trim(), lastName.trim(), email.toLowerCase().trim(), phone, passwordHash]
    );

    await sendOtp(phone);
    ok(res, { message: 'Account created. Please verify your phone number.' }, undefined, 201);
  } finally {
    client.release();
  }
});

// POST /auth/verify-otp
router.post('/verify-otp', async (req: Request, res: Response) => {
  const { phone, otp, purpose } = req.body;
  if (!phone || !otp || !purpose) {
    fail(res, 400, 'VALIDATION_ERROR', 'phone, otp, and purpose are required.');
    return;
  }

  const client = await pool.connect();
  try {
    const approved = await checkOtp(phone, otp);
    if (!approved) {
      fail(res, 400, 'OTP_INVALID', 'Invalid or expired code. Please try again.');
      return;
    }

    const userRow = await client.query(
      `UPDATE users SET is_verified = true, updated_at = NOW()
       WHERE phone = $1 RETURNING id, first_name, last_name, email, phone, role, profile_image, is_verified, created_at, updated_at`,
      [phone]
    );
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
});

// POST /auth/resend-otp
router.post('/resend-otp', async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) {
    fail(res, 400, 'VALIDATION_ERROR', 'Phone number is required.');
    return;
  }

  const client = await pool.connect();
  try {
    const userRow = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!userRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'No account found with this phone number.');
      return;
    }

    await sendOtp(phone);
    ok(res, { message: 'A new verification code has been sent.' });
  } finally {
    client.release();
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, phone, password } = req.body;
  if ((!email && !phone) || !password) {
    fail(res, 400, 'VALIDATION_ERROR', 'Email or phone and password are required.');
    return;
  }

  const client = await pool.connect();
  try {
    const userRow = await client.query(
      `SELECT id, first_name, last_name, email, phone, password_hash, role, profile_image, is_verified, created_at, updated_at
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
      fail(res, 403, 'UNVERIFIED', 'Please verify your phone number before signing in.');
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
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req: AuthRequest, res: Response) => {
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.userId]);
  ok(res, null);
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
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
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
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

    // Rotate refresh token
    await client.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    const newRefreshToken = signRefreshToken();
    await client.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user_id, newRefreshToken, refreshTokenExpiresAt()]
    );

    const accessToken = signAccessToken(user_id, userRow.rows[0].role);
    ok(res, { accessToken, refreshToken: newRefreshToken });
  } finally {
    client.release();
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    fail(res, 400, 'VALIDATION_ERROR', 'Email is required.');
    return;
  }

  const client = await pool.connect();
  try {
    const userRow = await client.query('SELECT id, phone FROM users WHERE email = $1', [email.toLowerCase()]);
    // Always respond with success to prevent email enumeration
    if (!userRow.rows.length) {
      ok(res, { message: 'If an account exists, a reset code has been sent to your phone.' });
      return;
    }

    const { id, phone } = userRow.rows[0];
    await sendOtp(phone);
    ok(res, { message: 'If an account exists, a reset code has been sent to your phone.' });
  } finally {
    client.release();
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    fail(res, 400, 'VALIDATION_ERROR', 'token and newPassword are required.');
    return;
  }
  if (newPassword.length < 8) {
    fail(res, 400, 'VALIDATION_ERROR', 'Password must be at least 8 characters.', 'newPassword');
    return;
  }

  // token is "phone:otp" — the mobile OTP screen passes both
  const [phone, otp] = token.split(':');
  if (!phone || !otp) {
    fail(res, 400, 'TOKEN_INVALID', 'Invalid reset token.');
    return;
  }

  const approved = await checkOtp(phone, otp);
  if (!approved) {
    fail(res, 400, 'TOKEN_INVALID', 'Invalid or expired reset code.');
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE phone = $2',
    [passwordHash, phone]
  );

  ok(res, { message: 'Password updated successfully.' });
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
