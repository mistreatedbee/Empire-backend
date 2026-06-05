import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';

const router = Router();

// POST /dev/seed-driver
// Creates a pre-verified driver account for testing.
// Only available when DEV_SEED_KEY is set in environment.
router.post('/seed-driver', async (req: Request, res: Response) => {
  try {
    const { key } = req.body;
    if (!process.env.DEV_SEED_KEY || key !== process.env.DEV_SEED_KEY) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Invalid seed key.' });
      return;
    }

    const email = 'driver@empiredeliveries.co.za';
    const phone = '+27800000001';
    const password = 'Driver123!';

    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, role, is_verified)
       VALUES ($1, $2, $3, $4, $5, 'driver', true)`,
      ['Test', 'Driver', email, phone, hash]
    );

    res.json({ success: true, data: { email, phone, password, role: 'driver' } });
  } catch (err) {
    console.error('seed-driver error:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Seed failed.' });
  }
});

export default router;
