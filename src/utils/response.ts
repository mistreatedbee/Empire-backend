import { Response } from 'express';

export function ok<T>(res: Response, data: T, message?: string, status = 200) {
  return res.status(status).json({ success: true, data, message });
}

export function fail(res: Response, status: number, code: string, message: string, field?: string) {
  return res.status(status).json({ code, message, field });
}
