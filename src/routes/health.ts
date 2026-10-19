import { Router, Request, Response } from 'express';
import { db } from '../db';
import { sql } from 'drizzle-orm';

export const healthRouter = Router();

healthRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error?.message || 'Database connection error',
    });
  }
});
