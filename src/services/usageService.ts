import { db } from '../db';
import { users } from '../db/schema/users';
import { accounts } from '../db/schema/accounts';
import { plans } from '../db/schema/plans';
import { accountMonthlyUsage, userMonthlyUsage } from '../db/schema/usage';
import { usageRecords } from '../db/schema/records';
import { getUtcPeriod, hashPayload } from '../utils/period';
import { eq, and, sql } from 'drizzle-orm';

export type UsageOutcomeStatus = 'ACCEPTED' | 'REJECTED';

export type RejectionReason =
  | 'ACCOUNT_MAX_PER_REQUEST_EXCEEDED'
  | 'USER_MAX_PER_REQUEST_EXCEEDED'
  | 'ACCOUNT_MONTHLY_QUOTA_EXCEEDED'
  | 'USER_MONTHLY_QUOTA_EXCEEDED';

export interface RecordUsageInput {
  accountId: string;
  userId: string;
  units: number;
  clientRequestId: string;
  period?: string;
}

export interface UsageResult {
  isConflict?: boolean;
  status: UsageOutcomeStatus;
  requestId: string;
  unitsRequested: number;
  unitsConsumed: number;
  period: string;
  rejectionReason: RejectionReason | null;
  message?: string;
  createdAt: Date;
  accountUsage?: {
    used: number;
    allowance: number;
  };
  userUsage?: {
    used: number;
    allowance: number;
  };
}

export class UserNotFoundError extends Error {
  constructor(message = 'User not found or does not belong to this account') {
    super(message);
    this.name = 'UserNotFoundError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(message = 'Account not found') {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

/**
 * Atomically validates quotas and records usage under strict row-level locking.
 * Idempotency is verified using clientRequestId and payload hash.
 */
export async function recordUsage(input: RecordUsageInput): Promise<UsageResult> {
  const { accountId, userId, units, clientRequestId } = input;
  const period = input.period || getUtcPeriod();
  const payloadHash = hashPayload(userId, units);

  // Fast pre-check: Look for an existing record with this clientRequestId
  const cachedRecord = await db
    .select()
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.accountId, accountId),
        eq(usageRecords.clientRequestId, clientRequestId)
      )
    )
    .limit(1);

  if (cachedRecord.length > 0) {
    const record = cachedRecord[0];
    if (record.payloadHash !== payloadHash) {
      return {
        isConflict: true,
        status: 'REJECTED',
        requestId: clientRequestId,
        unitsRequested: units,
        unitsConsumed: 0,
        period,
        rejectionReason: null,
        message: 'Request identifier reused with different request payload',
        createdAt: record.createdAt,
      };
    }

    // Identical retry: return previously recorded result without consuming quota
    return {
      status: record.status as UsageOutcomeStatus,
      requestId: record.clientRequestId,
      unitsRequested: record.unitsRequested,
      unitsConsumed: record.unitsConsumed,
      period: record.period,
      rejectionReason: record.rejectionReason as RejectionReason | null,
      createdAt: record.createdAt,
      message:
        record.status === 'ACCEPTED'
          ? 'Usage request previously accepted (idempotent replay)'
          : `Usage request previously rejected: ${record.rejectionReason} (idempotent replay)`,
    };
  }

  // Execute atomic evaluation and consumption in a database transaction
  try {
    return await db.transaction(async (tx) => {
      // Re-check for concurrent identical request inside transaction
      const inTxRecord = await tx
        .select()
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.accountId, accountId),
            eq(usageRecords.clientRequestId, clientRequestId)
          )
        )
        .limit(1);

      if (inTxRecord.length > 0) {
        const record = inTxRecord[0];
        if (record.payloadHash !== payloadHash) {
          return {
            isConflict: true,
            status: 'REJECTED',
            requestId: clientRequestId,
            unitsRequested: units,
            unitsConsumed: 0,
            period,
            rejectionReason: null,
            message: 'Request identifier reused with different request payload',
            createdAt: record.createdAt,
          };
        }
        return {
          status: record.status as UsageOutcomeStatus,
          requestId: record.clientRequestId,
          unitsRequested: record.unitsRequested,
          unitsConsumed: record.unitsConsumed,
          period: record.period,
          rejectionReason: record.rejectionReason as RejectionReason | null,
          createdAt: record.createdAt,
          message:
            record.status === 'ACCEPTED'
              ? 'Usage request previously accepted (idempotent replay)'
              : `Usage request previously rejected: ${record.rejectionReason} (idempotent replay)`,
        };
      }

      // Verify User ownership and load current user plan
      const userResult = await tx
        .select({
          user: users,
          plan: plans,
        })
        .from(users)
        .innerJoin(plans, eq(users.planId, plans.id))
        .where(and(eq(users.id, userId), eq(users.accountId, accountId)))
        .limit(1);

      if (userResult.length === 0) {
        throw new UserNotFoundError();
      }

      const user = userResult[0].user;
      const userPlan = userResult[0].plan;

      // Load Account and current account plan
      const accountResult = await tx
        .select({
          account: accounts,
          plan: plans,
        })
        .from(accounts)
        .innerJoin(plans, eq(accounts.planId, plans.id))
        .where(eq(accounts.id, accountId))
        .limit(1);

      if (accountResult.length === 0) {
        throw new AccountNotFoundError();
      }

      const accountPlan = accountResult[0].plan;

      // ─── DETERMINISTIC LOCK ORDERING ─────────────────────────────────────
      // 1. Lock Account Monthly Counter FIRST
      await tx.execute(sql`
        INSERT INTO account_monthly_usage (account_id, period, units_used)
        VALUES (${accountId}, ${period}, 0)
        ON CONFLICT (account_id, period) DO NOTHING
      `);

      const lockedAccountUsage = await tx.execute<{ id: string; units_used: number }>(sql`
        SELECT id, units_used FROM account_monthly_usage
        WHERE account_id = ${accountId} AND period = ${period}
        FOR UPDATE
      `);

      const currentAccountUnits = Number(lockedAccountUsage[0]?.units_used || 0);

      // 2. Lock User Monthly Counter SECOND
      await tx.execute(sql`
        INSERT INTO user_monthly_usage (user_id, account_id, period, units_used)
        VALUES (${userId}, ${accountId}, ${period}, 0)
        ON CONFLICT (user_id, period) DO NOTHING
      `);

      const lockedUserUsage = await tx.execute<{ id: string; units_used: number }>(sql`
        SELECT id, units_used FROM user_monthly_usage
        WHERE user_id = ${userId} AND period = ${period}
        FOR UPDATE
      `);

      const currentUserUnits = Number(lockedUserUsage[0]?.units_used || 0);

      // ─── QUOTA EVALUATION RULES ───────────────────────────────────────────
      let rejectionReason: RejectionReason | null = null;
      let rejectionMessage = '';

      // Rule 1: User plan maximum per request
      if (units > userPlan.maxUnitsPerRequest) {
        rejectionReason = 'USER_MAX_PER_REQUEST_EXCEEDED';
        rejectionMessage = `Request of ${units} units exceeds user plan maximum of ${userPlan.maxUnitsPerRequest} units per request`;
      }
      // Rule 2: Account plan maximum per request
      else if (units > accountPlan.maxUnitsPerRequest) {
        rejectionReason = 'ACCOUNT_MAX_PER_REQUEST_EXCEEDED';
        rejectionMessage = `Request of ${units} units exceeds account plan maximum of ${accountPlan.maxUnitsPerRequest} units per request`;
      }
      // Rule 3: User monthly allowance
      else if (currentUserUnits + units > userPlan.monthlyAllowance) {
        rejectionReason = 'USER_MONTHLY_QUOTA_EXCEEDED';
        rejectionMessage = `Request of ${units} units exceeds user monthly allowance (${currentUserUnits}/${userPlan.monthlyAllowance} used)`;
      }
      // Rule 4: Account monthly allowance
      else if (currentAccountUnits + units > accountPlan.monthlyAllowance) {
        rejectionReason = 'ACCOUNT_MONTHLY_QUOTA_EXCEEDED';
        rejectionMessage = `Request of ${units} units exceeds account monthly allowance (${currentAccountUnits}/${accountPlan.monthlyAllowance} used)`;
      }

      // ─── RECORD OUTCOME ──────────────────────────────────────────────────
      if (rejectionReason !== null) {
        // REJECTED: Do NOT increment counters, but record outcome in history
        const inserted = await tx
          .insert(usageRecords)
          .values({
            accountId,
            userId,
            clientRequestId,
            unitsRequested: units,
            unitsConsumed: 0,
            status: 'REJECTED',
            rejectionReason,
            period,
            payloadHash,
          })
          .returning();

        return {
          status: 'REJECTED',
          requestId: clientRequestId,
          unitsRequested: units,
          unitsConsumed: 0,
          period,
          rejectionReason,
          message: rejectionMessage,
          createdAt: inserted[0].createdAt,
          accountUsage: {
            used: currentAccountUnits,
            allowance: accountPlan.monthlyAllowance,
          },
          userUsage: {
            used: currentUserUnits,
            allowance: userPlan.monthlyAllowance,
          },
        };
      }

      // ACCEPTED: Atomically increment both counters
      const newAccountUnits = currentAccountUnits + units;
      const newUserUnits = currentUserUnits + units;

      await tx.execute(sql`
        UPDATE account_monthly_usage
        SET units_used = ${newAccountUnits}, updated_at = NOW()
        WHERE account_id = ${accountId} AND period = ${period}
      `);

      await tx.execute(sql`
        UPDATE user_monthly_usage
        SET units_used = ${newUserUnits}, updated_at = NOW()
        WHERE user_id = ${userId} AND period = ${period}
      `);

      const inserted = await tx
        .insert(usageRecords)
        .values({
          accountId,
          userId,
          clientRequestId,
          unitsRequested: units,
          unitsConsumed: units,
          status: 'ACCEPTED',
          rejectionReason: null,
          period,
          payloadHash,
        })
        .returning();

      return {
        status: 'ACCEPTED',
        requestId: clientRequestId,
        unitsRequested: units,
        unitsConsumed: units,
        period,
        rejectionReason: null,
        message: `Successfully recorded ${units} usage units`,
        createdAt: inserted[0].createdAt,
        accountUsage: {
          used: newAccountUnits,
          allowance: accountPlan.monthlyAllowance,
        },
        userUsage: {
          used: newUserUnits,
          allowance: userPlan.monthlyAllowance,
        },
      };
    });
  } catch (error: any) {
    // If concurrent duplicate hit unique constraint on usage_records (constraint_name in postgres.js)
    const isUniqueViolation =
      error?.code === '23505' &&
      (error?.constraint_name === 'usage_records_account_req_id_idx' ||
        error?.constraint === 'usage_records_account_req_id_idx' ||
        String(error?.message).includes('usage_records_account_req_id_idx') ||
        error?.table_name === 'usage_records');

    if (isUniqueViolation) {
      // Query winning record using the connection pool outside the aborted transaction
      const raceWinner = await db
        .select()
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.accountId, accountId),
            eq(usageRecords.clientRequestId, clientRequestId)
          )
        )
        .limit(1);

      if (raceWinner.length > 0) {
        const record = raceWinner[0];
        if (record.payloadHash !== payloadHash) {
          return {
            isConflict: true,
            status: 'REJECTED',
            requestId: clientRequestId,
            unitsRequested: units,
            unitsConsumed: 0,
            period,
            rejectionReason: null,
            message: 'Request identifier reused with different request payload',
            createdAt: record.createdAt,
          };
        }
        return {
          status: record.status as UsageOutcomeStatus,
          requestId: record.clientRequestId,
          unitsRequested: record.unitsRequested,
          unitsConsumed: record.unitsConsumed,
          period: record.period,
          rejectionReason: record.rejectionReason as RejectionReason | null,
          createdAt: record.createdAt,
          message:
            record.status === 'ACCEPTED'
              ? 'Usage request previously accepted (idempotent replay)'
              : `Usage request previously rejected: ${record.rejectionReason} (idempotent replay)`,
        };
      }
    }
    throw error;
  }
}
