import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, closeDb, TestContext } from './helpers';
import { db } from '../src/db';
import { plans } from '../src/db/schema/plans';
import { accounts } from '../src/db/schema/accounts';
import { users } from '../src/db/schema/users';
import { env } from '../src/config/env';
import { eq, and, isNull } from 'drizzle-orm';

describe('Stage 6 — End-to-End Integration, Tenant Isolation & Boundary Verification', () => {
  let ctx: TestContext;
  let starterPlanId: string;
  let basicPlanId: string;

  // Account A (Primary)
  let accountAId: string;
  let accountAKey: string;
  let userA1Id: string;

  // Account B (Tenant Isolation Target)
  let accountBId: string;
  let accountBKey: string;
  let userB1Id: string;

  before(async () => {
    ctx = await startTestServer();

    // Fetch predefined plans
    const seededPlans = await db
      .select()
      .from(plans)
      .where(and(eq(plans.isCustom, false), isNull(plans.accountId)));

    starterPlanId = seededPlans.find((p) => p.name === 'Starter' && p.scope === 'ACCOUNT')!.id;
    basicPlanId = seededPlans.find((p) => p.name === 'Basic' && p.scope === 'USER')!.id;

    // 1. Provision Account A
    const accARes = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': env.ADMIN_API_KEY,
      },
      body: JSON.stringify({ name: 'Stage6 Primary Corp', planId: starterPlanId }),
    });
    assert.equal(accARes.status, 201);
    const accABody = (await accARes.json()) as any;
    accountAId = accABody.id;
    accountAKey = accABody.apiKey;

    // Create User A1
    const uA1Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': accountAKey,
      },
      body: JSON.stringify({ name: 'stage6_alice', planId: basicPlanId }),
    });
    assert.equal(uA1Res.status, 201);
    const uA1Body = (await uA1Res.json()) as any;
    userA1Id = uA1Body.id;

    // 2. Provision Account B
    const accBRes = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': env.ADMIN_API_KEY,
      },
      body: JSON.stringify({ name: 'Stage6 Foreign Corp', planId: starterPlanId }),
    });
    assert.equal(accBRes.status, 201);
    const accBBody = (await accBRes.json()) as any;
    accountBId = accBBody.id;
    accountBKey = accBBody.apiKey;

    // Create User B1
    const uB1Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': accountBKey,
      },
      body: JSON.stringify({ name: 'stage6_bob', planId: basicPlanId }),
    });
    assert.equal(uB1Res.status, 201);
    const uB1Body = (await uB1Res.json()) as any;
    userB1Id = uB1Body.id;
  });

  after(async () => {
    // Targeted cleanup of test accounts created for this suite
    try {
      if (accountAId) {
        await db.delete(accounts).where(eq(accounts.id, accountAId));
      }
      if (accountBId) {
        await db.delete(accounts).where(eq(accounts.id, accountBId));
      }
    } catch {
      // Ignore cleanup errors during shutdown
    }
    await ctx.close();
    await closeDb();
  });

  describe('Full End-to-End Lifecycle', () => {
    let customAccountPlanId: string;
    let customUserPlanId: string;

    it('creates custom ACCOUNT and USER plans for Account A', async () => {
      // Create custom ACCOUNT plan
      const cpAccRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          name: 'Stage6 Custom Enterprise',
          scope: 'ACCOUNT',
          monthlyAllowance: 50000,
          maxUnitsPerRequest: 2500,
        }),
      });
      assert.equal(cpAccRes.status, 201);
      const cpAccBody = (await cpAccRes.json()) as any;
      assert.equal(cpAccBody.isCustom, true);
      assert.equal(cpAccBody.accountId, accountAId);
      customAccountPlanId = cpAccBody.id;

      // Create custom USER plan
      const cpUserRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          name: 'Stage6 Custom Power User',
          scope: 'USER',
          monthlyAllowance: 8000,
          maxUnitsPerRequest: 800,
        }),
      });
      assert.equal(cpUserRes.status, 201);
      const cpUserBody = (await cpUserRes.json()) as any;
      assert.equal(cpUserBody.isCustom, true);
      assert.equal(cpUserBody.accountId, accountAId);
      customUserPlanId = cpUserBody.id;
    });

    it('updates Account A to use its custom account plan', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({ planId: customAccountPlanId }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.plan.id, customAccountPlanId);
      assert.equal(body.plan.name, 'Stage6 Custom Enterprise');
      assert.equal(body.plan.monthlyAllowance, 50000);
    });

    it('assigns custom USER plan to User A1', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${userA1Id}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({ planId: customUserPlanId }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.plan.id, customUserPlanId);
      assert.equal(body.plan.name, 'Stage6 Custom Power User');
      assert.equal(body.plan.monthlyAllowance, 8000);
      assert.equal(body.plan.maxUnitsPerRequest, 800);
    });

    it('enforces updated custom plan limits: allows 600 units (under 800 limit)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          userId: userA1Id,
          units: 600,
          clientRequestId: 's6-req-1',
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.status, 'ACCEPTED');
      assert.equal(body.unitsConsumed, 600);
      assert.equal(body.userUsage.used, 600);
      assert.equal(body.accountUsage.used, 600);
    });

    it('enforces updated custom plan limit: rejects 850 units (exceeds 800 user max/req)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          userId: userA1Id,
          units: 850,
          clientRequestId: 's6-req-2',
        }),
      });
      assert.equal(res.status, 429);
      const body = (await res.json()) as any;
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.reason, 'USER_MAX_PER_REQUEST_EXCEEDED');
      assert.equal(body.unitsConsumed, 0);

      // Verify quota was not consumed: account & user remain at 600
      assert.equal(body.userUsage.used, 600);
      assert.equal(body.accountUsage.used, 600);
    });

    it('replays rejected request idempotently on exact retry', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          userId: userA1Id,
          units: 850,
          clientRequestId: 's6-req-2',
        }),
      });
      assert.equal(res.status, 429);
      const body = (await res.json()) as any;
      assert.equal(body.status, 'REJECTED');
      assert.equal(body.reason, 'USER_MAX_PER_REQUEST_EXCEEDED');
      assert.ok(body.message.includes('idempotent replay'));
    });

    it('returns 409 Conflict when clientRequestId is reused with different units', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          userId: userA1Id,
          units: 100, // Original was 850
          clientRequestId: 's6-req-2',
        }),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'CONFLICT');
    });

    it('returns summary reflecting accepted usage and custom plan allowance', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/summary`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.account.used, 600);
      assert.equal(body.account.allowance, 50000);
      assert.equal(body.account.remaining, 49400);

      const user = body.users.find((u: any) => u.id === userA1Id);
      assert.ok(user);
      assert.equal(user.used, 600);
      assert.equal(user.allowance, 8000);
      assert.equal(user.remaining, 7400);

      // Also verify monthly report aggregate counts
      const reportRes = await fetch(`${ctx.baseUrl}/api/v1/usage/reports/monthly?period=${body.period}`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(reportRes.status, 200);
      const report = (await reportRes.json()) as any;
      assert.equal(report.summary.acceptedRequests, 1);
      assert.equal(report.summary.rejectedRequests, 1);
      assert.equal(report.summary.totalRequests, 2);
      assert.equal(report.summary.totalUnitsConsumed, 600);
    });
  });

  describe('Cross-Tenant Isolation & Boundary Security', () => {
    it('Account B cannot view Account A user (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${userA1Id}`, {
        headers: { 'X-API-Key': accountBKey },
      });
      assert.equal(res.status, 404);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('Account B cannot update Account A user plan (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${userA1Id}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountBKey,
        },
        body: JSON.stringify({ planId: basicPlanId }),
      });
      assert.equal(res.status, 404);
    });

    it('Account B cannot record usage against Account A user (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountBKey,
        },
        body: JSON.stringify({
          userId: userA1Id,
          units: 10,
          clientRequestId: 's6-cross-tenant-1',
        }),
      });
      assert.equal(res.status, 404);
    });

    it('predefined plans cannot be modified (403 Forbidden)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans/${starterPlanId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          monthlyAllowance: 999999,
          maxUnitsPerRequest: 9999,
        }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'FORBIDDEN');
    });

    it('rejects custom plan creation when maxUnitsPerRequest > monthlyAllowance (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': accountAKey,
        },
        body: JSON.stringify({
          name: 'Invalid Ratio Plan',
          scope: 'USER',
          monthlyAllowance: 500,
          maxUnitsPerRequest: 600, // Invalid: exceeds allowance
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'BAD_REQUEST');
      assert.ok(body.message.includes('cannot exceed'));
    });
  });
});
