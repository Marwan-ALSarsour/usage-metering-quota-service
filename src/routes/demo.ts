import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { plans } from '../db/schema/plans';
import { createAccount, AccountCreationError } from '../services/accountService';
import { eq, and, isNull } from 'drizzle-orm';

export const demoRouter = Router();

/**
 * GET /api/v1/demo/plans
 * Returns the list of predefined plans so the demo UI can
 * populate plan dropdowns without hard-coding plan IDs.
 * Predefined plans are public metadata and safe to expose.
 */
demoRouter.get('/plans', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const predefinedPlans = await db
      .select({
        id: plans.id,
        name: plans.name,
        scope: plans.scope,
        monthlyAllowance: plans.monthlyAllowance,
        maxUnitsPerRequest: plans.maxUnitsPerRequest,
      })
      .from(plans)
      .where(and(eq(plans.isCustom, false), isNull(plans.accountId)));

    res.status(200).json({ plans: predefinedPlans });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/demo/create-account
 * Server-side proxy for creating a demo account.
 * Reuses the shared account-creation service logic identically to the admin route.
 * Does not require or log ADMIN_API_KEY.
 *
 * Body: { name: string, planId: string }
 * Returns: { id, name, planId, apiKey, createdAt }
 */
demoRouter.post(
  '/create-account',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await createAccount(req.body);
      res.status(201).json(result);
    } catch (error: any) {
      if (error instanceof AccountCreationError) {
        res.status(error.status).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      next(error);
    }
  }
);
