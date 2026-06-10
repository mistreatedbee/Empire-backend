import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRouter from './routes/auth';
import devRouter from './routes/dev';
import categoriesRouter from './routes/categories';
import restaurantsRouter from './routes/restaurants';
import usersRouter from './routes/users';
import ordersRouter from './routes/orders';
import paymentsRouter from './routes/payments';
import couponsRouter from './routes/coupons';
import notificationsRouter from './routes/notifications';

const app = express();

app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', authRouter);
app.use('/dev', devRouter);
app.use('/categories', categoriesRouter);
app.use('/restaurants', restaurantsRouter);
app.use('/users', usersRouter);
app.use('/orders', ordersRouter);
app.use('/payments', paymentsRouter);
app.use('/coupons', couponsRouter);
app.use('/notifications', notificationsRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ code: 'SERVER_ERROR', message: 'An unexpected error occurred.' });
});

export default app;
