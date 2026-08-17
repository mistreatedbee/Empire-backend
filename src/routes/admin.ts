import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAdmin, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';
import { notify } from '../utils/notify';
import { sendTransactionalEmail } from '../utils/email';
import { mapApplicationRow } from '../utils/serializers';

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
    const pendingWithdrawals = await pool.query(
      `SELECT COUNT(*) AS cnt FROM withdrawal_requests WHERE status='pending'`,
    );
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
      pendingWithdrawals: Number(pendingWithdrawals.rows[0]?.cnt ?? 0),
    });
  } catch (err) {
    logger.error({ err }, 'GET /admin/stats');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Applications ─────────────────────────────────────────────────────────────

// GET /admin/applications?type=driver|restaurant|all&status=pending|approved|rejected
router.get('/applications', async (req: AuthRequest, res: Response) => {
  try {
    const type = (req.query.type as string) || 'all';
    const status = (req.query.status as string) || 'pending';

    const results: Record<string, unknown>[] = [];
    const seenUserIds = new Set<string>();

    if (type === 'driver' || type === 'all') {
      const q = await pool.query(
        `SELECT da.*, u.first_name, u.last_name, u.email, u.phone, u.approval_status AS user_approval_status
         FROM driver_applications da
         JOIN users u ON u.id = da.user_id
         WHERE ($1 = 'all' OR da.status = $1)
         ORDER BY da.submitted_at DESC`,
        [status]
      );
      q.rows.forEach((r) => {
        seenUserIds.add(r.user_id as string);
        results.push(mapApplicationRow({ ...r, applicationType: 'driver' }));
      });
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
      q.rows.forEach((r) => {
        seenUserIds.add(r.user_id as string);
        results.push(mapApplicationRow({ ...r, applicationType: 'restaurant' }));
      });
    }

    // Pending users who registered but never submitted step 4
    if (status === 'pending') {
      const roleFilter =
        type === 'driver' ? "role = 'driver'" :
        type === 'restaurant' ? "role = 'restaurant'" :
        "role IN ('driver', 'restaurant')";

      const orphans = await pool.query(
        `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, u.phone, u.role, u.approval_status
         FROM users u
         WHERE u.approval_status = 'pending' AND ${roleFilter}
         ORDER BY u.created_at DESC`
      );

      for (const u of orphans.rows) {
        if (seenUserIds.has(u.user_id as string)) continue;
        results.push(mapApplicationRow({
          id: u.user_id,
          user_id: u.user_id,
          first_name: u.first_name,
          last_name: u.last_name,
          email: u.email,
          phone: u.phone,
          status: 'pending',
          submitted_at: null,
          applicationType: u.role as 'driver' | 'restaurant',
          incompleteSignup: true,
        }));
      }
    }

    results.sort((a, b) => {
      const aTime = a.submittedAt ? new Date(a.submittedAt as string).getTime() : 0;
      const bTime = b.submittedAt ? new Date(b.submittedAt as string).getTime() : 0;
      return bTime - aTime;
    });

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
    ok(res, mapApplicationRow(row));
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
        const applicantEmail = await pool.query('SELECT email, first_name FROM users WHERE id=$1', [user_id]);
        const email = applicantEmail.rows[0]?.email as string | undefined;
        const name = applicantEmail.rows[0]?.first_name as string | undefined;
        void notify(user_id as string, 'approval', 'Application Approved! 🎉', 'Congratulations! Your driver application has been approved. You can now log in to start delivering.', { type: 'approval' });
        if (email) {
          void sendTransactionalEmail(
            email,
            'Your Empire Deliveries driver application was approved',
            `Hi ${name ?? 'there'},\n\nYour driver application has been approved. Open the Empire Deliveries app to start delivering.`,
          );
        }

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
        const applicantEmail = await pool.query('SELECT email, first_name FROM users WHERE id=$1', [user_id]);
        const email = applicantEmail.rows[0]?.email as string | undefined;
        const name = applicantEmail.rows[0]?.first_name as string | undefined;
        void notify(user_id as string, 'approval', 'Application Approved! 🎉', 'Your restaurant has been approved. You can now log in to manage your restaurant on Empire Deliveries.', { type: 'approval' });
        if (email) {
          void sendTransactionalEmail(
            email,
            'Your Empire Deliveries restaurant application was approved',
            `Hi ${name ?? 'there'},\n\nYour restaurant application has been approved. Open the Empire Deliveries app to manage your restaurant.`,
          );
        }
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
    const userRow = await pool.query('SELECT email, first_name FROM users WHERE id=$1', [userId]);
    const email = userRow.rows[0]?.email as string | undefined;
    const name = userRow.rows[0]?.first_name as string | undefined;
    const rejectionMsg = `Your ${type} application was not approved. ${reason ? 'Reason: ' + reason : 'Please contact support for more information.'}`;

    await pool.query(
      `UPDATE users SET approval_status='rejected' WHERE id=$1`,
      [userId]
    );
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes) VALUES ($1,$2,$3,$4,$5)`,
      [req.userId, `reject_${type}`, table, id, reason ?? '']
    );

    void notify(userId, 'rejection', 'Application Update', rejectionMsg, { type: 'rejection' });
    if (email) {
      void sendTransactionalEmail(
        email,
        'Update on your Empire Deliveries application',
        `Hi ${name ?? 'there'},\n\n${rejectionMsg}`,
      );
    }

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
        `SELECT id, first_name, last_name, email, phone, role, approval_status, is_verified,
                subscription_expires_at, created_at
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
        subscriptionExpiresAt: u.subscription_expires_at,
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

// PUT /admin/users/:id/role
// Body: { role: 'customer' | 'driver' | 'restaurant' | 'admin' }. Lets an
// admin correct a mis-assigned role (e.g. demote an account that ended up
// with admin access by mistake) without touching the database directly.
router.put('/users/:id/role', async (req: AuthRequest, res: Response) => {
  try {
    const { role } = req.body as { role?: string };
    const allowedRoles = ['customer', 'driver', 'restaurant', 'admin'];
    if (!role || !allowedRoles.includes(role)) {
      fail(res, 400, 'VALIDATION_ERROR', 'role must be one of customer, driver, restaurant, admin.');
      return;
    }
    if (req.params.id === req.userId) {
      fail(res, 400, 'VALIDATION_ERROR', 'You cannot change your own role.');
      return;
    }

    const result = await pool.query(
      `UPDATE users SET role=$1 WHERE id=$2 RETURNING id, email, role`,
      [role, req.params.id]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }

    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes)
       VALUES ($1,'change_role','users',$2,$3)`,
      [req.userId, req.params.id, `Role changed to ${role}`]
    );
    // Force re-login on the affected account so the role change takes effect
    // immediately rather than waiting for their current session to expire.
    await pool.query('DELETE FROM refresh_tokens WHERE user_id=$1', [req.params.id]);

    ok(res, { id: result.rows[0].id, email: result.rows[0].email, role: result.rows[0].role });
  } catch (err) {
    logger.error({ err }, 'PUT /admin/users/:id/role');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/users/:id/subscription
// Body: { expiresAt: ISO date string | null }. Null clears the expiry (unrestricted access).
router.put('/users/:id/subscription', async (req: AuthRequest, res: Response) => {
  try {
    const { expiresAt } = req.body as { expiresAt?: string | null };
    if (expiresAt != null && Number.isNaN(Date.parse(expiresAt))) {
      fail(res, 400, 'INVALID_DATE', 'expiresAt must be a valid ISO date string or null.');
      return;
    }
    const result = await pool.query(
      `UPDATE users SET subscription_expires_at=$2 WHERE id=$1 RETURNING id`,
      [req.params.id, expiresAt ?? null]
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes) VALUES ($1,'set_subscription_expiry','users',$2,$3)`,
      [req.userId, req.params.id, expiresAt ?? 'cleared']
    );
    ok(res, { subscriptionExpiresAt: expiresAt ?? null });
  } catch (err) {
    logger.error({ err }, 'PUT /admin/users/:id/subscription');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// ─── Financial overview ───────────────────────────────────────────────────────

function mapWithdrawalRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    entityType: row.entity_type ?? 'driver',
    driverId: row.driver_id ?? null,
    restaurantId: row.restaurant_id ?? null,
    amount: parseFloat(String(row.amount)),
    status: row.status,
    bankName: row.bank_name ?? null,
    bankAccountNo: row.bank_account_no ?? null,
    bankAccountType: row.bank_account_type ?? null,
    bankHolderName: row.bank_holder_name ?? null,
    adminNotes: row.admin_notes ?? null,
    processedAt: row.processed_at ?? null,
    createdAt: row.created_at,
    requesterName: row.requester_name ?? null,
    requesterEmail: row.requester_email ?? null,
    requesterPhone: row.requester_phone ?? null,
    businessName: row.business_name ?? null,
  };
}

// GET /admin/withdrawals?status=pending|approved|rejected|all&entityType=driver|restaurant|all
router.get('/withdrawals', async (req: AuthRequest, res: Response) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const entityType = (req.query.entityType as string) || 'all';
    const params: unknown[] = [];
    let where = 'WHERE 1=1';
    if (status !== 'all') {
      params.push(status);
      where += ` AND wr.status = $${params.length}`;
    }
    if (entityType !== 'all') {
      params.push(entityType);
      where += ` AND wr.entity_type = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT wr.*,
              COALESCE(du.first_name || ' ' || du.last_name, ru.first_name || ' ' || ru.last_name) AS requester_name,
              COALESCE(du.email, ru.email) AS requester_email,
              COALESCE(du.phone, ru.phone) AS requester_phone,
              res.name AS business_name
       FROM withdrawal_requests wr
       LEFT JOIN users du ON du.id = wr.driver_id
       LEFT JOIN restaurants res ON res.id = wr.restaurant_id
       LEFT JOIN users ru ON ru.id = res.owner_id
       ${where}
       ORDER BY wr.created_at DESC
       LIMIT 100`,
      params,
    );
    ok(res, result.rows.map(mapWithdrawalRow));
  } catch (err) {
    logger.error({ err }, 'GET /admin/withdrawals');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/withdrawals/:id/approve
router.put('/withdrawals/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const { notes } = req.body as { notes?: string };
    const result = await pool.query(
      `UPDATE withdrawal_requests
       SET status='approved', admin_notes=$2, processed_at=NOW(), processed_by=$3
       WHERE id=$1 AND status='pending'
       RETURNING *`,
      [req.params.id, notes ?? null, req.userId],
    );
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Pending withdrawal not found.');
      return;
    }
    const row = result.rows[0];
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes)
       VALUES ($1,'approve_withdrawal','withdrawal_requests',$2,$3)`,
      [req.userId, req.params.id, notes ?? 'Approved payout'],
    );
    const notifyUserId = row.driver_id ?? (
      await pool.query('SELECT owner_id FROM restaurants WHERE id=$1', [row.restaurant_id])
    ).rows[0]?.owner_id;
    if (notifyUserId) {
      void notify(
        notifyUserId as string,
        'payout',
        'Withdrawal Approved',
        `Your withdrawal of R${parseFloat(String(row.amount)).toFixed(2)} has been approved and will be paid out shortly.`,
        { type: 'payout' },
      );
    }
    ok(res, mapWithdrawalRow(result.rows[0]));
  } catch (err) {
    logger.error({ err }, 'PUT /admin/withdrawals/:id/approve');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// PUT /admin/withdrawals/:id/reject — refunds balance
router.put('/withdrawals/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const wrRes = await client.query(
        `SELECT * FROM withdrawal_requests WHERE id=$1 AND status='pending' FOR UPDATE`,
        [req.params.id],
      );
      if (!wrRes.rows.length) {
        await client.query('ROLLBACK');
        fail(res, 404, 'NOT_FOUND', 'Pending withdrawal not found.');
        return;
      }
      const wr = wrRes.rows[0];
      const amount = parseFloat(String(wr.amount));

      if (wr.entity_type === 'restaurant' && wr.restaurant_id) {
        await client.query(
          `UPDATE restaurants SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
          [amount, wr.restaurant_id],
        );
      } else if (wr.driver_id) {
        await client.query(
          `UPDATE drivers SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
          [amount, wr.driver_id],
        );
        await client.query(
          `INSERT INTO driver_transactions (driver_id, type, amount, description)
           VALUES ($1,'withdrawal_refund',$2,'Withdrawal rejected — funds returned')`,
          [wr.driver_id, amount],
        );
      }

      const updated = await client.query(
        `UPDATE withdrawal_requests
         SET status='rejected', admin_notes=$2, processed_at=NOW(), processed_by=$3
         WHERE id=$1 RETURNING *`,
        [req.params.id, reason ?? null, req.userId],
      );
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, notes)
         VALUES ($1,'reject_withdrawal','withdrawal_requests',$2,$3)`,
        [req.userId, req.params.id, reason ?? 'Rejected'],
      );
      await client.query('COMMIT');

      const notifyUserId = wr.driver_id ?? (
        await pool.query('SELECT owner_id FROM restaurants WHERE id=$1', [wr.restaurant_id])
      ).rows[0]?.owner_id;
      if (notifyUserId) {
        void notify(
          notifyUserId as string,
          'payout',
          'Withdrawal Declined',
          reason ?? 'Your withdrawal request could not be processed. Funds were returned to your wallet.',
          { type: 'payout' },
        );
      }
      ok(res, mapWithdrawalRow(updated.rows[0]));
    } catch (innerErr) {
      await client.query('ROLLBACK');
      throw innerErr;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'PUT /admin/withdrawals/:id/reject');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /admin/drivers — earnings & trip overview
router.get('/drivers', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.approval_status,
              d.wallet_balance, d.rating, d.total_trips, d.is_online,
              d.bank_name, d.bank_account_no, d.bank_holder_name,
              COALESCE(today.trips_today, 0) AS trips_today,
              COALESCE(today.earnings_today, 0) AS earnings_today,
              COALESCE(all_time.earnings_total, 0) AS earnings_total,
              pending.amount AS pending_withdrawal,
              pending.id AS pending_withdrawal_id
       FROM users u
       JOIN drivers d ON d.id = u.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS trips_today,
                COALESCE(SUM(da.payout), 0) AS earnings_today
         FROM driver_assignments da
         JOIN orders o ON o.id = da.order_id
         WHERE da.driver_id = u.id AND o.status = 'delivered'
           AND o.delivered_at >= CURRENT_DATE
       ) today ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(amount), 0) AS earnings_total
         FROM driver_transactions
         WHERE driver_id = u.id AND type IN ('earning', 'tip')
       ) all_time ON true
       LEFT JOIN LATERAL (
         SELECT wr.id, wr.amount
         FROM withdrawal_requests wr
         WHERE wr.driver_id = u.id AND wr.status = 'pending'
         ORDER BY wr.created_at DESC
         LIMIT 1
       ) pending ON true
       WHERE u.role = 'driver'
       ORDER BY earnings_today DESC, u.first_name ASC`,
    );
    ok(res, result.rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      phone: r.phone,
      approvalStatus: r.approval_status,
      walletBalance: parseFloat(String(r.wallet_balance ?? '0')),
      rating: parseFloat(String(r.rating ?? '5')),
      totalTrips: Number(r.total_trips ?? 0),
      isOnline: Boolean(r.is_online),
      tripsToday: Number(r.trips_today ?? 0),
      earningsToday: parseFloat(String(r.earnings_today ?? '0')),
      earningsTotal: parseFloat(String(r.earnings_total ?? '0')),
      pendingWithdrawal: r.pending_withdrawal != null ? parseFloat(String(r.pending_withdrawal)) : null,
      pendingWithdrawalId: r.pending_withdrawal_id ?? null,
      bankName: r.bank_name ?? null,
      bankAccountNo: r.bank_account_no ?? null,
      bankHolderName: r.bank_holder_name ?? null,
    })));
  } catch (err) {
    logger.error({ err }, 'GET /admin/drivers');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /admin/restaurants
router.get('/restaurants', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.address, r.is_active, r.wallet_balance,
              u.id AS owner_id, u.first_name, u.last_name, u.email, u.phone, u.approval_status,
              COALESCE(stats.orders_today, 0) AS orders_today,
              COALESCE(stats.revenue_today, 0) AS revenue_today,
              COALESCE(stats.orders_total, 0) AS orders_total,
              pending.amount AS pending_withdrawal,
              pending.id AS pending_withdrawal_id,
              ra.bank_name, ra.bank_account_no, ra.bank_holder
       FROM restaurants r
       JOIN users u ON u.id = r.owner_id
       LEFT JOIN restaurant_applications ra ON ra.user_id = u.id AND ra.status = 'approved'
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE o.placed_at >= CURRENT_DATE) AS orders_today,
                COALESCE(SUM(o.subtotal) FILTER (WHERE o.placed_at >= CURRENT_DATE AND o.status != 'cancelled'), 0) AS revenue_today,
                COUNT(*) AS orders_total
         FROM orders o WHERE o.restaurant_id = r.id AND o.status != 'cancelled'
       ) stats ON true
       LEFT JOIN LATERAL (
         SELECT wr.id, wr.amount
         FROM withdrawal_requests wr
         WHERE wr.restaurant_id = r.id AND wr.status = 'pending'
         ORDER BY wr.created_at DESC LIMIT 1
       ) pending ON true
       ORDER BY revenue_today DESC, r.name ASC`,
    );
    ok(res, result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      isActive: Boolean(r.is_active),
      walletBalance: parseFloat(String(r.wallet_balance ?? '0')),
      ownerId: r.owner_id,
      ownerName: `${r.first_name} ${r.last_name}`.trim(),
      ownerEmail: r.email,
      ownerPhone: r.phone,
      approvalStatus: r.approval_status,
      ordersToday: Number(r.orders_today ?? 0),
      revenueToday: parseFloat(String(r.revenue_today ?? '0')),
      ordersTotal: Number(r.orders_total ?? 0),
      pendingWithdrawal: r.pending_withdrawal != null ? parseFloat(String(r.pending_withdrawal)) : null,
      pendingWithdrawalId: r.pending_withdrawal_id ?? null,
      bankName: r.bank_name ?? null,
      bankAccountNo: r.bank_account_no ?? null,
      bankHolderName: r.bank_holder ?? null,
    })));
  } catch (err) {
    logger.error({ err }, 'GET /admin/restaurants');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /admin/customers
router.get('/customers', async (req: AuthRequest, res: Response) => {
  try {
    const search = (req.query.search as string) ?? '';
    const result = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.approval_status,
              u.wallet_balance, u.created_at,
              COALESCE(o.orders_total, 0) AS orders_total,
              COALESCE(o.spent_total, 0) AS spent_total,
              COALESCE(o.orders_today, 0) AS orders_today
       FROM users u
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS orders_total,
                COALESCE(SUM(total) FILTER (WHERE status != 'cancelled'), 0) AS spent_total,
                COUNT(*) FILTER (WHERE placed_at >= CURRENT_DATE) AS orders_today
         FROM orders WHERE user_id = u.id
       ) o ON true
       WHERE u.role = 'customer'
         AND ($1 = '' OR u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR u.email ILIKE $2)
       ORDER BY o.spent_total DESC NULLS LAST, u.created_at DESC
       LIMIT 100`,
      [search, `%${search}%`],
    );
    ok(res, result.rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      phone: r.phone,
      approvalStatus: r.approval_status,
      walletBalance: parseFloat(String(r.wallet_balance ?? '0')),
      ordersTotal: Number(r.orders_total ?? 0),
      ordersToday: Number(r.orders_today ?? 0),
      spentTotal: parseFloat(String(r.spent_total ?? '0')),
      createdAt: r.created_at,
    })));
  } catch (err) {
    logger.error({ err }, 'GET /admin/customers');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
