import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, closeDb, TestContext } from './helpers';
import { db } from '../src/db';
import { plans } from '../src/db/schema/plans';

describe('Stage 1 — Foundation & Health Tests', () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await startTestServer();
  });

  after(async () => {
    await ctx.close();
    await closeDb();
  });

  it('GET /health returns 200 with database: connected', async () => {
    const res = await fetch(`${ctx.baseUrl}/health`);
    assert.equal(res.status, 200);

    const body = await res.json() as any;
    assert.equal(body.status, 'ok');
    assert.equal(body.database, 'connected');
    assert.ok(body.timestamp);
  });

  it('GET /unknown-route returns 404 JSON error', async () => {
    const res = await fetch(`${ctx.baseUrl}/non-existent-endpoint`);
    assert.equal(res.status, 404);

    const body = await res.json() as any;
    assert.equal(body.error, 'NOT_FOUND');
  });

  it('predefined plans are properly seeded in database', async () => {
    const allPlans = await db.select().from(plans);
    const planNames = allPlans.map((p) => p.name);

    assert.ok(planNames.includes('Starter'), 'Starter plan should exist');
    assert.ok(planNames.includes('Pro'), 'Pro plan should exist');
    assert.ok(planNames.includes('Basic'), 'Basic plan should exist');
    assert.ok(planNames.includes('Premium'), 'Premium plan should exist');

    for (const p of allPlans) {
      if (['Starter', 'Pro', 'Basic', 'Premium'].includes(p.name)) {
        assert.equal(p.isCustom, false, `${p.name} must not be custom`);
        assert.equal(p.accountId, null, `${p.name} must have null accountId`);
      }
    }
  });
});
