import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../db';
import { fail } from '../utils/response';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

const INSFORGE_URL = process.env.INSFORGE_URL ?? 'https://mnf8bzhv.us-east.insforge.app';

async function validateInsforgeToken(token: string): Promise<{ email: string; name?: string } | null> {
  try {
    const res = await fetch(`${INSFORGE_URL}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { user?: { email?: string; name?: string } };
    return body.user?.email
      ? { email: body.user.email.toLowerCase(), name: body.user.name }
      : null;
  } catch {
    return null;
  }
}

function placeholderPhone(email: string): string {
  const local = email.split('@')[0]?.replace(/\W/g, '').slice(0, 8) || 'user';
  return `ig${local}${randomUUID().replace(/-/g, '').slice(0, 6)}`.slice(0, 20);
}

async function ensureUserForEmail(
  email: string,
  profile?: { firstName?: string; lastName?: string; phone?: string; role?: string },
): Promise<{ id: string; role: string; approval_status: string; subscription_expires_at: string | null } | null> {
  const existing = await pool.query(
    'SELECT id, role, approval_status, subscription_expires_at FROM users WHERE email = $1',
    [email],
  );
  if (existing.rows.length) return existing.rows[0];

  const allowedRoles = ['customer', 'driver', 'restaurant'];
  const userRole = allowedRoles.includes(profile?.role ?? '') ? profile!.role! : 'customer';
  const approvalStatus = userRole === 'customer' ? 'approved' : 'pending';
  const nameParts = (profile?.firstName || profile?.lastName)
    ? [profile?.firstName ?? '', profile?.lastName ?? '']
    : (profile?.role ? ['', ''] : ['', '']);
  const phone = (profile?.phone ?? '').trim() || placeholderPhone(email);

  try {
    const created = await pool.query(
      `INSERT INTO users
         (first_name, last_name, email, phone, password_hash, role, approval_status, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id, role, approval_status, subscription_expires_at`,
      [
        nameParts[0].trim(),
        nameParts[1].trim(),
        email,
        phone,
        'insforge_managed',
        userRole,
        approvalStatus,
      ],
    );
    return created.rows[0];
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      const retry = await pool.query(
        'SELECT id, role, approval_status, subscription_expires_at FROM users WHERE email = $1',
        [email],
      );
      return retry.rows[0] ?? null;
    }
    throw err;
  }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return;
  }
  const token = header.slice(7);

  const insforgeUser = await validateInsforgeToken(token);
  if (!insforgeUser) {
    fail(res, 401, 'TOKEN_INVALID', 'Session expired. Please log in again.');
    return;
  }

  const row = await pool.query(
    'SELECT id, role, approval_status, subscription_expires_at FROM users WHERE email = $1',
    [insforgeUser.email]
  );
  let userRow = row.rows[0];
  if (!userRow) {
    const nameParts = (insforgeUser.name ?? '').trim().split(/\s+/);
    userRow = await ensureUserForEmail(insforgeUser.email, {
      firstName: nameParts[0] ?? '',
      lastName: nameParts.slice(1).join(' ') ?? '',
    });
    if (!userRow) {
      fail(res, 401, 'USER_NOT_FOUND', 'Account not found. Please sign up.');
      return;
    }
  }
  const { id, role, approval_status, subscription_expires_at } = userRow;
  if (role !== 'admin' && subscription_expires_at && new Date(subscription_expires_at) < new Date()) {
    fail(res, 403, 'SUBSCRIPTION_EXPIRED', 'Your access has expired. Please renew to continue.');
    return;
  }
  req.userId = id as string;
  req.userRole = role as string;
  (req as AuthRequest & { approvalStatus?: string }).approvalStatus = approval_status as string;
  next();
}

function checkApproval(req: AuthRequest, res: Response, role: 'driver' | 'restaurant'): boolean {
  const status = (req as AuthRequest & { approvalStatus?: string }).approvalStatus ?? 'approved';
  if (status === 'suspended') {
    fail(res, 403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended.');
    return false;
  }
  if (status === 'pending') {
    fail(res, 403, 'PENDING_APPROVAL', `Your ${role} application is pending approval.`);
    return false;
  }
  if (status === 'rejected') {
    fail(res, 403, 'ACCOUNT_REJECTED', `Your ${role} application was not approved.`);
    return false;
  }
  return true;
}

export function requireApprovedDriver(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'driver') {
      fail(res, 403, 'FORBIDDEN', 'Driver access required.');
      return;
    }
    if (!checkApproval(req, res, 'driver')) return;
    next();
  });
}

export function requireApprovedRestaurant(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'restaurant') {
      fail(res, 403, 'FORBIDDEN', 'Restaurant access required.');
      return;
    }
    if (!checkApproval(req, res, 'restaurant')) return;
    next();
  });
}

export function requireDriver(req: AuthRequest, res: Response, next: NextFunction) {
  requireApprovedDriver(req, res, next);
}

export function requireRestaurant(req: AuthRequest, res: Response, next: NextFunction) {
  requireApprovedRestaurant(req, res, next);
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'admin') {
      fail(res, 403, 'FORBIDDEN', 'Admin access required.');
      return;
    }
    next();
  });
}
