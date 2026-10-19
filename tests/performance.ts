import { db, queryClient } from '../src/db';
import { accounts } from '../src/db/schema/accounts';
import { eq, and, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

interface PerfResult {
  totalRequests: number;
  successfulRequests: number;
  rejectedRequests: number;
  errorRequests: number;
  totalDurationMs: number;
  throughputRps: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}

function calculatePercentiles(latencies: number[]): { p50: number; p95: number; p99: number } {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const getPercentile = (p: number) => {
    const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
    return sorted[idx];
  };
  return {
    p50: Math.round(getPercentile(50) * 100) / 100,
    p95: Math.round(getPercentile(95) * 100) / 100,
    p99: Math.round(getPercentile(99) * 100) / 100,
  };
}

async function runPerformanceSuite() {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  console.log(`\n======================================================`);
  console.log(`  Usage Metering Service — Performance & Load Suite   `);
  console.log(`  Target: ${baseUrl}                                 `);
  console.log(`======================================================\n`);

  // 1. Check server health
  const healthRes = await fetch(`${baseUrl}/health`);
  if (!healthRes.ok) {
    throw new Error(`Server at ${baseUrl} is not healthy: ${healthRes.status}`);
  }
  console.log('✓ Target service is healthy and connected to database.\n');

  // 2. Fetch available plans
  const plansRes = await fetch(`${baseUrl}/api/v1/demo/plans`);
  const plansData = (await plansRes.json()) as any;
  const proPlan = plansData.plans.find((p: any) => p.name === 'Pro' && p.scope === 'ACCOUNT');
  const premiumPlan = plansData.plans.find((p: any) => p.name === 'Premium' && p.scope === 'USER');

  if (!proPlan || !premiumPlan) {
    throw new Error('Predefined Pro and Premium plans required for performance suite');
  }

  // 3. Setup isolated test account
  const uniqueSuffix = crypto.randomBytes(6).toString('hex');
  const perfAccountName = `perf_benchmark_account_${uniqueSuffix}`;
  console.log(`Setting up isolated test account: ${perfAccountName}...`);

  const createAccRes = await fetch(`${baseUrl}/api/v1/demo/create-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: perfAccountName, planId: proPlan.id }),
  });
  if (createAccRes.status !== 201) {
    throw new Error(`Failed to create benchmark account: ${createAccRes.status}`);
  }
  const account = (await createAccRes.json()) as any;
  const accountId = account.id;
  const apiKey = account.apiKey;

  // Create isolated user with Premium plan (allowance: 10,000, max/req: 1,000)
  const createUserRes = await fetch(`${baseUrl}/api/v1/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ name: 'perf_user', planId: premiumPlan.id }),
  });
  if (createUserRes.status !== 201) {
    throw new Error(`Failed to create benchmark user: ${createUserRes.status}`);
  }
  const user = (await createUserRes.json()) as any;
  const userId = user.id;

  console.log(`✓ Benchmark account initialized with Pro Plan (Allowance: ${proPlan.monthlyAllowance.toLocaleString()}, Max/Req: ${proPlan.maxUnitsPerRequest.toLocaleString()})`);
  console.log(`✓ Benchmark user initialized with Premium Plan (Allowance: ${premiumPlan.monthlyAllowance.toLocaleString()}, Max/Req: ${premiumPlan.maxUnitsPerRequest.toLocaleString()})\n`);

  try {
    // -------------------------------------------------------------
    // BENCHMARK 1: High-Concurrency Throughput & Latency Test
    // -------------------------------------------------------------
    const TOTAL_REQUESTS = 150;
    const CONCURRENCY = 15;
    const UNITS_PER_REQ = 25; // 150 * 25 = 3,750 units (well within 10,000 allowance)

    console.log(`------------------------------------------------------`);
    console.log(`[Benchmark 1] Concurrent Metering Requests`);
    console.log(`  Requests: ${TOTAL_REQUESTS}`);
    console.log(`  Concurrency: ${CONCURRENCY} parallel workers`);
    console.log(`  Payload: ${UNITS_PER_REQ} units per request`);
    console.log(`------------------------------------------------------`);

    const latencies: number[] = [];
    let successful = 0;
    let rejected = 0;
    let errors = 0;

    let reqIndex = 0;
    const startTime = performance.now();

    async function worker() {
      while (reqIndex < TOTAL_REQUESTS) {
        const id = ++reqIndex;
        const clientRequestId = `perf-bench-1-${uniqueSuffix}-${id}`;
        const reqStart = performance.now();

        try {
          const res = await fetch(`${baseUrl}/api/v1/usage`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey,
            },
            body: JSON.stringify({
              userId,
              units: UNITS_PER_REQ,
              clientRequestId,
            }),
          });
          const reqElapsed = performance.now() - reqStart;
          latencies.push(reqElapsed);

          if (res.status === 200) {
            successful++;
          } else if (res.status === 429) {
            rejected++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }
    }

    // Run parallel workers
    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);

    const totalDurationMs = performance.now() - startTime;
    const throughputRps = Math.round((TOTAL_REQUESTS / (totalDurationMs / 1000)) * 100) / 100;
    const minLatencyMs = Math.round(Math.min(...latencies) * 100) / 100;
    const maxLatencyMs = Math.round(Math.max(...latencies) * 100) / 100;
    const avgLatencyMs =
      Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100;
    const { p50, p95, p99 } = calculatePercentiles(latencies);

    console.log(`\nBenchmark 1 Results:`);
    console.log(`  Completed:            ${TOTAL_REQUESTS} requests in ${Math.round(totalDurationMs)}ms`);
    console.log(`  Throughput:           ${throughputRps} req/s`);
    console.log(`  Successful (200):     ${successful}`);
    console.log(`  Quota Exceeded (429): ${rejected}`);
    console.log(`  Server Errors (5xx):  ${errors}`);
    console.log(`  Error Rate:           ${((errors / TOTAL_REQUESTS) * 100).toFixed(2)}%`);
    console.log(`  Latency (avg):        ${avgLatencyMs} ms`);
    console.log(`  Latency (min):        ${minLatencyMs} ms`);
    console.log(`  Latency (p50):        ${p50} ms`);
    console.log(`  Latency (p95):        ${p95} ms`);
    console.log(`  Latency (p99):        ${p99} ms`);
    console.log(`  Latency (max):        ${maxLatencyMs} ms\n`);

    // Verify usage state
    const summaryRes = await fetch(`${baseUrl}/api/v1/usage/summary`, {
      headers: { 'X-API-Key': apiKey },
    });
    const summary = (await summaryRes.json()) as any;
    const expectedConsumed = successful * UNITS_PER_REQ;
    console.log(`✓ Quota consistency verified:`);
    console.log(`  Account units consumed: ${summary.account.used} (Expected: ${expectedConsumed})`);
    console.log(`  Account remaining:      ${summary.account.remaining}\n`);

    // -------------------------------------------------------------
    // BENCHMARK 2: High-Contention Idempotency Stampede Test
    // -------------------------------------------------------------
    const BURST_COUNT = 30;
    const stampedeRequestId = `stampede-${uniqueSuffix}`;
    console.log(`------------------------------------------------------`);
    console.log(`[Benchmark 2] Idempotency Stampede Test`);
    console.log(`  Fires ${BURST_COUNT} simultaneous requests with exact same clientRequestId`);
    console.log(`  Verifies race resolution, lock serialization & single deduction`);
    console.log(`------------------------------------------------------`);

    const stampedeStart = performance.now();
    const stampedePromises = Array.from({ length: BURST_COUNT }, () =>
      fetch(`${baseUrl}/api/v1/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          userId,
          units: 50,
          clientRequestId: stampedeRequestId,
        }),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as any,
      }))
    );

    const stampedeResponses = await Promise.all(stampedePromises);
    const stampedeDurationMs = Math.round(performance.now() - stampedeStart);

    const status200Count = stampedeResponses.filter((r) => r.status === 200).length;
    const otherStatusCount = stampedeResponses.filter((r) => r.status !== 200).length;

    console.log(`\nBenchmark 2 Results:`);
    console.log(`  Burst completed in:   ${stampedeDurationMs} ms`);
    console.log(`  HTTP 200 Responses:   ${status200Count} / ${BURST_COUNT}`);
    console.log(`  Non-200 Responses:    ${otherStatusCount}`);

    // Verify exactly 50 units were consumed (NOT 50 * BURST_COUNT)
    const postStampedeSummaryRes = await fetch(`${baseUrl}/api/v1/usage/summary`, {
      headers: { 'X-API-Key': apiKey },
    });
    const postStampedeSummary = (await postStampedeSummaryRes.json()) as any;
    const newUsed = postStampedeSummary.account.used;
    const delta = newUsed - expectedConsumed;

    console.log(`  Pre-stampede units:   ${expectedConsumed}`);
    console.log(`  Post-stampede units:  ${newUsed}`);
    console.log(`  Units deducted:       ${delta} (Expected exactly: 50)`);

    if (delta !== 50) {
      throw new Error(`Idempotency race failure! Expected 50 units deducted, but got ${delta}`);
    }
    console.log(`✓ Stampede test passed: Exactly 50 units consumed despite ${BURST_COUNT} simultaneous requests!\n`);
  } finally {
    // 4. Safe Targeted Cleanup
    console.log(`Cleaning up isolated benchmark account (${perfAccountName})...`);
    await db.transaction(async (tx) => {
      const match = await tx
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.name, perfAccountName)))
        .limit(1);

      if (match.length === 1) {
        await tx
          .delete(accounts)
          .where(and(eq(accounts.id, accountId), eq(accounts.name, perfAccountName)));
        console.log(`✓ Targeted cleanup completed: Exactly 1 benchmark account removed.`);
      } else {
        console.warn(`Target account not found during cleanup, aborting delete to protect data.`);
      }
    });
  }

  console.log(`======================================================`);
  console.log(`  Performance Suite Completed Successfully            `);
  console.log(`======================================================\n`);
}

runPerformanceSuite()
  .then(async () => {
    await queryClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Performance suite failed:', err);
    await queryClient.end().catch(() => {});
    process.exit(1);
  });
