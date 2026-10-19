import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, closeDb, TestContext } from './helpers';
import { db } from '../src/db';
import { plans } from '../src/db/schema/plans';
import { accounts } from '../src/db/schema/accounts';
import { env } from '../src/config/env';
import { eq, and, isNull } from 'drizzle-orm';

describe('Stage 2 — Accounts, Users, Plans, and API-Key Authentication', () => {
  let ctx: TestContext;
  let starterPlanId: string;
  let proPlanId: string;
  let basicPlanId: string;
  let premiumPlanId: string;

  // Test data for accounts
  let account1Key: string;
  let account1Id: string;
  let account2Key: string;
  let account2Id: string;

  // Custom plan IDs created during tests
  let customAccountPlanId: string;
  let customUserPlanId: string;

  before(async () => {
    ctx = await startTestServer();

    // Fetch predefined plans for testing
    const seededPlans = await db
      .select()
      .from(plans)
      .where(and(eq(plans.isCustom, false), isNull(plans.accountId)));

    starterPlanId = seededPlans.find((p) => p.name === 'Starter' && p.scope === 'ACCOUNT')!.id;
    proPlanId = seededPlans.find((p) => p.name === 'Pro' && p.scope === 'ACCOUNT')!.id;
    basicPlanId = seededPlans.find((p) => p.name === 'Basic' && p.scope === 'USER')!.id;
    premiumPlanId = seededPlans.find((p) => p.name === 'Premium' && p.scope === 'USER')!.id;
  });

  after(async () => {
    await ctx.close();
    await closeDb();
  });

  describe('Admin Authentication & Account Creation', () => {
    it('rejects account creation with missing admin key (401)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Acme Corp', planId: starterPlanId }),
      });
      assert.equal(res.status, 401);
      const body = await res.json() as any;
      assert.equal(body.error, 'UNAUTHORIZED');
    });

    it('rejects account creation with invalid admin key (401)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': 'wrong_secret_key',
        },
        body: JSON.stringify({ name: 'Acme Corp', planId: starterPlanId }),
      });
      assert.equal(res.status, 401);
      const body = await res.json() as any;
      assert.equal(body.error, 'UNAUTHORIZED');
    });

    it('rejects account creation with invalid plan ID (400 / 404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': env.ADMIN_API_KEY,
        },
        body: JSON.stringify({ name: 'Acme Corp', planId: '00000000-0000-0000-0000-000000000000' }),
      });
      assert.equal(res.status, 404);
    });

    it('rejects assigning a USER-scoped plan to an account (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': env.ADMIN_API_KEY,
        },
        body: JSON.stringify({ name: 'Acme Corp', planId: basicPlanId }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.error, 'BAD_REQUEST');
      assert.match(body.message, /cannot be assigned to an account/i);
    });

    it('creates Account 1 successfully and returns plaintext API key (201)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': env.ADMIN_API_KEY,
        },
        body: JSON.stringify({ name: 'Alpha Corp', planId: starterPlanId }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as any;
      assert.ok(body.id);
      assert.equal(body.name, 'Alpha Corp');
      assert.equal(body.planId, starterPlanId);
      assert.ok(body.apiKey.startsWith('umq_live_'));

      account1Key = body.apiKey;
      account1Id = body.id;

      // Verify that database does NOT store plaintext key
      const dbAccount = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, account1Id))
        .limit(1);

      assert.equal(dbAccount.length, 1);
      assert.notEqual(dbAccount[0].apiKeyHash, account1Key);
      assert.equal(dbAccount[0].apiKeyHash.length, 64); // SHA-256 hex length
    });

    it('creates Account 2 successfully for cross-account isolation tests (201)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.ADMIN_API_KEY}`,
        },
        body: JSON.stringify({ name: 'Beta Ltd', planId: starterPlanId }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as any;
      account2Key = body.apiKey;
      account2Id = body.id;
    });
  });

  describe('Account Authentication & Profile Endpoints', () => {
    it('rejects access without X-API-Key header (401)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me`);
      assert.equal(res.status, 401);
      const body = await res.json() as any;
      assert.equal(body.error, 'UNAUTHORIZED');
    });

    it('rejects access with invalid X-API-Key (401)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me`, {
        headers: { 'X-API-Key': 'umq_live_invalidkey123456789' },
      });
      assert.equal(res.status, 401);
    });

    it('returns Account 1 profile with valid X-API-Key (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me`, {
        headers: { 'X-API-Key': account1Key },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.id, account1Id);
      assert.equal(body.name, 'Alpha Corp');
      assert.equal(body.plan.name, 'Starter');
      assert.equal(body.plan.scope, 'ACCOUNT');
    });

    it('updates Account 1 plan to Pro plan (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: proPlanId }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.planId, proPlanId);
      assert.equal(body.plan.name, 'Pro');
    });

    it('rejects updating Account plan to a USER plan (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: basicPlanId }),
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Predefined and Custom Plans Management', () => {
    it('lists accessible plans (predefined plans)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        headers: { 'X-API-Key': account1Key },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.ok(Array.isArray(body.plans));
      const names = body.plans.map((p: any) => p.name);
      assert.ok(names.includes('Starter'));
      assert.ok(names.includes('Pro'));
      assert.ok(names.includes('Basic'));
      assert.ok(names.includes('Premium'));
    });

    it('protects predefined plans from modification (403)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans/${starterPlanId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          monthlyAllowance: 99999,
          maxUnitsPerRequest: 100,
        }),
      });
      assert.equal(res.status, 403);
      const body = await res.json() as any;
      assert.equal(body.error, 'FORBIDDEN');
      assert.match(body.message, /read-only/i);
    });

    it('creates a custom ACCOUNT plan for Account 1 (201)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Alpha Custom Growth',
          scope: 'ACCOUNT',
          monthlyAllowance: 50000,
          maxUnitsPerRequest: 2500,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as any;
      assert.equal(body.name, 'Alpha Custom Growth');
      assert.equal(body.isCustom, true);
      assert.equal(body.accountId, account1Id);
      customAccountPlanId = body.id;
    });

    it('creates a custom USER plan for Account 1 (201)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Alpha Power User',
          scope: 'USER',
          monthlyAllowance: 5000,
          maxUnitsPerRequest: 500,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as any;
      assert.equal(body.name, 'Alpha Power User');
      assert.equal(body.scope, 'USER');
      assert.equal(body.isCustom, true);
      customUserPlanId = body.id;
    });

    it('updates custom plan rules (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans/${customUserPlanId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Alpha Super User',
          monthlyAllowance: 6000,
          maxUnitsPerRequest: 600,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.name, 'Alpha Super User');
      assert.equal(body.monthlyAllowance, 6000);
      assert.equal(body.maxUnitsPerRequest, 600);
    });

    it('rejects custom plan update if maxUnitsPerRequest exceeds monthlyAllowance (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans/${customUserPlanId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          monthlyAllowance: 100,
          maxUnitsPerRequest: 200,
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.error, 'BAD_REQUEST');
    });

    it('rejects updating custom plan name to a conflicting name (409)', async () => {
      // Create another plan to conflict with
      const secondPlanRes = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Alpha Second Plan',
          scope: 'USER',
          monthlyAllowance: 2000,
          maxUnitsPerRequest: 200,
        }),
      });
      assert.equal(secondPlanRes.status, 201);
      const secondPlan = await secondPlanRes.json() as any;

      // Try renaming second plan to 'Alpha Super User'
      const renameRes = await fetch(`${ctx.baseUrl}/api/v1/plans/${secondPlan.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'Alpha Super User',
          monthlyAllowance: 2000,
          maxUnitsPerRequest: 200,
        }),
      });
      assert.equal(renameRes.status, 409);
      const body = await renameRes.json() as any;
      assert.equal(body.error, 'CONFLICT');
    });

    it('allows Account 1 to assign its own custom ACCOUNT plan to Account 1 (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: customAccountPlanId }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.planId, customAccountPlanId);
      assert.equal(body.plan.name, 'Alpha Custom Growth');
      assert.equal(body.plan.isCustom, true);
    });

    it('prevents Account 2 from assigning Account 1 custom ACCOUNT plan (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/accounts/me/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({ planId: customAccountPlanId }),
      });
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('prevents Account 2 from seeing Account 1 custom plans (isolation)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans`, {
        headers: { 'X-API-Key': account2Key },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      const names = body.plans.map((p: any) => p.name);
      assert.ok(!names.includes('Alpha Custom Growth'), "Account 2 must not see Account 1's custom plans");
      assert.ok(!names.includes('Alpha Super User'), "Account 2 must not see Account 1's custom plans");
    });

    it('prevents Account 2 from modifying Account 1 custom plan (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/plans/${customUserPlanId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          monthlyAllowance: 1000,
          maxUnitsPerRequest: 100,
        }),
      });
      assert.equal(res.status, 404);
    });
  });

  describe('User Management and Account Isolation', () => {
    let account1UserId: string;

    it('creates a user under Account 1 with Basic plan (201)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'alice',
          planId: basicPlanId,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as any;
      assert.equal(body.name, 'alice');
      assert.equal(body.accountId, account1Id);
      assert.equal(body.plan.name, 'Basic');
      account1UserId = body.id;
    });

    it('rejects duplicate user name under the same account (409)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({
          name: 'alice',
          planId: basicPlanId,
        }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as any;
      assert.equal(body.error, 'CONFLICT');
    });

    it('allows Account 2 to create user with the same name "alice" (scoped uniqueness)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({
          name: 'alice',
          planId: basicPlanId,
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json() as any;
      assert.equal(body.name, 'alice');
      assert.equal(body.accountId, account2Id);
    });

    it('lists only users belonging to Account 1', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        headers: { 'X-API-Key': account1Key },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.users.length, 1);
      assert.equal(body.users[0].id, account1UserId);
      assert.equal(body.users[0].accountId, account1Id);
    });

    it('prevents Account 2 from accessing Account 1 user by ID (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${account1UserId}`, {
        headers: { 'X-API-Key': account2Key },
      });
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('updates Account 1 user to Premium plan (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${account1UserId}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: premiumPlanId }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.planId, premiumPlanId);
      assert.equal(body.plan.name, 'Premium');
    });

    it('allows Account 1 to assign its own custom USER plan to its user (200)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${account1UserId}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: customUserPlanId }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.planId, customUserPlanId);
      assert.equal(body.plan.name, 'Alpha Super User');
      assert.equal(body.plan.isCustom, true);
    });

    it('prevents Account 2 from assigning Account 1 custom USER plan to Account 2 user (404)', async () => {
      // Find Account 2's user
      const acc2UsersRes = await fetch(`${ctx.baseUrl}/api/v1/users`, {
        headers: { 'X-API-Key': account2Key },
      });
      const acc2Users = await acc2UsersRes.json() as any;
      const acc2UserId = acc2Users.users[0].id;

      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${acc2UserId}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({ planId: customUserPlanId }),
      });
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('prevents Account 2 from changing Account 1 user plan (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${account1UserId}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account2Key,
        },
        body: JSON.stringify({ planId: premiumPlanId }),
      });
      assert.equal(res.status, 404);
    });

    it('rejects assigning an ACCOUNT plan to a user (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/users/${account1UserId}/plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': account1Key,
        },
        body: JSON.stringify({ planId: starterPlanId }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as any;
      assert.equal(body.error, 'BAD_REQUEST');
      assert.match(body.message, /cannot be assigned to a user/i);
    });
  });
});
