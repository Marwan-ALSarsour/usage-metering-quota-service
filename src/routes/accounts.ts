import { Router, Request, Response, NextFunction } from 'express';
import { requireAccountAuth } from '../middleware/auth';
import { isValidUuid } from '../utils/validation';
import { db } from '../db';
import { accounts } from '../db/schema/accounts';
import { plans } from '../db/schema/plans';
import { eq, and, or, isNull } from 'drizzle-orm';

export const accountsRouter = Router();

accountsRouter.use(requireAccountAuth);

/**
 * GET /api/v1/accounts/me
 * Returns authenticated account profile and current assigned plan.
 */
accountsRouter.get('/me', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;

    res.status(200).json({
      id: account.id,
      name: account.name,
      planId: account.planId,
      plan: {
        id: account.plan.id,
        name: account.plan.name,
        scope: account.plan.scope,
        monthlyAllowance: account.plan.monthlyAllowance,
        maxUnitsPerRequest: account.plan.maxUnitsPerRequest,
        isCustom: account.plan.isCustom,
      },
      createdAt: account.createdAt,
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * PATCH /api/v1/accounts/me/plan
 * Updates the account's assigned plan. Must be an ACCOUNT-scoped plan
 * that is either predefined or owned by this account.
 */
accountsRouter.patch('/me/plan', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const { planId } = req.body || {};

    if (!isValidUuid(planId)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Valid planId UUID is required',
      });
      return;
    }

    // Verify plan exists, is ACCOUNT-scoped, and is accessible to this account
    const planResult = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.id, planId),
          or(
            and(eq(plans.isCustom, false), isNull(plans.accountId)),
            eq(plans.accountId, account.id)
          )
        )
      )
      .limit(1);

    if (planResult.length === 0) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Plan not found or not accessible',
      });
      return;
    }

    const newPlan = planResult[0];
    if (newPlan.scope !== 'ACCOUNT') {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Plan '${newPlan.name}' is a ${newPlan.scope} plan and cannot be assigned to an account`,
      });
      return;
    }

    const updated = await db
      .update(accounts)
      .set({
        planId: newPlan.id,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id))
      .returning();

    res.status(200).json({
      id: updated[0].id,
      name: updated[0].name,
      planId: updated[0].planId,
      plan: {
        id: newPlan.id,
        name: newPlan.name,
        scope: newPlan.scope,
        monthlyAllowance: newPlan.monthlyAllowance,
        maxUnitsPerRequest: newPlan.maxUnitsPerRequest,
        isCustom: newPlan.isCustom,
      },
      updatedAt: updated[0].updatedAt,
    });
  } catch (error: any) {
    next(error);
  }
});
