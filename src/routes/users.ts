import { Router, Request, Response, NextFunction } from 'express';
import { requireAccountAuth } from '../middleware/auth';
import { isNonEmptyString, isValidUuid } from '../utils/validation';
import { db } from '../db';
import { users } from '../db/schema/users';
import { plans } from '../db/schema/plans';
import { eq, and, or, isNull } from 'drizzle-orm';

export const usersRouter = Router();

usersRouter.use(requireAccountAuth);

/**
 * GET /api/v1/users
 * Lists all users belonging to the authenticated account.
 */
usersRouter.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;

    const result = await db
      .select({
        id: users.id,
        accountId: users.accountId,
        name: users.name,
        planId: users.planId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        plan: {
          id: plans.id,
          name: plans.name,
          scope: plans.scope,
          monthlyAllowance: plans.monthlyAllowance,
          maxUnitsPerRequest: plans.maxUnitsPerRequest,
          isCustom: plans.isCustom,
        },
      })
      .from(users)
      .innerJoin(plans, eq(users.planId, plans.id))
      .where(eq(users.accountId, account.id));

    res.status(200).json({ users: result });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/v1/users/:id
 * Gets details of a specific user. Enforces strict account isolation.
 */
usersRouter.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const account = req.account!;

    if (!isValidUuid(id)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Invalid user ID format',
      });
      return;
    }

    const result = await db
      .select({
        id: users.id,
        accountId: users.accountId,
        name: users.name,
        planId: users.planId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        plan: {
          id: plans.id,
          name: plans.name,
          scope: plans.scope,
          monthlyAllowance: plans.monthlyAllowance,
          maxUnitsPerRequest: plans.maxUnitsPerRequest,
          isCustom: plans.isCustom,
        },
      })
      .from(users)
      .innerJoin(plans, eq(users.planId, plans.id))
      .where(and(eq(users.id, id), eq(users.accountId, account.id)))
      .limit(1);

    if (result.length === 0) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'User not found',
      });
      return;
    }

    res.status(200).json(result[0]);
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/users
 * Creates a user under the authenticated account and assigns a USER-scoped plan.
 */
usersRouter.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const { name, planId } = req.body || {};

    if (!isNonEmptyString(name)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'User name must be a non-empty string',
      });
      return;
    }

    if (!isValidUuid(planId)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Valid planId UUID is required',
      });
      return;
    }

    // Verify plan exists, is USER-scoped, and is accessible to this account
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

    const plan = planResult[0];
    if (plan.scope !== 'USER') {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Plan '${plan.name}' is a ${plan.scope} plan and cannot be assigned to a user`,
      });
      return;
    }

    // Check unique name under account
    const existing = await db
      .select()
      .from(users)
      .where(and(eq(users.accountId, account.id), eq(users.name, name.trim())))
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({
        error: 'CONFLICT',
        message: `A user named '${name.trim()}' already exists in this account`,
      });
      return;
    }

    const inserted = await db
      .insert(users)
      .values({
        accountId: account.id,
        name: name.trim(),
        planId: plan.id,
      })
      .returning();

    const createdUser = inserted[0];

    res.status(201).json({
      id: createdUser.id,
      accountId: createdUser.accountId,
      name: createdUser.name,
      planId: createdUser.planId,
      plan: {
        id: plan.id,
        name: plan.name,
        scope: plan.scope,
        monthlyAllowance: plan.monthlyAllowance,
        maxUnitsPerRequest: plan.maxUnitsPerRequest,
        isCustom: plan.isCustom,
      },
      createdAt: createdUser.createdAt,
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * PATCH /api/v1/users/:id/plan
 * Updates a user's assigned plan. Must be a USER-scoped plan accessible to this account.
 */
usersRouter.patch('/:id/plan', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const account = req.account!;
    const { planId } = req.body || {};

    if (!isValidUuid(id)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Invalid user ID format',
      });
      return;
    }

    if (!isValidUuid(planId)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Valid planId UUID is required',
      });
      return;
    }

    // Check user exists and belongs to this account
    const userResult = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.accountId, account.id)))
      .limit(1);

    if (userResult.length === 0) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'User not found',
      });
      return;
    }

    // Verify plan exists, is USER-scoped, and is accessible to this account
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
    if (newPlan.scope !== 'USER') {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Plan '${newPlan.name}' is a ${newPlan.scope} plan and cannot be assigned to a user`,
      });
      return;
    }

    const updated = await db
      .update(users)
      .set({
        planId: newPlan.id,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();

    res.status(200).json({
      id: updated[0].id,
      accountId: updated[0].accountId,
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
