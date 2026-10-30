/**
 * API-HEALER · Track A tests (dual-mode interception — loud HTTP failures)
 * --------------------------------------------------------------------------
 *  • 429/502/503/504 on reads  → breaker trip + stale-fallback + header
 *  • 429/502/503/504 on writes → NEVER retried; degraded envelope + ALERT job
 *  • 400/422                   → outbound DSL adaptation + exactly ONE retry
 *  • Retry-After honored as breaker cooldown lower bound
 *  • durable LKG tier (hot miss → SQLite mirror)
 *  • outbound hint parser: Stripe/Rails/JSON:API/plain formats, no guessing
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@/lib/db';
import { healerFetch } from '@/lib/healer/healerFetch';
import { parseErrorBody, deriveOutboundPlan, applyOutboundPlan, resetOutboundCache } from '@/lib/healer/outbound';
import {
  getLastKnownGood,
  setLastKnownGood,
  persistLastKnownGood,
  purgeContractMemory,
  resetMemoryTier,
} from '@/lib/healer/memory';
import { resetBreakers, checkBreaker, recordFailure } from '@/lib/healer/breaker';
import { invalidateContractCache } from '@/lib/healer/contract-cache';
import { resetRuntimeCounters, runtimeCounters } from '@/lib/healer/counters';

const CONTRACT_ID = 'test-track-a-contract';
const URL_ = 'https://upstream.test/v1/orders';

const originalFetch = globalThis.fetch;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let responses: Response[] = [];

function queueResponse(res: Response) {
  responses.push(res);
}
const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

beforeAll(() => {
  // hermetic bus: no socket.io client may keep the test process alive
  (globalThis as unknown as Record<string, unknown>).__apiHealerBus = {
    socket: { connected: false, emit: () => undefined },
    connecting: true,
    buffer: [],
  };
  delete process.env.GITHUB_TOKEN; // deterministic DRY_RUN artifacts

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('test harness: no queued response');
    return next;
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
  await db.jobRun.deleteMany({}).catch(() => undefined);
  purgeContractMemory(CONTRACT_ID);
  invalidateContractCache(CONTRACT_ID);
  resetBreakers();
  resetMemoryTier();
  resetOutboundCache();
  resetRuntimeCounters();
});

async function makeContract() {
  await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
  await db.contract.create({
    data: {
      id: CONTRACT_ID,
      name: 'track-a test',
      endpoint: URL_,
      method: 'POST',
      schemaJson: JSON.stringify({
        fields: {
          orderId: { type: 'string', mandatory: true },
          amount: { type: 'number', mandatory: true },
        },
      }),
      mandatoryJson: JSON.stringify(['orderId', 'amount']),
      historyJson: '{}',
    },
  });
  invalidateContractCache(CONTRACT_ID);
  resetBreakers();
  resetMemoryTier();
  resetOutboundCache();
  fetchCalls = [];
  responses = [];
}

// ─── overload lane ───────────────────────────────────────────────────────

describe('Track A · overload lane', () => {
  beforeAll(makeContract);
  beforeEach(() => {
    fetchCalls = [];
    responses = [];
  });

  test('read + LKG cached → 200 stale-fallback with x-api-healer: fallback-stale', async () => {
    setLastKnownGood(CONTRACT_ID, { orderId: 'ORD-1', amount: 499 });
    queueResponse(jsonResponse({ error: 'overloaded' }, 503));

    const res = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-api-healer')).toBe('fallback-stale');
    expect(res.headers.get('x-api-healer-status')).toBe('FALLBACK_STALE');
    expect(res.headers.get('x-api-healer-upstream-status')).toBe('503');
    expect(await res.json()).toEqual({ orderId: 'ORD-1', amount: 499 });
    expect(res.__healer?.status).toBe('FALLBACK_STALE');
    expect(fetchCalls.length).toBe(1); // never retried the overload
    // breaker recorded the transport failure
    expect(checkBreaker(CONTRACT_ID).failures).toBe(1);
    expect(runtimeCounters().fallbackStale).toBe(1);
  });

  test('read + NO baseline → honest pass-through of the failure', async () => {
    resetMemoryTier(); // drop LKG
    queueResponse(jsonResponse({ error: 'overloaded' }, 502));

    const res = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });

    expect(res.status).toBe(502); // the real failure surfaces
    expect(res.__healer?.status).toBe('PASSTHROUGH');
    expect(res.headers.get('x-api-healer')).toBe(null);
  });

  test('mutation → NEVER retried: degraded envelope + ALERT job queued', async () => {
    const jobsBefore = await db.jobRun.count({ where: { type: 'ALERT' } });
    queueResponse(jsonResponse({ error: 'timeout' }, 504));

    const res = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ orderId: 'ORD-2', amount: 499 }) },
      { contractId: CONTRACT_ID },
    );

    expect(fetchCalls.length).toBe(1); // NO second network call — double-charge impossible
    expect(res.status).toBe(503);
    expect(res.headers.get('x-api-healer')).toBe('degraded');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.retryable).toBe(true);
    expect(body.upstreamStatus).toBe(504);
    expect(body.action).toBe('RETRY_LATER');
    expect(res.__healer?.status).toBe('DEGRADED');
    expect(res.__healer?.jobsQueued.length).toBe(1);

    // ALERT job is durably queued for the developer
    await new Promise((r) => setTimeout(r, 100));
    const jobsAfter = await db.jobRun.count({ where: { type: 'ALERT' } });
    expect(jobsAfter).toBeGreaterThan(jobsBefore);
    expect(runtimeCounters().degraded).toBe(1);
  });

  test('429 with Retry-After raises the breaker cooldown when OPEN', async () => {
    resetBreakers();
    // 3 failures trip OPEN; each carries a Retry-After of 300s
    for (let i = 0; i < 3; i++) {
      recordFailure(CONTRACT_ID, `upstream 429 (Retry-After 300s)`, 300_000);
    }
    const snap = checkBreaker(CONTRACT_ID);
    expect(snap.state).toBe('OPEN');
    expect(snap.cooldownRemainingMs).toBeGreaterThanOrEqual(299_000); // honored, not the 60s base
    expect(snap.cooldownRemainingMs).toBeLessThanOrEqual(300_000);
    resetBreakers();
  });

  test('durable LKG tier: hot miss falls back to the SQLite mirror', async () => {
    setLastKnownGood(CONTRACT_ID, { orderId: 'ORD-3', amount: 129 });
    await persistLastKnownGood(CONTRACT_ID);
    resetMemoryTier(); // simulate process restart — hot tier empty
    expect(getLastKnownGood(CONTRACT_ID)).toBeUndefined();

    queueResponse(jsonResponse({ error: 'overloaded' }, 429));
    const res = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-api-healer')).toBe('fallback-stale');
    expect(await res.json()).toEqual({ orderId: 'ORD-3', amount: 129 }); // hydrated from SQLite
  });
});

// ─── outbound validation lane (400/422) ──────────────────────────────────

describe('Track A · outbound adaptation (400/422)', () => {
  beforeAll(makeContract);
  beforeEach(() => {
    fetchCalls = [];
    responses = [];
  });

  test('422 type complaint → DSL COERCE + exactly ONE retry', async () => {
    // upstream rejects "amount" as string; the retry succeeds
    queueResponse(
      jsonResponse({ error: { param: 'amount', message: 'amount must be a number' } }, 422),
    );
    queueResponse(jsonResponse({ ok: true, orderId: 'ORD-4', amount: 499 }, 200));

    const res = await healerFetch(
      URL_,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ORD-4', amount: '499' }),
      },
      { contractId: CONTRACT_ID },
    );

    expect(fetchCalls.length).toBe(2); // original + exactly one adapted retry
    // the retried body carries the coerced value, magnitude untouched
    const retriedBody = JSON.parse(String(fetchCalls[1].init?.body)) as Record<string, unknown>;
    expect(retriedBody.amount).toBe(499);
    expect(retriedBody.orderId).toBe('ORD-4');
    expect(fetchCalls[1].init?.headers).toBeDefined();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-api-healer-status')).toBe('OUTBOUND_ADAPTED');
    expect(await res.json()).toEqual({ ok: true, orderId: 'ORD-4', amount: 499 });
    expect(res.__healer?.status).toBe('OUTBOUND_ADAPTED');
    expect(runtimeCounters().outboundAdapted).toBeGreaterThanOrEqual(1);
  });

  test('"did you mean" rename hint → RENAME retry', async () => {
    queueResponse(
      jsonResponse(
        { message: "Unknown field 'order_id'. Did you mean 'orderId'?" },
        400,
      ),
    );
    queueResponse(jsonResponse({ ok: true }, 200));

    const res = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ order_id: 'ORD-5', amount: 10 }) },
      { contractId: CONTRACT_ID },
    );

    expect(fetchCalls.length).toBe(2);
    const retriedBody = JSON.parse(String(fetchCalls[1].init?.body)) as Record<string, unknown>;
    expect(retriedBody.orderId).toBe('ORD-5');
    expect(retriedBody.order_id).toBeUndefined();
    expect(res.headers.get('x-api-healer-status')).toBe('OUTBOUND_ADAPTED');
  });

  test('cached reverse plan: repeat 400 with same error re-applies without re-deriving', async () => {
    // First exchange derives + caches; second uses the cached plan directly.
    queueResponse(jsonResponse({ error: { param: 'amount', message: 'must be a number' } }, 422));
    queueResponse(jsonResponse({ ok: true }, 200));
    await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ orderId: 'ORD-6', amount: '77' }) },
      { contractId: CONTRACT_ID },
    );

    queueResponse(jsonResponse({ error: { param: 'amount', message: 'must be a number' } }, 422));
    queueResponse(jsonResponse({ ok: true }, 200));
    const res = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ orderId: 'ORD-7', amount: '88' }) },
      { contractId: CONTRACT_ID },
    );
    expect(fetchCalls.length).toBe(4);
    const retried = JSON.parse(String(fetchCalls[3].init?.body)) as Record<string, unknown>;
    expect(retried.amount).toBe(88);
    expect(res.headers.get('x-api-healer-status')).toBe('OUTBOUND_ADAPTED');
  });

  test('unusable 400 (no explicit hint about a sent field) → honest pass-through, single call', async () => {
    queueResponse(jsonResponse({ message: 'your account is suspended' }, 400));

    const res = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ orderId: 'ORD-8', amount: 5 }) },
      { contractId: CONTRACT_ID },
    );

    expect(fetchCalls.length).toBe(1); // never guessed, never retried
    expect(res.status).toBe(400);
    expect(res.__healer).toBeUndefined(); // untouched upstream response object semantics
  });

  test('adaptation refuses when the plan would fail DSL safety (source missing)', async () => {
    queueResponse(
      jsonResponse({ error: { param: 'nonexistent.path', message: 'must be a number' } }, 422),
    );
    const res = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ orderId: 'ORD-9', amount: 5 }) },
      { contractId: CONTRACT_ID },
    );
    expect(fetchCalls.length).toBe(1);
    expect(res.status).toBe(422);
  });
});

// ─── hint parser unit tests ───────────────────────────────────────────────

describe('outbound hint parser', () => {
  test('Stripe-ish { error: { param, message } }', () => {
    const { complaints } = parseErrorBody({ error: { param: 'amount', message: 'must be a number' } });
    expect(complaints[0]).toEqual(['amount', 'must be a number']);
  });

  test('Rails-ish { errors: { field: [msgs] } }', () => {
    const { complaints } = parseErrorBody({ errors: { amount: ['must be a number'] } });
    expect(complaints[0][0]).toBe('amount');
  });

  test('JSON:API pointer paths', () => {
    const { complaints } = parseErrorBody({
      errors: [{ source: { pointer: '/data/attributes/amount' }, detail: 'expected integer' }],
    });
    expect(complaints[0][0]).toBe('data.attributes.amount');
  });

  test('did-you-mean rename pair extraction', () => {
    const { renamePairs } = parseErrorBody({ message: "Unknown field 'order_id'. Did you mean 'orderId'?" });
    expect(renamePairs).toContainEqual(['order_id', 'orderId']);
  });

  test('deriveOutboundPlan: COERCE from explicit complaint; skips correct types', () => {
    const plan = deriveOutboundPlan(
      { error: { param: 'amount', message: 'must be a number' } },
      { orderId: 'X', amount: '499' },
    );
    expect(plan?.plan.ops).toEqual([{ op: 'COERCE', path: 'amount', cast: 'number' }]);

    const none = deriveOutboundPlan(
      { error: { param: 'amount', message: 'must be a number' } },
      { orderId: 'X', amount: 499 }, // already a number — nothing to adapt
    );
    expect(none).toBeNull();
  });

  test('deriveOutboundPlan: never invents data — missing required field yields no DEFAULT op', () => {
    const plan = deriveOutboundPlan(
      { message: 'missing required field: gstin' },
      { orderId: 'X', amount: 499 },
    );
    expect(plan).toBeNull(); // no DEFAULT ops exist outbound, ever
  });

  test('applyOutboundPlan runs full DSL safety', () => {
    const plan = deriveOutboundPlan(
      { error: { param: 'amount', message: 'must be a number' } },
      { amount: '499' },
    );
    expect(plan).not.toBeNull();
    const out = applyOutboundPlan({ amount: '499' }, plan!.plan);
    expect(out).toEqual({ amount: 499 });
  });
});
