import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { fail } from '../utils/response';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    fail(res, 401, 'UNAUTHORIZED', 'Authentication required.');
    return;
  }
  try {
    const payload = verifyAccessToken(header.slice(7));
    req.userId = payload.sub;
    req.userRole = payload.role;
    next();
  } catch {
    fail(res, 401, 'TOKEN_INVALID', 'Session expired. Please log in again.');
  }
}
