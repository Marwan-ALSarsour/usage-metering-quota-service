import { Router, Request, Response, NextFunction } from 'express';
import { requireAccountAuth } from '../middleware/auth';
import {
  isNonEmptyString,
  isPositiveInteger,
  isValidUuid,
  isValidPeriod,
  isValidUsageStatus,
} from '../utils/validation';
import { recordUsage, UserNotFoundError, AccountNotFoundError } from '../services/usageService';
import {
  getAccountUsageSummary,
  getMonthlyReport,
  getUsageHistory,
} from '../services/reportService';
import { db } from '../db';
import { users } from '../db/schema/users';
import { eq, and } from 'drizzle-orm';

export const usageRouter = Router();

usageRouter.use(requireAccountAuth);

/**
 * GET /api/v1/usage/summary
 * Returns the authenticated account's current UTC-month usage, monthly allowance,
 * remaining quota, and a per-user breakdown.
 */
usageRouter.get('/summary', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const summary = await getAccountUsageSummary(account.id);
    res.status(200).json(summary);
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/v1/usage/reports/monthly?period=YYYY-MM
 * Returns historical monthly aggregate usage and per-user breakdown for a requested valid period.
 */
usageRouter.get('/reports/monthly', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const { period } = req.query;

    if (!isValidPeriod(period)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Valid period query parameter is required in YYYY-MM format (e.g. ?period=2026-10)',
      });
      return;
    }

    const report = await getMonthlyReport(account.id, period);
    res.status(200).json(report);
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/v1/usage/history?page=1&limit=20&userId=...&status=...
 * Returns a paginated usage request ledger with optional user and status filters.
 */
usageRouter.get('/history', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const { page, limit, userId, status } = req.query;

    let parsedPage: number | undefined;
    if (page !== undefined) {
      parsedPage = Number(page);
      if (!Number.isInteger(parsedPage) || parsedPage < 1) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'page must be a positive integer >= 1',
        });
        return;
      }
    }

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'limit must be an integer between 1 and 100',
        });
        return;
      }
    }

    let filterUserId: string | undefined;
    if (userId !== undefined) {
      if (!isValidUuid(userId)) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'Invalid userId UUID format',
        });
        return;
      }

      // Verify user belongs to this account (strict tenant isolation)
      const userExists = await db
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.accountId, account.id)))
        .limit(1);

      if (userExists.length === 0) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: 'User not found or does not belong to this account',
        });
        return;
      }

      filterUserId = userId;
    }

    let filterStatus: 'ACCEPTED' | 'REJECTED' | undefined;
    if (status !== undefined) {
      if (!isValidUsageStatus(status)) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: "status must be either 'ACCEPTED' or 'REJECTED'",
        });
        return;
      }
      filterStatus = status;
    }

    const history = await getUsageHistory(account.id, {
      page: parsedPage,
      limit: parsedLimit,
      userId: filterUserId,
      status: filterStatus,
    });

    res.status(200).json(history);
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/usage
 * Atomically validates quotas and consumes usage units against both the account and user.
 * Supports client-provided clientRequestId for safe idempotency.
 */
usageRouter.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const account = req.account!;
    const { userId, units, clientRequestId: bodyRequestId } = req.body || {};

    // Support clientRequestId from body or Idempotency-Key header
    const headerRequestId = req.headers['idempotency-key'];
    const clientRequestId = isNonEmptyString(bodyRequestId)
      ? bodyRequestId.trim()
      : typeof headerRequestId === 'string' && headerRequestId.trim().length > 0
        ? headerRequestId.trim()
        : undefined;

    if (!isNonEmptyString(clientRequestId)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'clientRequestId is required in request body or Idempotency-Key header',
      });
      return;
    }

    if (!isValidUuid(userId)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Valid userId UUID is required',
      });
      return;
    }

    if (!isPositiveInteger(units)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'units must be a positive integer',
      });
      return;
    }

    const result = await recordUsage({
      accountId: account.id,
      userId,
      units,
      clientRequestId,
    });

    if (result.isConflict) {
      res.status(409).json({
        error: 'CONFLICT',
        message: result.message || 'Request identifier reused with different request payload',
        requestId: result.requestId,
      });
      return;
    }

    if (result.status === 'REJECTED') {
      res.status(429).json({
        status: 'REJECTED',
        error: 'QUOTA_EXCEEDED',
        reason: result.rejectionReason,
        message: result.message,
        requestId: result.requestId,
        unitsRequested: result.unitsRequested,
        unitsConsumed: 0,
        period: result.period,
        accountUsage: result.accountUsage,
        userUsage: result.userUsage,
        createdAt: result.createdAt,
      });
      return;
    }

    res.status(200).json({
      status: 'ACCEPTED',
      requestId: result.requestId,
      unitsRequested: result.unitsRequested,
      unitsConsumed: result.unitsConsumed,
      period: result.period,
      message: result.message,
      accountUsage: result.accountUsage,
      userUsage: result.userUsage,
      createdAt: result.createdAt,
    });
  } catch (error: any) {
    if (error instanceof UserNotFoundError || error instanceof AccountNotFoundError) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: error.message,
      });
      return;
    }
    next(error);
  }
});
