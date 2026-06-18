import { logger } from '../utils/logger';
import { Router, Response } from 'express';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { ok, fail } from '../utils/response';

const router = Router();

// GET /applications/me — get own application status
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const [driverApp, restaurantApp, userRow] = await Promise.all([
      pool.query('SELECT * FROM driver_applications WHERE user_id=$1', [userId]),
      pool.query('SELECT * FROM restaurant_applications WHERE user_id=$1', [userId]),
      pool.query('SELECT approval_status, role FROM users WHERE id=$1', [userId]),
    ]);

    if (!userRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }

    const user = userRow.rows[0];
    const driverData = driverApp.rows[0] ?? null;
    const restaurantData = restaurantApp.rows[0] ?? null;

    ok(res, {
      role: user.role,
      approvalStatus: user.approval_status,
      driverApplication: driverData
        ? {
            status: driverData.status,
            submittedAt: driverData.submitted_at,
            rejectionReason: driverData.rejection_reason,
            vehicleType: driverData.vehicle_type,
          }
        : null,
      restaurantApplication: restaurantData
        ? {
            status: restaurantData.status,
            submittedAt: restaurantData.submitted_at,
            rejectionReason: restaurantData.rejection_reason,
            tradingName: restaurantData.trading_name,
          }
        : null,
    });
  } catch (err) {
    logger.error({ err }, 'GET /applications/me');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /applications/driver — submit/update driver application details
router.post('/driver', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const userRow = await pool.query('SELECT role, approval_status FROM users WHERE id=$1', [userId]);
    if (!userRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    if (userRow.rows[0].role !== 'driver') {
      fail(res, 403, 'FORBIDDEN', 'Only driver accounts can submit driver applications.');
      return;
    }

    const {
      idNumber, dateOfBirth, vehicleType, vehicleMake, vehicleModel,
      vehicleYear, vehicleReg, bankName, bankAccountNo, bankHolder, bankBranch,
      idDocumentUrl, driversLicenseUrl, vehicleRegistrationUrl,
    } = req.body as Record<string, string>;

    await pool.query(
      `INSERT INTO driver_applications
         (user_id, id_number, date_of_birth, vehicle_type, vehicle_make, vehicle_model,
          vehicle_year, vehicle_reg, bank_name, bank_account_no, bank_holder, bank_branch,
          id_document_url, drivers_license_url, vehicle_registration_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (user_id) DO UPDATE SET
         id_number=$2, date_of_birth=$3, vehicle_type=$4, vehicle_make=$5, vehicle_model=$6,
         vehicle_year=$7, vehicle_reg=$8, bank_name=$9, bank_account_no=$10,
         bank_holder=$11, bank_branch=$12, id_document_url=$13, drivers_license_url=$14,
         vehicle_registration_url=$15, submitted_at=NOW(), status='pending'`,
      [
        userId, idNumber ?? null, dateOfBirth ?? null, vehicleType ?? null,
        vehicleMake ?? null, vehicleModel ?? null, vehicleYear ? parseInt(vehicleYear) : null,
        vehicleReg ?? null, bankName ?? null, bankAccountNo ?? null,
        bankHolder ?? null, bankBranch ?? null,
        idDocumentUrl ?? null, driversLicenseUrl ?? null, vehicleRegistrationUrl ?? null,
      ]
    );

    ok(res, { submitted: true });
  } catch (err) {
    logger.error({ err }, 'POST /applications/driver');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// POST /applications/restaurant — submit/update restaurant application details
router.post('/restaurant', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const userRow = await pool.query('SELECT role, approval_status FROM users WHERE id=$1', [userId]);
    if (!userRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'User not found.');
      return;
    }
    if (userRow.rows[0].role !== 'restaurant') {
      fail(res, 403, 'FORBIDDEN', 'Only restaurant accounts can submit restaurant applications.');
      return;
    }

    const {
      tradingName, businessRegNo, cuisineType, address, city, description,
      operatingHours, bankName, bankAccountNo, bankHolder,
      minOrder, deliveryFee, deliveryRadius,
    } = req.body as Record<string, string>;

    if (!tradingName?.trim()) {
      fail(res, 400, 'VALIDATION_ERROR', 'tradingName is required.');
      return;
    }

    await pool.query(
      `INSERT INTO restaurant_applications
         (user_id, trading_name, business_reg_no, cuisine_type, address, city, description,
          operating_hours, bank_name, bank_account_no, bank_holder,
          min_order, delivery_fee, delivery_radius)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (user_id) DO UPDATE SET
         trading_name=$2, business_reg_no=$3, cuisine_type=$4, address=$5, city=$6, description=$7,
         operating_hours=$8, bank_name=$9, bank_account_no=$10, bank_holder=$11,
         min_order=$12, delivery_fee=$13, delivery_radius=$14,
         submitted_at=NOW(), status='pending'`,
      [
        userId, tradingName.trim(), businessRegNo ?? null, cuisineType ?? null,
        address ?? null, city ?? null, description ?? null,
        operatingHours ?? null,
        bankName ?? null, bankAccountNo ?? null, bankHolder ?? null,
        minOrder ? parseFloat(minOrder) : null,
        deliveryFee ? parseFloat(deliveryFee) : null,
        deliveryRadius ? parseFloat(deliveryRadius) : null,
      ]
    );

    ok(res, { submitted: true });
  } catch (err) {
    logger.error({ err }, 'POST /applications/restaurant');
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

export default router;
