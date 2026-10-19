import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, closeDb, TestContext } from './helpers';
import { db } from '../src/db';
import { plans } from '../src/db/schema/plans';
import { getUtcPeriod } from '../src/utils/period';
import { env } from '../src/config/env';

describe('Stage 4 — Usage Summaries, Monthly Reports & Paginated History', () => {
  let ctx: TestContext;
  let currentPeriod: string;

  let starterPlanId: string;
  let basicPlanId: string;

  // Account A (with 2 users)
  let accountAKey: string;
  let accountAId: string;
  let userA1Id: string;
  let userA2Id: string;

  // Account B (for isolation testing)
  let accountBKey: string;
  let accountBId: string;
  let userB1Id: string;

  before(async () => {
    ctx = await startTestServer();
    currentPeriod = getUtcPeriod();

    const allPlans = await db.select().from(plans);
    starterPlanId = allPlans.find((p) => p.name === 'Starter' && p.scope === 'ACCOUNT')!.id;
    basicPlanId = allPlans.find((p) => p.name === 'Basic' && p.scope === 'USER')!.id;

    // Create Account A
    const accARes = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': env.ADMIN_API_KEY,
      },
      body: JSON.stringify({ name: 'Reporting Corp A', planId: starterPlanId }),
    });
    const accABody = await accARes.json() as any;
    accountAKey = accABody.apiKey;
    accountAId = accABody.id;

    // Create User A1 and User A2
    const uA1Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': accountAKey,
      },
      body: JSON.stringify({ name: 'reporter_user_a1', planId: basicPlanId }),
    });
    const uA1Body = await uA1Res.json() as any;
    userA1Id = uA1Body.id;

    const uA2Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': accountAKey,
      },
      body: JSON.stringify({ name: 'reporter_user_a2', planId: basicPlanId }),
    });
    const uA2Body = await uA2Res.json() as any;
    userA2Id = uA2Body.id;

    // Create Account B and User B1
    const accBRes = await fetch(`${ctx.baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': env.ADMIN_API_KEY,
      },
      body: JSON.stringify({ name: 'Reporting Corp B', planId: starterPlanId }),
    });
    const accBBody = await accBRes.json() as any;
    accountBKey = accBBody.apiKey;
    accountBId = accBBody.id;

    const uB1Res = await fetch(`${ctx.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': accountBKey,
      },
      body: JSON.stringify({ name: 'reporter_user_b1', planId: basicPlanId }),
    });
    const uB1Body = await uB1Res.json() as any;
    userB1Id = uB1Body.id;

    // Seed usage activity for Account A:
    // User A1:
    // 1. Accepted 40 units
    await fetch(`${ctx.baseUrl}/api/v1/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': accountAKey },
      body: JSON.stringify({ userId: userA1Id, units: 40, clientRequestId: 's4-act-a1-1' }),
    });
    // 2. Accepted 30 units
    await fetch(`${ctx.baseUrl}/api/v1/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': accountAKey },
      body: JSON.stringify({ userId: userA1Id, units: 30, clientRequestId: 's4-act-a1-2' }),
    });
    // 3. Rejected: exceeds user max per request (150 > 100)
    await fetch(`${ctx.baseUrl}/api/v1/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': accountAKey },
      body: JSON.stringify({ userId: userA1Id, units: 150, clientRequestId: 's4-act-a1-3' }),
    });

    // User A2:
    // 4. Accepted 20 units
    await fetch(`${ctx.baseUrl}/api/v1/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': accountAKey },
      body: JSON.stringify({ userId: userA2Id, units: 20, clientRequestId: 's4-act-a2-1' }),
    });

    // Seed usage activity for Account B:
    // 5. User B1: Accepted 100 units
    await fetch(`${ctx.baseUrl}/api/v1/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': accountBKey },
      body: JSON.stringify({ userId: userB1Id, units: 100, clientRequestId: 's4-act-b1-1' }),
    });
  });

  after(async () => {
    await ctx.close();
    await closeDb();
  });

  describe('GET /api/v1/usage/summary', () => {
    it('returns current UTC-month usage summary with account and user breakdowns', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/summary`, {
        headers: { 'X-API-Key': accountAKey },
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.period, currentPeriod);

      // Account summary verification
      // Total accepted: User A1 (40 + 30) + User A2 (20) = 90 units
      assert.equal(body.account.id, accountAId);
      assert.equal(body.account.name, 'Reporting Corp A');
      assert.equal(body.account.allowance, 10000);
      assert.equal(body.account.used, 90);
      assert.equal(body.account.remaining, 9910);

      // Users breakdown verification
      assert.equal(body.users.length, 2);

      const userA1Summary = body.users.find((u: any) => u.id === userA1Id);
      assert.ok(userA1Summary);
      assert.equal(userA1Summary.name, 'reporter_user_a1');
      assert.equal(userA1Summary.allowance, 1000);
      assert.equal(userA1Summary.used, 70); // 40 + 30
      assert.equal(userA1Summary.remaining, 930);

      const userA2Summary = body.users.find((u: any) => u.id === userA2Id);
      assert.ok(userA2Summary);
      assert.equal(userA2Summary.name, 'reporter_user_a2');
      assert.equal(userA2Summary.allowance, 1000);
      assert.equal(userA2Summary.used, 20);
      assert.equal(userA2Summary.remaining, 980);
    });

    it('enforces tenant isolation: Account A summary does not leak Account B data', async () => {
      const resA = await fetch(`${ctx.baseUrl}/api/v1/usage/summary`, {
        headers: { 'X-API-Key': accountAKey },
      });
      const bodyA = await resA.json() as any;
      const userIdsA = bodyA.users.map((u: any) => u.id);
      assert.ok(!userIdsA.includes(userB1Id), 'Account A summary must not contain Account B users');
      assert.equal(bodyA.account.used, 90, 'Account A usage must not count Account B consumption');

      const resB = await fetch(`${ctx.baseUrl}/api/v1/usage/summary`, {
        headers: { 'X-API-Key': accountBKey },
      });
      const bodyB = await resB.json() as any;
      assert.equal(bodyB.account.used, 100);
      assert.equal(bodyB.users.length, 1);
      assert.equal(bodyB.users[0].id, userB1Id);
    });
  });

  describe('GET /api/v1/usage/reports/monthly', () => {
    it('rejects missing or malformed period query parameter (400)', async () => {
      // Missing period
      const res1 = await fetch(`${ctx.baseUrl}/api/v1/usage/reports/monthly`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(res1.status, 400);

      // Malformed periods
      for (const badPeriod of [
        '2026',
        '2026-13',
        '2026-00',
        '2026-0',
        '2026-1',
        '0000-01',
        '9999-01',
        ' 2026-10 ',
        'invalid',
        '2026/10',
      ]) {
        const res = await fetch(`${ctx.baseUrl}/api/v1/usage/reports/monthly?period=${badPeriod}`, {
          headers: { 'X-API-Key': accountAKey },
        });
        assert.equal(res.status, 400, `Expected 400 for bad period: ${badPeriod}`);
      }
    });

    it('returns monthly report with aggregate counts and per-user breakdown', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/reports/monthly?period=${currentPeriod}`, {
        headers: { 'X-API-Key': accountAKey },
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.period, currentPeriod);
      assert.equal(body.accountId, accountAId);

      // Total requests for Account A = 4 (3 accepted + 1 rejected)
      // Total requested = 40 + 30 + 150 + 20 = 240
      // Total consumed = 40 + 30 + 0 + 20 = 90
      assert.equal(body.summary.totalRequests, 4);
      assert.equal(body.summary.acceptedRequests, 3);
      assert.equal(body.summary.rejectedRequests, 1);
      assert.equal(body.summary.totalUnitsRequested, 240);
      assert.equal(body.summary.totalUnitsConsumed, 90);

      // User breakdown verification
      assert.equal(body.userBreakdown.length, 2);

      const uA1Breakdown = body.userBreakdown.find((u: any) => u.userId === userA1Id);
      assert.ok(uA1Breakdown);
      assert.equal(uA1Breakdown.totalRequests, 3);
      assert.equal(uA1Breakdown.acceptedRequests, 2);
      assert.equal(uA1Breakdown.rejectedRequests, 1);
      assert.equal(uA1Breakdown.totalUnitsRequested, 220); // 40 + 30 + 150
      assert.equal(uA1Breakdown.totalUnitsConsumed, 70); // 40 + 30

      const uA2Breakdown = body.userBreakdown.find((u: any) => u.userId === userA2Id);
      assert.ok(uA2Breakdown);
      assert.equal(uA2Breakdown.totalRequests, 1);
      assert.equal(uA2Breakdown.acceptedRequests, 1);
      assert.equal(uA2Breakdown.rejectedRequests, 0);
      assert.equal(uA2Breakdown.totalUnitsRequested, 20);
      assert.equal(uA2Breakdown.totalUnitsConsumed, 20);
    });

    it('returns zero values cleanly for periods with no activity', async () => {
      const emptyPeriod = '2024-01';
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/reports/monthly?period=${emptyPeriod}`, {
        headers: { 'X-API-Key': accountAKey },
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.period, emptyPeriod);
      assert.equal(body.summary.totalRequests, 0);
      assert.equal(body.summary.acceptedRequests, 0);
      assert.equal(body.summary.rejectedRequests, 0);
      assert.equal(body.summary.totalUnitsRequested, 0);
      assert.equal(body.summary.totalUnitsConsumed, 0);
      assert.deepEqual(body.userBreakdown, []);
    });
  });

  describe('GET /api/v1/usage/history', () => {
    it('returns paginated ledger with metadata and stable ordering', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/history?page=1&limit=2`, {
        headers: { 'X-API-Key': accountAKey },
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;

      // Account A has 4 total records
      assert.equal(body.pagination.page, 1);
      assert.equal(body.pagination.limit, 2);
      assert.equal(body.pagination.totalRecords, 4);
      assert.equal(body.pagination.totalPages, 2);
      assert.equal(body.pagination.hasNextPage, true);
      assert.equal(body.pagination.hasPrevPage, false);

      assert.equal(body.records.length, 2);
      // Most recent should be s4-act-a2-1
      assert.equal(body.records[0].clientRequestId, 's4-act-a2-1');
      assert.equal(body.records[1].clientRequestId, 's4-act-a1-3');
    });

    it('fetches page 2 correctly', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/history?page=2&limit=2`, {
        headers: { 'X-API-Key': accountAKey },
      });

      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.pagination.page, 2);
      assert.equal(body.pagination.hasNextPage, false);
      assert.equal(body.pagination.hasPrevPage, true);

      assert.equal(body.records.length, 2);
      assert.equal(body.records[0].clientRequestId, 's4-act-a1-2');
      assert.equal(body.records[1].clientRequestId, 's4-act-a1-1');
    });

    it('rejects invalid pagination parameters (400)', async () => {
      const badRequests = [
        '?page=0',
        '?page=-1',
        '?page=abc',
        '?limit=0',
        '?limit=101',
        '?limit=xyz',
      ];

      for (const query of badRequests) {
        const res = await fetch(`${ctx.baseUrl}/api/v1/usage/history${query}`, {
          headers: { 'X-API-Key': accountAKey },
        });
        assert.equal(res.status, 400, `Expected 400 for query: ${query}`);
      }
    });

    it('filters ledger by status (ACCEPTED / REJECTED)', async () => {
      // Filter status=REJECTED (should return exactly 1 record)
      const resRej = await fetch(`${ctx.baseUrl}/api/v1/usage/history?status=REJECTED`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(resRej.status, 200);
      const bodyRej = await resRej.json() as any;
      assert.equal(bodyRej.pagination.totalRecords, 1);
      assert.equal(bodyRej.records[0].clientRequestId, 's4-act-a1-3');
      assert.equal(bodyRej.records[0].status, 'REJECTED');
      assert.equal(bodyRej.records[0].rejectionReason, 'USER_MAX_PER_REQUEST_EXCEEDED');

      // Filter status=ACCEPTED (should return exactly 3 records)
      const resAcc = await fetch(`${ctx.baseUrl}/api/v1/usage/history?status=ACCEPTED`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(resAcc.status, 200);
      const bodyAcc = await resAcc.json() as any;
      assert.equal(bodyAcc.pagination.totalRecords, 3);
      for (const rec of bodyAcc.records) {
        assert.equal(rec.status, 'ACCEPTED');
      }

      // Invalid status returns 400
      const resBad = await fetch(`${ctx.baseUrl}/api/v1/usage/history?status=UNKNOWN`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(resBad.status, 400);
    });

    it('filters ledger by valid userId under account', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/history?userId=${userA2Id}`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      assert.equal(body.pagination.totalRecords, 1);
      assert.equal(body.records[0].clientRequestId, 's4-act-a2-1');
      assert.equal(body.records[0].userId, userA2Id);
    });

    it('rejects cross-account userId filter with 404 (isolation)', async () => {
      // Account A attempting to filter with User B1's ID
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/history?userId=${userB1Id}`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('enforces total account isolation: Account A history never contains Account B records', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/usage/history?limit=100`, {
        headers: { 'X-API-Key': accountAKey },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as any;
      const requestIds = body.records.map((r: any) => r.clientRequestId);
      assert.ok(!requestIds.includes('s4-act-b1-1'), 'Account A history must never include Account B records');
    });
  });
});
