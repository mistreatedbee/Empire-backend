import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger';
import { pool } from './db';
import authRouter from './routes/auth';
import devRouter from './routes/dev';
import categoriesRouter from './routes/categories';
import restaurantsRouter from './routes/restaurants';
import usersRouter from './routes/users';
import ordersRouter from './routes/orders';
import paymentsRouter from './routes/payments';
import couponsRouter from './routes/coupons';
import notificationsRouter from './routes/notifications';
import driversRouter from './routes/drivers';
import restaurantRouter from './routes/restaurant';
import adminRouter from './routes/admin';
import applicationsRouter from './routes/applications';
import uploadsRouter from './routes/uploads';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((o) => o.trim());
app.use(cors({
  origin: allowedOrigins.length === 1 && allowedOrigins[0] === '*' ? '*' : allowedOrigins,
  credentials: true,
}));

// 10mb to accommodate base64 proof-of-delivery photos sent by drivers
app.use(express.json({ limit: '10mb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(pinoHttp({ logger }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT', message: 'Too many requests. Please slow down.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT', message: 'Too many auth attempts. Try again later.' },
});

app.use(globalLimiter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected', timestamp: new Date().toISOString() });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', authLimiter, authRouter);
app.use('/dev', devRouter);
app.use('/categories', categoriesRouter);
app.use('/restaurants', restaurantsRouter);
app.use('/users', usersRouter);
app.use('/orders', ordersRouter);
app.use('/payments', paymentsRouter);
app.use('/coupons', couponsRouter);
app.use('/notifications', notificationsRouter);
app.use('/drivers', driversRouter);
app.use('/restaurant', restaurantRouter);
app.use('/admin', adminRouter);
app.use('/applications', applicationsRouter);
app.use('/uploads', uploadsRouter);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ code: 'SERVER_ERROR', message: 'An unexpected error occurred.' });
});

export default app;
