import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';

import { loadSession } from './middleware/auth.js';
import { AppError, translateDbError } from './lib/errors.js';
import { logServerError, newErrorId } from './lib/logging.js';
import { pool } from './lib/db.js';

import { authRouter } from './routes/auth.js';
import { consultantsRouter } from './routes/consultants.js';
import { skillsRouter } from './routes/skills.js';
import { clientsRouter } from './routes/clients.js';
import { requestsRouter, placementsRouter } from './routes/requests.js';
import { timesheetsRouter } from './routes/timesheets.js';
import { invoicesRouter, dashboardRouter, reportsRouter } from './routes/invoices.js';
import { notificationsRouter } from './routes/notifications.js';
import { settingsRouter } from './routes/settings.js';

export function createApp() {
  const app = express();

  app.use(
    helmet({
      // JSON API may be on a different origin from the client (CORS_ORIGIN).
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(hpp());
  app.use(cookieParser());
  app.use(loadSession);

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'connected' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/consultants', consultantsRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/requests', requestsRouter);
  app.use('/api/placements', placementsRouter);
  app.use('/api/timesheets', timesheetsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/settings', settingsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint' });
  });

  // Business rules live in the database, so a constraint or trigger refusal
  // arrives here and becomes a message the user can act on.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    let e: AppError;
    if (err instanceof AppError) {
      e = err;
    } else if (err?.name === 'ZodError') {
      e = new AppError(400, 'Check the details you entered', 'bad_request', err.flatten?.().fieldErrors);
    } else if (err?.type === 'entity.too.large') {
      // The body limit is a rejection, not a fault: it must not become a 5xx.
      e = new AppError(413, 'That request is too large.', 'payload_too_large');
    } else if (err?.type === 'entity.parse.failed') {
      e = new AppError(400, 'The request body is not valid JSON.', 'bad_request');
    } else if (err?.code && typeof err.code === 'string' && err.code.length === 5) {
      e = translateDbError(err);
    } else {
      e = new AppError(500, 'Something went wrong', 'server_error',
        process.env.NODE_ENV === 'production' ? undefined : err?.message);
    }

    if (e.status >= 500) {
      const errorId = newErrorId();
      logServerError(errorId, err, req.method, req.path);
      res.status(e.status).json({ error: e.code, message: e.message, detail: e.detail, errorId });
      return;
    }
    res.status(e.status).json({ error: e.code, message: e.message, detail: e.detail });
  });

  return app;
}

const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 4000);
  createApp().listen(port, () => {
    console.log(`Rasibe CPMS API listening on http://localhost:${port}`);
    console.log(`Health: http://localhost:${port}/api/health`);
  });
}
