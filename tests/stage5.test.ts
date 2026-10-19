import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, closeDb, TestContext } from './helpers';
import { db } from '../src/db';
import { plans } from '../src/db/schema/plans';
import { env } from '../src/config/env';
import { eq, and, isNull } from 'drizzle-orm';

describe('Stage 5 — Demo Client & Docker Integration Verification', () => {
  let ctx: TestContext;
  let starterPlanId: string;
  let basicPlanId: string;

  before(async () => {
    ctx = await startTestServer();

    // Fetch predefined plans for testing
    const seededPlans = await db
      .select()
      .from(plans)
      .where(and(eq(plans.isCustom, false), isNull(plans.accountId)));

    starterPlanId = seededPlans.find((p) => p.name === 'Starter' && p.scope === 'ACCOUNT')!.id;
    basicPlanId = seededPlans.find((p) => p.name === 'Basic' && p.scope === 'USER')!.id;
  });

  after(async () => {
    await ctx.close();
    await closeDb();
  });

  describe('Static Demo Client Serving', () => {
    it('serves the demo HTML frontend at GET / with status 200', async () => {
      const res = await fetch(`${ctx.baseUrl}/`);
      assert.equal(res.status, 200);
      const contentType = res.headers.get('content-type') || '';
      assert.ok(contentType.includes('text/html'), `Expected text/html, got ${contentType}`);
      const body = await res.text();
      assert.ok(body.includes('Usage Metering &amp; Quota'), 'Expected page title in HTML body');
      assert.ok(body.includes('Forget key'), 'Expected forget key button in HTML body');
    });

    it('serves the demo HTML frontend at GET /index.html with status 200', async () => {
      const res = await fetch(`${ctx.baseUrl}/index.html`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.includes('Usage Metering &amp; Quota'));
    });
  });

  describe('GET /api/v1/demo/plans', () => {
    it('returns predefined plans without requiring authentication', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/plans`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.ok(Array.isArray(data.plans), 'Expected plans array');
      assert.ok(data.plans.length >= 4, 'Expected at least 4 predefined plans');

      const planNames = data.plans.map((p: any) => p.name);
      assert.ok(planNames.includes('Starter'));
      assert.ok(planNames.includes('Pro'));
      assert.ok(planNames.includes('Basic'));
      assert.ok(planNames.includes('Premium'));

      // Ensure no sensitive fields or internal keys leaked
      for (const p of data.plans) {
        assert.ok(p.id && p.name && p.scope && p.monthlyAllowance && p.maxUnitsPerRequest);
        assert.equal(p.apiKeyHash, undefined);
      }
    });
  });

  describe('POST /api/v1/demo/create-account', () => {
    it('creates a demo account with predefined Starter plan and returns usable API key (201)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Stage 5 Demo Org',
          planId: starterPlanId,
        }),
      });

      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.ok(body.id);
      assert.equal(body.name, 'Stage 5 Demo Org');
      assert.ok(typeof body.apiKey === 'string' && body.apiKey.startsWith('umq_live_'));
      assert.ok(body.createdAt);

      // Verify the generated API key immediately works with account endpoints
      const meRes = await fetch(`${ctx.baseUrl}/api/v1/accounts/me`, {
        headers: { 'X-API-Key': body.apiKey },
      });
      assert.equal(meRes.status, 200);
      const meBody = (await meRes.json()) as any;
      assert.equal(meBody.id, body.id);
      assert.equal(meBody.name, 'Stage 5 Demo Org');
      assert.equal(meBody.plan.name, 'Starter');
    });

    it('rejects account creation with missing name (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: starterPlanId }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'BAD_REQUEST');
      assert.ok(body.message.includes('Account name'));
    });

    it('rejects account creation with empty name string (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ', planId: starterPlanId }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'BAD_REQUEST');
    });

    it('rejects account creation with invalid planId format (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Invalid Plan Demo', planId: 'not-a-uuid' }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'BAD_REQUEST');
    });

    it('rejects account creation with non-existent planId (404)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Missing Plan Demo',
          planId: 'a0000000-0000-0000-0000-000000000000',
        }),
      });
      assert.equal(res.status, 404);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'NOT_FOUND');
    });

    it('rejects account creation with USER-scoped plan (400)', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'User Plan on Account Demo',
          planId: basicPlanId,
        }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error, 'BAD_REQUEST');
      assert.ok(body.message.includes('USER plan and cannot be assigned to an account'));
    });
  });

  describe('Security & Secrets Hygiene', () => {
    it('verifies ADMIN_API_KEY is never exposed in demo endpoint responses', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/v1/demo/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Secrets Check Demo',
          planId: starterPlanId,
        }),
      });
      const text = await res.text();
      assert.ok(!text.includes(env.ADMIN_API_KEY), 'ADMIN_API_KEY leaked in response body!');
      assert.ok(!text.includes(env.DB_PASSWORD), 'DB_PASSWORD leaked in response body!');
    });

    it('verifies frontend index.html does not contain secrets or persistent storage mechanisms', () => {
      const htmlPath = path.resolve(process.cwd(), 'src/public/index.html');
      assert.ok(fs.existsSync(htmlPath), 'index.html must exist');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // Must never contain hardcoded backend secrets
      assert.ok(!html.includes(env.ADMIN_API_KEY), 'ADMIN_API_KEY must never appear in index.html');
      assert.ok(!html.includes(env.DB_PASSWORD), 'DB_PASSWORD must never appear in index.html');
      assert.ok(!html.includes('admin_dev_secret_key_123'), 'Default admin key must not appear in HTML');

      // Must not persist API keys in browser storage
      assert.ok(!html.includes('localStorage.setItem'), 'localStorage must not be used to store API keys');
      assert.ok(!html.includes('sessionStorage.setItem'), 'sessionStorage must not be used to store API keys');
      assert.ok(!html.includes('document.cookie'), 'cookies must not be used to store API keys');

      // Must contain in-memory session and forget option
      assert.ok(html.includes('SESSION_API_KEY'), 'Must use in-memory SESSION_API_KEY');
      assert.ok(html.includes('forgetSession'), 'Must provide forgetSession handler');
    });
  });
});
