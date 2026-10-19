import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, closeDb, TestContext } from './helpers';
import { db } from '../src/db';
import { plans } from '../src/db/schema/plans';
import { accountMonthlyUsage, userMonthlyUsage } from '../src/db/schema/usage';
import { usageRecords } from '../src/db/schema/records';
import { getUtcPeriod } from '../src/utils/period';
import { env } from '../src/config/env';
import { eq, and, sql } from 'drizzle-orm';

describe('Stage 3 — Atomic Usage Metering, Quota Enforcement & Idempotency', () => {
  let ctx: TestContext;
  let currentPeriod: string;

  // Plan IDs
  let starterPlanId: string;
  let basicPlanId: string;

  // Account 1 (Starter plan: allowance 10000, max 500)
  let account1Key: string;
  let account1Id: string;
  let user1Id: string; // Basic plan: allowance 1000, max 100

  // Account 2 for cross-account testing
  let account2Key: string;
  let account2Id: string;
  let user2Id: string;

  before(async () => {
    ctx = await startTestServer();
    currentPeriod = getUtcPeriod();

    // Fetch predefined plans
    const allPlans = await db.select().from(plans);
    starterPlanId = allPlans.find((p) => p.name === 'Starter' && p.scope === 'ACCOUNT')!.id;
    basicPlanId = allPlans.find((p) => p.name === 'Basic' && p.scope === 'USER')!.id;

    // Create Account 1
    const acc1Res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': env.ADMIN_API_KEY,
      },
      body: JSON.stringify({ name: 'Metering Test Account 1', planId: starterPlanId }),
    });
    const acc1Body = await acc1Res.json() as any;
    account1Key = acc1Body.apiKey;
    account1Id = acc1Body.id;

    // Create User 1 under Account 1
    const u1Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': account1Key,
      },
      body: JSON.stringify({ name: 'metering_user_1', planId: basicPlanId }),
    });
    const u1Body = await u1Res.json() as any;
    user1Id = u1Body.id;

    // Create Account 2 and User 2
    const acc2Res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': env.ADMIN_API_KEY,
      },
      body: JSON.stringify({ name: 'Metering Test Account 2', planId: starterPlanId }),
    });
    const acc2Body = await acc2Res.json() as any;
    account2Key = acc2Body.apiKey;
    account2Id = acc2Body.id;

    const u2Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': account2Key,
      },
      body: JSON.stringify({ name: 'metering_user_2', planId: basicPlanId }),
    });
    const u2Body = await u2Res.json() as any;
    user2Id = u2Body.id;
  });

  after(async () => {
    await ctx.close();
    await closeDb();
  });

  describe('Validation & Ownership Guarding', () => {
    it('rejects usage request without clientRequestId (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: user1Id,
          units: 10,
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.error, 'BAD_REQUEST');
      assert.match(body.message, /clientRequestId is required/i);
    });

    it('rejects usage request with invalid userId (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: 'invalid-uuid',
          units: 10,
          clientRequestId: 'req-test-1',
        }),
      });
      assert.equal(res.status, 400);
    });

    it('rejects usage request with non-positive integer units (400)', async () => {
      for (const invalidUnits of [0, -5, 10.5, '20', null]) {
        const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': account1Key,
          },
          body: JSON.stringify({
            userId: user1Id,
            units: invalidUnits,
            clientRequestId: `req-invalid-units-${String(invalidUnits)}`,
          }),
        });
        assert.equal(res.status, 400, `Expected 400 for units: ${String(invalidUnits)}`);
      }
    });

    it('rejects non-existent userId (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: '00000000-0000-0000-0000-000000000000',
          units: 10,
          clientRequestId: 'req-non-existent-user',
        }),
      });
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('rejects cross-account userId: Account 1 cannot record usage for Account 2 user (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: user2Id, // Belongs to Account 2
          units: 10,
          clientRequestId: 'req-cross-account-user',
        }),
      });
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error, 'NOT_FOUND');
    });
  });

  describe('Successful Acceptance & Quota Deduction', () => {
    it('accepts valid usage request and atomically increments both account and user counters (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: user1Id,
          units: 50,
          clientRequestId: 'req-accept-50',
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.status, 'ACCEPTED');
      assert.equal(body.requestId, 'req-accept-50');
      assert.equal(body.unitsRequested, 50);
      assert.equal(body.unitsConsumed, 50);
      assert.equal(body.period, currentPeriod);
      assert.equal(body.userUsage.used, 50);
      assert.equal(body.accountUsage.used, 50);

      // Verify in database
      const [userUsageRow] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, user1Id), eq(userMonthlyUsage.period, currentPeriod)));
      assert.equal(userUsageRow.unitsUsed, 50);

      const [accUsageRow] = await db
        .select()
        .from(accountMonthlyUsage)
        .where(and(eq(accountMonthlyUsage.accountId, account1Id), eq(accountMonthlyUsage.period, currentPeriod)));
      assert.equal(accUsageRow.unitsUsed, 50);

      const [recRow] = await db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.clientRequestId, 'req-accept-50'));
      assert.equal(recRow.status, 'ACCEPTED');
      assert.equal(recRow.unitsConsumed, 50);
      assert.equal(recRow.rejectionReason, null);
    });

    it('supports clientRequestId passed via Idempotency-Key header', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
          'Idempotency-Key': 'header-idempotent-key-1',
        },
        body: JSON.stringify({
          userId: user1Id,
          units: 20,
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.status, 'ACCEPTED');
      assert.equal(body.requestId, 'header-idempotent-key-1');
      assert.equal(body.unitsConsumed, 20);
      assert.equal(body.userUsage.used, 70); // 50 + 20
    });
  });

  describe('Quota Rejection Rules (Without Consuming Quota)', () => {
    it('rejects when unitsRequested exceeds USER_MAX_PER_REQUEST (429)', async () => {
      // Basic plan max per request is 100
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: user1Id,
          units: 150, // > 100
          clientRequestId: 'req-exceed-user-max',
        }),
      });

      assert.equal(res.status, 429);
      const body = await res.json() as any;
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.error, 'QUOTA_EXCEEDED');
      assert.equal(body.reason, 'USER_MAX_PER_REQUEST_EXCEEDED');
      assert.equal(body.unitsConsumed, 0);

      // Verify that user counter was NOT incremented (remains 70)
      const [userUsageRow] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, user1Id), eq(userMonthlyUsage.period, currentPeriod)));
      assert.equal(userUsageRow.unitsUsed, 70);

      // Verify rejection record in history
      const [recRow] = await db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.clientRequestId, 'req-exceed-user-max'));
      assert.equal(recRow.status, 'REJECTED');
      assert.equal(recRow.rejectionReason, 'USER_MAX_PER_REQUEST_EXCEEDED');
      assert.equal(recRow.unitsConsumed, 0);
    });

    it('rejects when unitsRequested exceeds ACCOUNT_MAX_PER_REQUEST (429)', async () => {
      // Create a custom account plan with low maxUnitsPerRequest (40), but high user allowance
      const customAccPlanRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Low Max Request Account Plan',
          scope: 'ACCOUNT',
          monthlyAllowance: 50000,
          maxUnitsPerRequest: 40, // Account limit is 40
        }),
      });
      const customAccPlan = await customAccPlanRes.json() as any;

      // Assign custom account plan to Account 1
      await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: customAccPlan.id }),
      });

      // Request 50 units (User plan max is 100, but Account max is 40)
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: user1Id,
          units: 50,
          clientRequestId: 'req-exceed-account-max',
        }),
      });

      assert.equal(res.status, 429);
      const body = await res.json() as any;
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.reason, 'ACCOUNT_MAX_PER_REQUEST_EXCEEDED');
      assert.equal(body.unitsConsumed, 0);

      // Restore Account 1 to Starter plan
      await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: starterPlanId }),
      });
    });

    it('rejects when unitsRequested exceeds USER_MONTHLY_QUOTA (429)', async () => {
      // Create a user with a tiny monthly allowance (80)
      const tinyUserPlanRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Tiny User Plan',
          scope: 'USER',
          monthlyAllowance: 80,
          maxUnitsPerRequest: 50,
        }),
      });
      const tinyUserPlan = await tinyUserPlanRes.json() as any;

      const newUserRes = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ name: 'tiny_quota_user', planId: tinyUserPlan.id }),
      });
      const tinyUser = await newUserRes.json() as any;

      // 1. Consume 50 units (50/80 used) -> Accepted
      const res1 = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: tinyUser.id,
          units: 50,
          clientRequestId: 'req-tiny-1',
        }),
      });
      assert.equal(res1.status, 200);

      // 2. Consume 40 units (50 + 40 = 90 > 80 allowance) -> Rejected
      const res2 = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: tinyUser.id,
          units: 40,
          clientRequestId: 'req-tiny-2',
        }),
      });
      assert.equal(res2.status, 429);
      const body2 = await res2.json() as any;
      assert.equal(body2.status, 'REJECTED');
      assert.equal(body2.reason, 'USER_MONTHLY_QUOTA_EXCEEDED');
      assert.equal(body2.unitsConsumed, 0);

      // Verify user counter remains exactly at 50
      const [usageRow] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, tinyUser.id), eq(userMonthlyUsage.period, currentPeriod)));
      assert.equal(usageRow.unitsUsed, 50);
    });

    it('rejects when unitsRequested exceeds ACCOUNT_MONTHLY_QUOTA (429)', async () => {
      // Create Account 3 with tiny account allowance (100)
      const tinyAccPlanRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Tiny Account Plan',
          scope: 'ACCOUNT',
          monthlyAllowance: 100,
          maxUnitsPerRequest: 100,
        }),
      });
      const tinyAccPlan = await tinyAccPlanRes.json() as any;

      // Assign to Account 1
      await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: tinyAccPlan.id }),
      });

      // Account 1 has already used 70 (from test 1 and 2) + 50 (from tinyUser) = 120 > 100!
      // So any further usage request must be rejected for ACCOUNT_MONTHLY_QUOTA_EXCEEDED!
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          userId: user1Id,
          units: 10,
          clientRequestId: 'req-exceed-account-monthly',
        }),
      });

      assert.equal(res.status, 429);
      const body = await res.json() as any;
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.reason, 'ACCOUNT_MONTHLY_QUOTA_EXCEEDED');
      assert.equal(body.unitsConsumed, 0);

      // Restore Account 1 to Starter plan
      await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: starterPlanId }),
      });
    });
  });

  describe('Idempotency & Retry Behaviors', () => {
    it('returns stored response on identical retry without incrementing quota', async () => {
      // Initial request
      const reqId = 'req-idempotent-repeat-1';
      const res1 = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          userId: user2Id,
          units: 25,
          clientRequestId: reqId,
        }),
      });

      assert.equal(res1.status, 200);
      const body1 = await res1.json() as any;
      assert.equal(body1.unitsConsumed, 25);

      // Fetch usage counter
      const [userUsageBefore] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, user2Id), eq(userMonthlyUsage.period, currentPeriod)));
      const countBefore = userUsageBefore.unitsUsed;

      // Repeat identical request
      const res2 = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          userId: user2Id,
          units: 25,
          clientRequestId: reqId,
        }),
      });

      assert.equal(res2.status, 200);
      const body2 = await res2.json() as any;
      assert.equal(body2.requestId, reqId);
      assert.equal(body2.unitsConsumed, 25);

      // Verify usage counter was NOT incremented again
      const [userUsageAfter] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, user2Id), eq(userMonthlyUsage.period, currentPeriod)));
      assert.equal(userUsageAfter.unitsUsed, countBefore, 'Counter must not change on identical retry');
    });

    it('rejects reuse of clientRequestId with different request payload (409 Conflict)', async () => {
      const reqId = 'req-idempotent-repeat-1'; // Already used with units: 25

      // Reuse same reqId with units: 30
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          userId: user2Id,
          units: 30, // Changed payload!
          clientRequestId: reqId,
        }),
      });

      assert.equal(res.status, 409);
      const body = await res.json() as any;
      assert.equal(body.error, 'CONFLICT');
      assert.match(body.message, /reused with different request payload/i);
    });

    it('replays previously recorded REJECTED response on retry without re-evaluation', async () => {
      const reqId = 'req-rejected-retry-1';

      // 1. Initial request exceeding user max
      const res1 = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          userId: user2Id,
          units: 999, // Exceeds max
          clientRequestId: reqId,
        }),
      });

      assert.equal(res1.status, 429);
      const body1 = await res1.json() as any;
      assert.equal(body1.status, 'REJECTED');
      assert.equal(body1.reason, 'USER_MAX_PER_REQUEST_EXCEEDED');

      // 2. Retry with same reqId and payload
      const res2 = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          userId: user2Id,
          units: 999,
          clientRequestId: reqId,
        }),
      });

      assert.equal(res2.status, 429);
      const body2 = await res2.json() as any;
      assert.equal(body2.status, 'REJECTED');
      assert.equal(body2.reason, 'USER_MAX_PER_REQUEST_EXCEEDED');
      assert.equal(body2.unitsConsumed, 0);
    });

    it('handles concurrent identical requests with same clientRequestId safely without double-counting', async () => {
      const concurrentReqId = `req-concurrent-dup-${Date.now()}`;

      // Launch 5 simultaneous requests with the EXACT same clientRequestId and payload
      const identicalRequests = Array.from({ length: 5 }, () =>
        fetch(`${ctx.baseUrl}/api/v1/usage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': account2Key,
          },
          body: JSON.stringify({
            userId: user2Id,
            units: 15,
            clientRequestId: concurrentReqId,
          }),
        }).then(async (res) => ({
          status: res.status,
          body: (await res.json()) as any,
        }))
      );

      const results = await Promise.all(identicalRequests);

      // ALL 5 requests must return 200 OK with status ACCEPTED
      for (const r of results) {
        assert.equal(r.status, 200);
        assert.equal(r.body.status, 'ACCEPTED');
        assert.equal(r.body.requestId, concurrentReqId);
        assert.equal(r.body.unitsConsumed, 15);
      }

      // Verify that in the database, ONLY ONE usage record was created with this clientRequestId
      const records = await db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.clientRequestId, concurrentReqId));
      assert.equal(records.length, 1, 'Exactly one usage record must exist in DB');
    });
  });

  describe('Concurrency & Race-Condition Safety', () => {
    it('prevents quota over-allocation under concurrent usage requests', async () => {
      // Create user with allowance of 50 units (max 10 units per request)
      const concurrencyPlanRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          name: 'Concurrency Test Plan',
          scope: 'USER',
          monthlyAllowance: 50,
          maxUnitsPerRequest: 10,
        }),
      });
      const concPlan = await concurrencyPlanRes.json() as any;

      const concUserRes = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({ name: 'concurrency_runner', planId: concPlan.id }),
      });
      const concUser = await concUserRes.json() as any;

      // Fire 10 concurrent requests of 10 units each simultaneously
      // Available allowance is 50 units -> Exactly 5 must succeed, exactly 5 must be rejected
      const concurrentRequests = Array.from({ length: 10 }, (_, i) =>
        fetch(`${ctx.baseUrl}/api/v1/usage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': account2Key,
          },
          body: JSON.stringify({
            userId: concUser.id,
            units: 10,
            clientRequestId: `req-concurrent-${i}-${Date.now()}`,
          }),
        }).then(async (res) => ({
          status: res.status,
          body: await res.json() as any,
        }))
      );

      const results = await Promise.all(concurrentRequests);

      const accepted = results.filter((r) => r.status === 200 && r.body.status === 'ACCEPTED');
      const rejected = results.filter((r) => r.status === 429 && r.body.status === 'REJECTED');

      assert.equal(accepted.length, 5, 'Exactly 5 requests must be accepted');
      assert.equal(rejected.length, 5, 'Exactly 5 requests must be rejected');

      for (const rej of rejected) {
        assert.equal(rej.body.reason, 'USER_MONTHLY_QUOTA_EXCEEDED');
      }

      // Verify database state: total consumed units must be EXACTLY 50
      const [finalUsageRow] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, concUser.id), eq(userMonthlyUsage.period, currentPeriod)));

      assert.equal(finalUsageRow.unitsUsed, 50, 'Final database usage must equal exactly 50 units without oversubscription');
    });
  });

  describe('UTC Calendar-Month Boundaries & Historical Preservation', () => {
    it('preserves usage in previous periods without affecting current month allowance', async () => {
      // Direct database verification of period isolation
      const pastPeriod = '2026-09';

      // Insert a historical counter for user1 in 2026-09 using 900 units
      await db.insert(userMonthlyUsage).values({
        userId: user1Id,
        accountId: account1Id,
        period: pastPeriod,
        unitsUsed: 900,
      });

      // Verify current month counter for user1 is unaffected
      const [currentMonthUsage] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, user1Id), eq(userMonthlyUsage.period, currentPeriod)));

      assert.ok(currentMonthUsage.unitsUsed < 900, 'Current period counter must be independent of past period');

      // Verify past month record is preserved
      const [pastMonthUsage] = await db
        .select()
        .from(userMonthlyUsage)
        .where(and(eq(userMonthlyUsage.userId, user1Id), eq(userMonthlyUsage.period, pastPeriod)));

      assert.equal(pastMonthUsage.unitsUsed, 900);
    });
  });
});
