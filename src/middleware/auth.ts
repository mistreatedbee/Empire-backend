import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { fail } from '../utils/response';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

const INSFORGE_URL = process.env.INSFORGE_URL ?? 'https://mnf8bzhv.us-east.insforge.app';

async function validateInsforgeToken(token: string): Promise<{ email: string } | null> {
  try {
    const res = await fetch(`${INSFORGE_URL}/api/auth/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { user?: { email?: string } };
    return body.user?.email ? { email: body.user.email.toLowerCase() } : null;
  } catch {
    return null;
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
    'SELECT id, role FROM users WHERE email = $1',
    [insforgeUser.email]
  );
  if (!row.rows.length) {
    fail(res, 401, 'USER_NOT_FOUND', 'Account not found. Please sign up.');
    return;
  }
  req.userId = row.rows[0].id as string;
  req.userRole = row.rows[0].role as string;
  next();
}

export function requireDriver(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'driver') {
      fail(res, 403, 'FORBIDDEN', 'Driver access required.');
      return;
    }
    next();
  });
}

export function requireRestaurant(req: AuthRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.userRole !== 'restaurant') {
      fail(res, 403, 'FORBIDDEN', 'Restaurant access required.');
      return;
    }
    next();
  });
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
