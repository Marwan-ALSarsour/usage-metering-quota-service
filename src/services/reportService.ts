import { db } from '../db';
import { users } from '../db/schema/users';
import { accounts } from '../db/schema/accounts';
import { plans } from '../db/schema/plans';
import { accountMonthlyUsage, userMonthlyUsage } from '../db/schema/usage';
import { usageRecords } from '../db/schema/records';
import { getUtcPeriod } from '../utils/period';
import { eq, and, sql, desc, SQL } from 'drizzle-orm';

export interface UsageSummaryResponse {
  period: string;
  account: {
    id: string;
    name: string;
    plan: {
      id: string;
      name: string;
      scope: string;
      monthlyAllowance: number;
      maxUnitsPerRequest: number;
      isCustom: boolean;
    };
    used: number;
    allowance: number;
    remaining: number;
  };
  users: Array<{
    id: string;
    name: string;
    plan: {
      id: string;
      name: string;
      scope: string;
      monthlyAllowance: number;
      maxUnitsPerRequest: number;
      isCustom: boolean;
    };
    used: number;
    allowance: number;
    remaining: number;
  }>;
}

export interface MonthlyReportResponse {
  period: string;
  accountId: string;
  summary: {
    totalRequests: number;
    acceptedRequests: number;
    rejectedRequests: number;
    totalUnitsRequested: number;
    totalUnitsConsumed: number;
  };
  userBreakdown: Array<{
    userId: string;
    userName: string;
    totalRequests: number;
    acceptedRequests: number;
    rejectedRequests: number;
    totalUnitsRequested: number;
    totalUnitsConsumed: number;
  }>;
}

export interface HistoryQueryOptions {
  page?: number;
  limit?: number;
  userId?: string;
  status?: 'ACCEPTED' | 'REJECTED';
}

export interface HistoryResponse {
  pagination: {
    page: number;
    limit: number;
    totalRecords: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  records: Array<{
    id: string;
    clientRequestId: string;
    userId: string;
    userName: string;
    unitsRequested: number;
    unitsConsumed: number;
    status: string;
    rejectionReason: string | null;
    period: string;
    createdAt: Date;
  }>;
}

/**
 * Returns current UTC-month usage summary, allowances, and user breakdown for the authenticated account.
 */
export async function getAccountUsageSummary(accountId: string): Promise<UsageSummaryResponse> {
  const currentPeriod = getUtcPeriod();

  // Load account and its plan
  const accountResult = await db
    .select({
      account: accounts,
      plan: plans,
    })
    .from(accounts)
    .innerJoin(plans, eq(accounts.planId, plans.id))
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (accountResult.length === 0) {
    throw new Error('Account not found');
  }

  const { account, plan: accountPlan } = accountResult[0];

  // Fetch account current month counter
  const accCounter = await db
    .select()
    .from(accountMonthlyUsage)
    .where(
      and(
        eq(accountMonthlyUsage.accountId, accountId),
        eq(accountMonthlyUsage.period, currentPeriod)
      )
    )
    .limit(1);

  const accountUsed = accCounter[0]?.unitsUsed || 0;
  const accountAllowance = accountPlan.monthlyAllowance;
  const accountRemaining = Math.max(0, accountAllowance - accountUsed);

  // Fetch all users under this account with their plans and their monthly usage
  const userRows = await db
    .select({
      id: users.id,
      name: users.name,
      planId: plans.id,
      planName: plans.name,
      planScope: plans.scope,
      monthlyAllowance: plans.monthlyAllowance,
      maxUnitsPerRequest: plans.maxUnitsPerRequest,
      isCustom: plans.isCustom,
      unitsUsed: userMonthlyUsage.unitsUsed,
    })
    .from(users)
    .innerJoin(plans, eq(users.planId, plans.id))
    .leftJoin(
      userMonthlyUsage,
      and(
        eq(userMonthlyUsage.userId, users.id),
        eq(userMonthlyUsage.period, currentPeriod)
      )
    )
    .where(eq(users.accountId, accountId))
    .orderBy(users.name);

  const usersSummary = userRows.map((u) => {
    const userUsed = u.unitsUsed || 0;
    const userAllowance = u.monthlyAllowance;
    const userRemaining = Math.max(0, userAllowance - userUsed);

    return {
      id: u.id,
      name: u.name,
      plan: {
        id: u.planId,
        name: u.planName,
        scope: u.planScope,
        monthlyAllowance: u.monthlyAllowance,
        maxUnitsPerRequest: u.maxUnitsPerRequest,
        isCustom: u.isCustom,
      },
      used: userUsed,
      allowance: userAllowance,
      remaining: userRemaining,
    };
  });

  return {
    period: currentPeriod,
    account: {
      id: account.id,
      name: account.name,
      plan: {
        id: accountPlan.id,
        name: accountPlan.name,
        scope: accountPlan.scope,
        monthlyAllowance: accountPlan.monthlyAllowance,
        maxUnitsPerRequest: accountPlan.maxUnitsPerRequest,
        isCustom: accountPlan.isCustom,
      },
      used: accountUsed,
      allowance: accountAllowance,
      remaining: accountRemaining,
    },
    users: usersSummary,
  };
}

/**
 * Returns historical monthly aggregate usage and per-user breakdown for a requested period.
 */
export async function getMonthlyReport(
  accountId: string,
  period: string
): Promise<MonthlyReportResponse> {
  // Aggregate summary for the account in the period
  const summaryRes = await db
    .select({
      totalRequests: sql<number>`count(*)::int`,
      acceptedRequests: sql<number>`count(*) filter (where ${usageRecords.status} = 'ACCEPTED')::int`,
      rejectedRequests: sql<number>`count(*) filter (where ${usageRecords.status} = 'REJECTED')::int`,
      totalUnitsRequested: sql<number>`coalesce(sum(${usageRecords.unitsRequested}), 0)::int`,
      totalUnitsConsumed: sql<number>`coalesce(sum(${usageRecords.unitsConsumed}), 0)::int`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.accountId, accountId), eq(usageRecords.period, period)));

  const summary = summaryRes[0] || {
    totalRequests: 0,
    acceptedRequests: 0,
    rejectedRequests: 0,
    totalUnitsRequested: 0,
    totalUnitsConsumed: 0,
  };

  // Per-user breakdown in that period
  const userBreakdownRes = await db
    .select({
      userId: usageRecords.userId,
      userName: users.name,
      totalRequests: sql<number>`count(*)::int`,
      acceptedRequests: sql<number>`count(*) filter (where ${usageRecords.status} = 'ACCEPTED')::int`,
      rejectedRequests: sql<number>`count(*) filter (where ${usageRecords.status} = 'REJECTED')::int`,
      totalUnitsRequested: sql<number>`coalesce(sum(${usageRecords.unitsRequested}), 0)::int`,
      totalUnitsConsumed: sql<number>`coalesce(sum(${usageRecords.unitsConsumed}), 0)::int`,
    })
    .from(usageRecords)
    .innerJoin(users, eq(usageRecords.userId, users.id))
    .where(and(eq(usageRecords.accountId, accountId), eq(usageRecords.period, period)))
    .groupBy(usageRecords.userId, users.name)
    .orderBy(users.name);

  return {
    period,
    accountId,
    summary,
    userBreakdown: userBreakdownRes,
  };
}

/**
 * Returns paginated usage records with optional user and status filters.
 */
export async function getUsageHistory(
  accountId: string,
  options: HistoryQueryOptions
): Promise<HistoryResponse> {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(usageRecords.accountId, accountId)];

  if (options.userId) {
    conditions.push(eq(usageRecords.userId, options.userId));
  }

  if (options.status) {
    conditions.push(eq(usageRecords.status, options.status));
  }

  const whereClause = and(...conditions);

  // Total count matching filters
  const countRes = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usageRecords)
    .where(whereClause);

  const totalRecords = countRes[0]?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalRecords / limit));

  // Query records with stable ordering
  const records = await db
    .select({
      id: usageRecords.id,
      clientRequestId: usageRecords.clientRequestId,
      userId: usageRecords.userId,
      userName: users.name,
      unitsRequested: usageRecords.unitsRequested,
      unitsConsumed: usageRecords.unitsConsumed,
      status: usageRecords.status,
      rejectionReason: usageRecords.rejectionReason,
      period: usageRecords.period,
      createdAt: usageRecords.createdAt,
    })
    .from(usageRecords)
    .innerJoin(users, eq(usageRecords.userId, users.id))
    .where(whereClause)
    .orderBy(desc(usageRecords.createdAt), desc(usageRecords.id))
    .limit(limit)
    .offset(offset);

  return {
    pagination: {
      page,
      limit,
      totalRecords,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    records,
  };
}
