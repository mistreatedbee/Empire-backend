import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import { sendPushToUser } from '../utils/push';

const router = Router();

// All routes in this file already require admin (applied at mount in app.ts)
// Extra requireAdmin guard here is belt-and-suspenders for direct route use
router.use(requireAdmin);

// ─── Stats ────────────────────────────────────────────────────────────────────

// GET /admin/stats
router.get('/stats', async (_req: AuthRequest, res: Response) => {
  try {
    const [users, orders, pendingDrivers, pendingRestaurants] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE role='customer') AS customers,
        COUNT(*) FILTER (WHERE role='driver') AS drivers,
        COUNT(*) FILTER (WHERE role='restaurant') AS restaurants,
        COUNT(*) FILTER (WHERE approval_status='pending') AS pending_approval
       FROM users`),
      pool.query(`SELECT
        COUNT(*) AS total_today,
        COALESCE(SUM(total), 0) AS revenue_today
       FROM orders WHERE placed_at >= CURRENT_DATE`),
      pool.query(`SELECT COUNT(*) AS cnt FROM driver_applications WHERE status='pending'`),
      pool.query(`SELECT COUNT(*) AS cnt FROM restaurant_applications WHERE status='pending'`),
    ]);

    const u = users.rows[0];
    const o = orders.rows[0];
    ok(res, {
      users: {
        total: Number(u.total),
        customers: Number(u.customers),
        drivers: Number(u.drivers),
        restaurants: Number(u.restaurants),
        pendingApproval: Number(u.pending_approval),
      },
      orders: {
        today: Number(o.total_today),
        revenueToday: parseFloat(String(o.revenue_today)),
      },
      pendingDriverApplications: Number(pendingDrivers.rows[0].cnt),
      pendingRestaurantApplications: Number(pendingRestaurants.rows[0].cnt),
    });
  } catch (err) {
    logger.error({ err }, 'GET /admin/stats');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Applications ─────────────────────────────────────────────────────────────

// GET /admin/applications?type=driver|restaurant&status=pending|approved|rejected
router.get('/applications', async (req: AuthRequest, res: Response) => {
  try {
    const type = (req.query.type as string) || 'all';
    const status = (req.query.status as string) || 'pending';

    const results: unknown[] = [];

    if (type === 'driver' || type === 'all') {
      const q = await pool.query(
        `SELECT da.*, u.first_name, u.last_name, u.email, u.phone, u.approval_status AS user_approval_status
         FROM driver_applications da
         JOIN users u ON u.id = da.user_id
         WHERE ($1 = 'all' OR da.status = $1)
         ORDER BY da.submitted_at DESC`,
        [status]
      );
      q.rows.forEach((r) => results.push({ ...r, applicationType: 'driver' }));
    }

    if (type === 'restaurant' || type === 'all') {
      const q = await pool.query(
        `SELECT ra.*, u.first_name, u.last_name, u.email, u.phone, u.approval_status AS user_approval_status
         FROM restaurant_applications ra
         JOIN users u ON u.id = ra.user_id
         WHERE ($1 = 'all' OR ra.status = $1)
         ORDER BY ra.submitted_at DESC`,
        [status]
      );
      q.rows.forEach((r) => results.push({ ...r, applicationType: 'restaurant' }));
    }

    results.sort((a: any, b: any) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());

    ok(res, results);
  } catch (err) {
    logger.error({ err }, 'GET /admin/applications');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /admin/applications/:id?type=driver|restaurant
router.get('/applications/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const type = req.query.type as string;

    let row: Record<string, unknown> | null = null;

    if (type === 'driver' || !type) {
      const q = await pool.query(
        `SELECT da.*, u.first_name, u.last_name, u.email, u.phone
         FROM driver_applications da JOIN users u ON u.id = da.user_id
         WHERE da.id = $1`,
        [id]
      );
      if (q.rows.length) row = { ...q.rows[0], applicationType: 'driver' };
    }

    if (!row && (type === 'restaurant' || !type)) {
      const q = await pool.query(
        `SELECT ra.*, u.first_name, u.last_name, u.email, u.phone
         FROM restaurant_applications ra JOIN users u ON u.id = ra.user_id
         WHERE ra.id = $1`,
        [id]
      );
      if (q.rows.length) row = { ...q.rows[0], applicationType: 'restaurant' };
    }

    if (!row) {
      fail(res, 404, 'NOT_FOUND', 'Application not found.');
      return;
    }
    ok(res, row);
  } catch (err) {
    logger.error({ err }, 'GET /admin/applications/:id');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/applications/:id/approve
router.put('/applications/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.body as { type: 'driver' | 'restaurant' };
    if (!type || !['driver', 'restaurant'].includes(type)) {
      fail(res, 400, 'VALIDATION_ERROR', 'type (driver|restaurant) is required.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (type === 'driver') {
        const appRes = await client.query(
          `UPDATE driver_applications SET status='approved', reviewed_at=NOW(), reviewed_by=$2
           WHERE id=$1 AND status='pending' RETURNING user_id, vehicle_type, vehicle_make, vehicle_reg`,
          [id, req.userId]
        );
        if (!appRes.rows.length) {
          await client.query('ROLLBACK');
          fail(res, 404, 'NOT_FOUND', 'Pending driver application not found.');
          return;
        }
        const { user_id, vehicle_type, vehicle_make, vehicle_reg } = appRes.rows[0];

        // Activate user account
        await client.query(
          `UPDATE users SET approval_status='approved', approved_at=NOW(), approved_by=$2 WHERE id=$1`,
          [user_id, req.userId]
        );

        // Create driver profile (idempotent)
        await client.query(
          `INSERT INTO drivers (id, vehicle_type, vehicle_make, vehicle_reg)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET vehicle_type=$2, vehicle_make=$3, vehicle_reg=$4`,
          [user_id, vehicle_type ?? 'car', vehicle_make ?? '', vehicle_reg ?? '']
        );

        await client.query(
          `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes)
           VALUES ($1, 'approve_driver', 'driver_applications', $2, $3)`,
          [req.userId, id, `Approved driver application for user ${user_id as string}`]
        );

        await client.query('COMMIT');
        void sendPushToUser(user_id as string, 'Application Approved! 🎉', 'Congratulations! Your driver application has been approved. You can now log in to start delivering.', { type: 'approval' });

      } else {
        const appRes = await client.query(
          `UPDATE restaurant_applications SET status='approved', reviewed_at=NOW(), reviewed_by=$2
           WHERE id=$1 AND status='pending' RETURNING user_id, trading_name, address, city`,
          [id, req.userId]
        );
        if (!appRes.rows.length) {
          await client.query('ROLLBACK');
          fail(res, 404, 'NOT_FOUND', 'Pending restaurant application not found.');
          return;
        }
        const { user_id, trading_name, address, city } = appRes.rows[0];

        await client.query(
          `UPDATE users SET approval_status='approved', approved_at=NOW(), approved_by=$2 WHERE id=$1`,
          [user_id, req.userId]
        );

        // Create restaurant record (idempotent via owner_id)
        const existing = await client.query('SELECT id FROM restaurants WHERE owner_id=$1', [user_id]);
        if (!existing.rows.length) {
          const slug = (trading_name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
          await client.query(
            `INSERT INTO restaurants (name, slug, address, owner_id)
             VALUES ($1, $2, $3, $4)`,
            [trading_name, slug, `${address as string ?? ''} ${city as string ?? ''}`.trim(), user_id]
          );
        }

        await client.query(
          `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes)
           VALUES ($1, 'approve_restaurant', 'restaurant_applications', $2, $3)`,
          [req.userId, id, `Approved restaurant application for user ${user_id as string}`]
        );

        await client.query('COMMIT');
        void sendPushToUser(user_id as string, 'Application Approved! 🎉', 'Your restaurant has been approved. You can now log in to manage your restaurant on Empire Deliveries.', { type: 'approval' });
      }

      ok(res, { approved: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'PUT /admin/applications/:id/approve');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/applications/:id/reject
router.put('/applications/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { type, reason } = req.body as { type: 'driver' | 'restaurant'; reason?: string };
    if (!type || !['driver', 'restaurant'].includes(type)) {
      fail(res, 400, 'VALIDATION_ERROR', 'type (driver|restaurant) is required.');
      return;
    }

    const table = type === 'driver' ? 'driver_applications' : 'restaurant_applications';
    const appRes = await pool.query(
      `UPDATE ${table} SET status='rejected', rejection_reason=$2, reviewed_at=NOW(), reviewed_by=$3
       WHERE id=$1 AND status='pending' RETURNING user_id`,
      [id, reason ?? null, req.userId]
    );
    if (!appRes.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Pending application not found.');
      return;
    }
    const userId = appRes.rows[0].user_id as string;

    await pool.query(
      `UPDATE users SET approval_status='rejected' WHERE id=$1`,
      [userId]
    );
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes) VALUES ($1,$2,$3,$4,$5)`,
      [req.userId, `reject_${type}`, table, id, reason ?? '']
    );

    void sendPushToUser(userId, 'Application Update', `Your ${type} application was not approved. ${reason ? 'Reason: ' + reason : 'Please contact support for more information.'}`, { type: 'rejection' });

    ok(res, { rejected: true });
  } catch (err) {
    logger.error({ err }, 'PUT /admin/applications/:id/reject');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── User Management ──────────────────────────────────────────────────────────

// GET /admin/users?search=&role=&status=&page=1&limit=20
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const search = (req.query.search as string) ?? '';
    const role = (req.query.role as string) ?? '';
    const status = (req.query.status as string) ?? '';
    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10));
    const limit = Math.min(50, parseInt((req.query.limit as string) ?? '20', 10));
    const offset = (page - 1) * limit;

    const params: unknown[] = [`%${search}%`, limit, offset];
    let where = `WHERE (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)`;

    if (role) { params.push(role); where += ` AND role = $${params.length}`; }
    if (status) { params.push(status); where += ` AND approval_status = $${params.length}`; }

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, first_name, last_name, email, phone, role, approval_status, is_verified, created_at
         FROM users ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        params
      ),
      pool.query(`SELECT COUNT(*) FROM users ${where}`, [params[0], ...params.slice(3)]),
    ]);

    ok(res, {
      data: dataRes.rows.map((u) => ({
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        approvalStatus: u.approval_status,
        isVerified: u.is_verified,
        createdAt: u.created_at,
      })),
      total: parseInt(countRes.rows[0].count as string, 10),
      page,
      limit,
    });
  } catch (err) {
    logger.error({ err }, 'GET /admin/users');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/users/:id/suspend
router.put('/users/:id/suspend', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    const result = await pool.query(
      `UPDATE users SET approval_status='suspended', suspension_reason=$2
       WHERE id=$1 AND role != 'admin' RETURNING id`,
      [req.params.id, reason ?? null]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found or cannot suspend admin accounts.');
      return;
    }
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes) VALUES ($1,'suspend_user','users',$2,$3)`,
      [req.userId, req.params.id, reason ?? '']
    );
    // Invalidate all refresh tokens so they're immediately logged out
    await pool.query('DELETE FROM refresh_tokens WHERE user_id=$1', [req.params.id]);
    ok(res, { suspended: true });
  } catch (err) {
    logger.error({ err }, 'PUT /admin/users/:id/suspend');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/users/:id/reactivate
router.put('/users/:id/reactivate', async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `UPDATE users SET approval_status='approved', suspension_reason=NULL WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id) VALUES ($1,'reactivate_user','users',$2)`,
      [req.userId, req.params.id]
    );
    ok(res, { reactivated: true });
  } catch (err) {
    logger.error({ err }, 'PUT /admin/users/:id/reactivate');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
