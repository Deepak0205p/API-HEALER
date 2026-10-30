/**
 * LIVE Track A verification (dual-mode interception · loud HTTP failures)
 * ----------------------------------------------------------------------
 * Self-contained: spins a REAL local HTTP mock upstream, runs healerFetch
 * against it with the real engine, real breaker, real SQLite, real jobs.
 *   1. GET 503 + durable LKG  → 200 stale-fallback (`x-api-healer: fallback-stale`)
 *   2. POST 503 mutation      → NEVER retried; 503 degraded envelope + ALERT job
 *   3. POST 422 type complaint→ DSL-adapted body + exactly ONE retry
 *
 * Run: bun run scripts/verify-track-a-live.ts   (no dev server required)
 */
import { createServer } from 'http';
import { healerFetch } from '../src/lib/healer/healerFetch';
import { checkBreaker, resetBreakers } from '../src/lib/healer/breaker';
import { invalidateContractCache } from '../src/lib/healer/contract-cache';
import { resetOutboundCache } from '../src/lib/healer/outbound';
import { persistLastKnownGood, setLastKnownGood, purgeContractMemory } from '../src/lib/healer/memory';
import { db } from '../src/lib/db';

const UPSTREAM = 'http://127.0.0.1:3999';
const CONTRACT_ID = 'track-a-live-contract';
const log = (s: string) => process.stdout.write(`${s}\n`);

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    log(`  ✓ ${name}`);
  } else {
    fail++;
    log(`  ✗ ${name} ${extra}`);
  }
};

async function main() {
  // ── mock upstream: counts every hit ────────────────────────────────────
  const hits = { get503: 0, post503: 0, post422: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        hits.get503++;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream overloaded' }));
      } else if (req.url === '/v1/orders') {
        hits.post503++;
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '120' });
        res.end(JSON.stringify({ error: 'try later' }));
      } else if (req.url === '/v1/pay') {
        hits.post422++;
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        if (typeof parsed.amount === 'number') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, charged: parsed.amount }));
        } else {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { param: 'amount', message: 'amount must be a number' } }),
          );
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(3999, '127.0.0.1', r));
  log('mock upstream on :3999');

  try {
    // ── setup: contract + durable LKG, all in-process ─────────────────────
    log('— setup —');
    await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
    await db.contract.create({
      data: {
        id: CONTRACT_ID,
        name: 'track-a-live',
        endpoint: 'https://mock.upstream/v1/orders',
        method: 'POST',
        schemaJson: JSON.stringify({
          fields: {
            orderId: { type: 'string', mandatory: true },
            amount: { type: 'number', mandatory: true, unit: 'INR' },
            currency: { type: 'string', mandatory: true },
          },
        }),
        mandatoryJson: JSON.stringify(['orderId', 'amount', 'currency']),
        historyJson: '{}',
      },
    });
    resetBreakers();
    resetOutboundCache();
    invalidateContractCache(CONTRACT_ID);
    resetOutboundCache();

    // seed the durable LKG tier (hot + SQLite mirror), like any healthy call does
    setLastKnownGood(CONTRACT_ID, { orderId: 'ORD-LIVE-1', amount: 499, currency: 'INR' });
    await persistLastKnownGood(CONTRACT_ID);
    const seeded = await db.contract.findUnique({
      where: { id: CONTRACT_ID },
      select: { lastGoodJson: true },
    });
    ok('durable LKG seeded in SQLite', !!seeded?.lastGoodJson);

    // ── 1 · GET 503 → stale-fallback from the durable tier ───────────────
    log('— Track A · read overload (503) → stale-fallback —');
    const stale = await healerFetch(`${UPSTREAM}/v1/orders`, { method: 'GET' }, { contractId: CONTRACT_ID });
    ok('served 200 with cached payload', stale.status === 200, `status=${stale.status}`);
    ok('x-api-healer: fallback-stale header', stale.headers.get('x-api-healer') === 'fallback-stale');
    const staleBody = (await stale.json()) as Record<string, unknown>;
    ok('payload is the last-known-good', staleBody.orderId === 'ORD-LIVE-1' && staleBody.amount === 499);
    ok('__healer verdict FALLBACK_STALE', stale.__healer?.status === 'FALLBACK_STALE');
    ok('breaker recorded the 503', checkBreaker(CONTRACT_ID).failures >= 1);
    ok('upstream hit exactly once (no retry)', hits.get503 === 1, `hits=${hits.get503}`);

    // ── 2 · POST 503 mutation → degraded, NEVER retried ──────────────────
    log('— Track A · mutation overload (503) → degraded envelope —');
    const jobsBefore = await db.jobRun.count({ where: { type: 'ALERT' } });
    const degraded = await healerFetch(
      `${UPSTREAM}/v1/orders`,
      { method: 'POST', body: JSON.stringify({ orderId: 'ORD-LIVE-2', amount: 512, currency: 'INR' }) },
      { contractId: CONTRACT_ID },
    );
    ok('HTTP 503 degraded', degraded.status === 503, `status=${degraded.status}`);
    ok('x-api-healer: degraded header', degraded.headers.get('x-api-healer') === 'degraded');
    const env = (await degraded.json()) as Record<string, unknown>;
    ok(
      'clean envelope: ok=false, degraded=true, retryable',
      env.ok === false && env.degraded === true && env.retryable === true,
      JSON.stringify(env).slice(0, 120),
    );
    ok('envelope carries upstreamStatus 503', env.upstreamStatus === 503);
    ok('upstream hit exactly once — double-charge impossible', hits.post503 === 1, `hits=${hits.post503}`);
    await new Promise((r) => setTimeout(r, 800));
    const jobsAfter = await db.jobRun.count({ where: { type: 'ALERT' } });
    ok('developer ALERT job queued + processed', jobsAfter > jobsBefore, `${jobsBefore} → ${jobsAfter}`);

    // ── 3 · POST 422 → outbound DSL adaptation + one retry ───────────────
    log('— Track A · outbound validation (422) → DSL adaptation —');
    const adapted = await healerFetch(
      `${UPSTREAM}/v1/pay`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ORD-LIVE-3', amount: '777', currency: 'INR' }),
      },
      { contractId: CONTRACT_ID },
    );
    ok('retry succeeded → 200', adapted.status === 200, `status=${adapted.status}`);
    ok(
      'x-api-healer-status: OUTBOUND_ADAPTED',
      adapted.headers.get('x-api-healer-status') === 'OUTBOUND_ADAPTED',
    );
    const payBody = (await adapted.json()) as Record<string, unknown>;
    ok('charged the coerced amount 777 (magnitude untouched)', payBody.charged === 777);
    ok('422 lane hit then adapted retry (2 upstream calls)', hits.post422 === 2, `hits=${hits.post422}`);

    // ── cleanup ───────────────────────────────────────────────────────────
    await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
    invalidateContractCache(CONTRACT_ID);
    purgeContractMemory(CONTRACT_ID);
    resetBreakers();
    resetOutboundCache();
  } finally {
    server.close();
  }

  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// hard watchdog: never hang the harness
setTimeout(() => {
  log('[watchdog] 60s wall exceeded — aborting');
  process.exit(2);
}, 60_000).unref?.();

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
