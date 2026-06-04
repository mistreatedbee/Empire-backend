import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRouter from './routes/auth';

const app = express();

app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', authRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ code: 'SERVER_ERROR', message: 'An unexpected error occurred.' });
});

export default app;
