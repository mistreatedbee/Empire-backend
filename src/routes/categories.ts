import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { ok, fail } from '../utils/response';

const router = Router();

// GET /categories
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT id, name, icon, slug FROM categories ORDER BY name');
    ok(res, result.rows);
  } catch (err) {
    console.error('categories error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
