import express, { Express, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { healthRouter } from './routes/health';
import { adminRouter } from './routes/admin';
import { accountsRouter } from './routes/accounts';
import { plansRouter } from './routes/plans';
import { usersRouter } from './routes/users';
import { usageRouter } from './routes/usage';
import { demoRouter } from './routes/demo';

export function createApp(): Express {
  const app = express();

  // Resolve static public directory across development (src/public) and production (dist/src/public)
  const candidatePublicDirs = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '../public'),
    path.join(process.cwd(), 'dist', 'src', 'public'),
    path.join(process.cwd(), 'src', 'public'),
  ];
  for (const dir of candidatePublicDirs) {
    if (fs.existsSync(dir)) {
      app.use(express.static(dir));
      break;
    }
  }

  app.use(express.json());

  // Mount routes
  app.use(healthRouter);
  app.use('/api/v1', adminRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/plans', plansRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/usage', usageRouter);
  app.use('/api/v1/demo', demoRouter);

  // 404 handler for unknown routes
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'The requested resource was not found',
    });
  });

  // Centralized error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    // If the error was a JSON parsing syntax error from express.json()
    if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Invalid JSON payload in request body',
      });
      return;
    }

    console.error('Unhandled server error:', err);
    res.status(err.status || 500).json({
      error: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
    });
  });

  return app;
}
