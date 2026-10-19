import { Router, Request, Response, NextFunction } from 'express';
import { requireAccountAuth } from '../middleware/auth';
import { isNonEmptyString, isPositiveInteger, isValidScope, isValidUuid } from '../utils/validation';
import { db } from '../db';
import { plans } from '../db/schema/plans';
import { eq, or, and, isNull } from 'drizzle-orm';

export const plansRouter = Router();

plansRouter.use(requireAccountAuth);

/**
 * GET /api/v1/plans
 * Returns all predefined plans + custom plans belonging to the authenticated account.
 */
plansRouter.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;

    const accessiblePlans = await db
      .select()
      .from(plans)
      .where(
        or(
          and(eq(plans.isCustom, false), isNull(plans.accountId)),
          eq(plans.accountId, account.id)
        )
      );

    res.status(200).json({ plans: accessiblePlans });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/v1/plans/:id
 * Returns a specific plan by ID if predefined or owned by the authenticated account.
 */
plansRouter.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const account = req.account!;

    if (!isValidUuid(id)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Invalid plan ID format',
      });
      return;
    }

    const result = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.id, id),
          or(
            and(eq(plans.isCustom, false), isNull(plans.accountId)),
            eq(plans.accountId, account.id)
          )
        )
      )
      .limit(1);

    if (result.length === 0) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Plan not found',
      });
      return;
    }

    res.status(200).json(result[0]);
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/plans
 * Creates a custom plan owned by the authenticated account.
 */
plansRouter.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const { name, scope, monthlyAllowance, maxUnitsPerRequest } = req.body || {};

    if (!isNonEmptyString(name)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Plan name must be a non-empty string',
      });
      return;
    }

    if (!isValidScope(scope)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: "Scope must be either 'ACCOUNT' or 'USER'",
      });
      return;
    }

    if (!isPositiveInteger(monthlyAllowance)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'monthlyAllowance must be a positive integer',
      });
      return;
    }

    if (!isPositiveInteger(maxUnitsPerRequest)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'maxUnitsPerRequest must be a positive integer',
      });
      return;
    }

    if (maxUnitsPerRequest > monthlyAllowance) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'maxUnitsPerRequest cannot exceed monthlyAllowance',
      });
      return;
    }

    // Check for existing plan with the same name for this account or predefined
    const existing = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.name, name.trim()),
          eq(plans.scope, scope),
          or(isNull(plans.accountId), eq(plans.accountId, account.id))
        )
      )
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({
        error: 'CONFLICT',
        message: `A ${scope} plan named '${name.trim()}' already exists`,
      });
      return;
    }

    const inserted = await db
      .insert(plans)
      .values({
        name: name.trim(),
        scope,
        monthlyAllowance,
        maxUnitsPerRequest,
        isCustom: true,
        accountId: account.id,
      })
      .returning();

    res.status(201).json(inserted[0]);
  } catch (error: any) {
    next(error);
  }
});

/**
 * PUT /api/v1/plans/:id
 * Updates an account-owned custom plan. Predefined plans cannot be modified.
 */
plansRouter.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const account = req.account!;
    const { name, monthlyAllowance, maxUnitsPerRequest } = req.body || {};

    if (!isValidUuid(id)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Invalid plan ID format',
      });
      return;
    }

    // Check if plan exists
    const existingResult = await db
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .limit(1);

    if (existingResult.length === 0) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Plan not found',
      });
      return;
    }

    const planToUpdate = existingResult[0];

    // Predefined plans are strictly read-only
    if (!planToUpdate.isCustom || planToUpdate.accountId === null) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Predefined plans are read-only and cannot be modified',
      });
      return;
    }

    // Cross-account isolation: cannot edit another account's plan
    if (planToUpdate.accountId !== account.id) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Plan not found',
      });
      return;
    }

    if (!isPositiveInteger(monthlyAllowance)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'monthlyAllowance must be a positive integer',
      });
      return;
    }

    if (!isPositiveInteger(maxUnitsPerRequest)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'maxUnitsPerRequest must be a positive integer',
      });
      return;
    }

    if (maxUnitsPerRequest > monthlyAllowance) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'maxUnitsPerRequest cannot exceed monthlyAllowance',
      });
      return;
    }

    const updateData: Partial<typeof plans.$inferInsert> = {
      monthlyAllowance,
      maxUnitsPerRequest,
      updatedAt: new Date(),
    };

    if (name !== undefined) {
      if (!isNonEmptyString(name)) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'Plan name must be a non-empty string',
        });
        return;
      }

      const trimmedName = name.trim();
      if (trimmedName !== planToUpdate.name) {
        const conflict = await db
          .select()
          .from(plans)
          .where(
            and(
              eq(plans.name, trimmedName),
              eq(plans.scope, planToUpdate.scope),
              or(isNull(plans.accountId), eq(plans.accountId, account.id))
            )
          )
          .limit(1);

        if (conflict.length > 0) {
          res.status(409).json({
            error: 'CONFLICT',
            message: `A ${planToUpdate.scope} plan named '${trimmedName}' already exists`,
          });
          return;
        }
      }

      updateData.name = trimmedName;
    }

    const updated = await db
      .update(plans)
      .set(updateData)
      .where(eq(plans.id, id))
      .returning();

    res.status(200).json(updated[0]);
  } catch (error: any) {
    next(error);
  }
});
