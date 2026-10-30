import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { db } from '@/lib/db';
import {
  normalizeHttpErrorPayload,
  classifyHttpError,
  parseRetryAfterHeader,
  repairMalformedJson,
  inspectSuccessBodyForHiddenError,
  registerCustomErrorRule,
} from '@/lib/healer/http-classifier';
import {
  decideHandler,
  computeBackoffDelay,
  FIX_REGISTRY,
  resilientClientFetch,
  getResilienceTelemetry,
  resetResilienceRegistries,
} from '@/lib/healer/http-resilience';
import { healerFetch } from '@/lib/healer/healerFetch';
import { setLastKnownGood, resetMemoryTier, purgeContractMemory } from '@/lib/healer/memory';
import { resetBreakers } from '@/lib/healer/breaker';
import { invalidateContractCache } from '@/lib/healer/contract-cache';
import { resetOutboundCache } from '@/lib/healer/outbound';
import { resetRuntimeCounters, runtimeCounters } from '@/lib/healer/counters';

const CONTRACT_ID = 'test-http-resilience-contract';
const URL_ = 'https://upstream.test/v1/orders';

const originalFetch = globalThis.fetch;
let fetchCalls: { url: string; init?: RequestInit }[] = [];
let responses: Array<Response | (() => Promise<Response>)> = [];

function queueResponse(res: Response | (() => Promise<Response>)) {
  responses.push(res);
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).__apiHealerBus = {
    socket: { connected: false, emit: () => undefined },
    connecting: true,
    buffer: [],
  };
  delete process.env.GITHUB_TOKEN;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('test harness: no queued response');
    if (typeof next === 'function') return next();
    return next;
  }) as typeof fetch;

  await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
  await db.contract.create({
    data: {
      id: CONTRACT_ID,
      name: 'http-resilience test',
      endpoint: URL_,
      method: 'GET',
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
  resetResilienceRegistries();
});

beforeEach(() => {
  fetchCalls = [];
  responses = [];
  invalidateContractCache(CONTRACT_ID);
  resetBreakers();
  resetMemoryTier();
  resetOutboundCache();
  resetRuntimeCounters();
  resetResilienceRegistries();
});

describe('HTTP Error Resilience Engine — Normalizer & Classifier', () => {
  it('normalizes vendor-specific error shapes (Stripe, AWS, GCP, GraphQL, JSON:API, Rails, FastAPI, RFC 7807)', () => {
    // 1. Stripe error shape
    const stripe = normalizeHttpErrorPayload(
      {
        error: {
          type: 'card_error',
          code: 'rate_limit',
          message: 'Too many requests hit the API too quickly.',
          param: 'card_number',
        },
      },
      { 'retry-after': '3' },
      429,
    );
    expect(stripe.vendor).toBe('stripe');
    expect(stripe.code).toBe('rate_limit');
    expect(stripe.retryAfter).toBe(3);
    expect(stripe.retryable).toBe(true);

    // 2. AWS error shape
    const aws = normalizeHttpErrorPayload(
      {
        __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException',
        message: 'The level of configured provisioned throughput for the table was exceeded.',
      },
      {},
      400,
    );
    expect(aws.vendor).toBe('aws');
    expect(aws.code).toContain('ProvisionedThroughputExceededException');

    // 3. Google Cloud API error shape
    const gcp = normalizeHttpErrorPayload(
      {
        error: {
          code: 429,
          message: 'Quota exceeded for quota metric',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      },
      {},
      429,
    );
    expect(gcp.vendor).toBe('gcp');
    expect(gcp.code).toBe('RESOURCE_EXHAUSTED');

    // 4. GraphQL error shape
    const gql = normalizeHttpErrorPayload(
      {
        errors: [
          {
            message: 'Authentication token expired',
            path: ['viewer', 'profile'],
            extensions: { code: 'UNAUTHENTICATED' },
          },
        ],
      },
      {},
      200,
    );
    expect(gql.vendor).toBe('graphql');
    expect(gql.code).toBe('UNAUTHENTICATED');
    expect(gql.hiddenError).toBe(true);
    expect(gql.status).toBe(401);

    // 5. JSON:API error shape
    const jsonApi = normalizeHttpErrorPayload(
      {
        errors: [
          {
            status: '422',
            code: 'INVALID_ATTRIBUTE',
            title: 'Invalid Attribute',
            detail: 'Email address is invalid',
            source: { pointer: '/data/attributes/email' },
          },
        ],
      },
      {},
      422,
    );
    expect(jsonApi.vendor).toBe('jsonapi');
    expect(jsonApi.code).toBe('INVALID_ATTRIBUTE');

    // 6. Rails / ActiveRecord error shape
    const rails = normalizeHttpErrorPayload(
      {
        errors: {
          email: ['has already been taken'],
          password: ['is too short (minimum is 8 characters)'],
        },
      },
      {},
      422,
    );
    expect(rails.vendor).toBe('rails');
    expect(rails.message).toContain('email');

    // 7. FastAPI / Pydantic error shape
    const fastapi = normalizeHttpErrorPayload(
      {
        detail: [
          {
            loc: ['body', 'user_id'],
            msg: 'field required',
            type: 'value_error.missing',
          },
        ],
      },
      {},
      422,
    );
    expect(fastapi.vendor).toBe('fastapi');
    expect(fastapi.message).toContain('user_id');

    // 8. RFC 7807 Problem Details
    const rfc7807 = normalizeHttpErrorPayload(
      {
        type: 'https://example.com/probs/out-of-credit',
        title: 'You do not have enough credit.',
        status: 403,
        detail: 'Your current balance is 30, but that costs 50.',
        invalid_params: [{ name: 'amount', reason: 'must be <= 30' }],
      },
      {},
      403,
    );
    expect(rfc7807.vendor).toBe('rfc7807');
    expect(rfc7807.status).toBe(403);
  });

  it('parses Retry-After header in both delta-seconds and HTTP-date formats', () => {
    const now = 1_700_000_000_000;
    expect(parseRetryAfterHeader('5', now)).toBe(5);
    expect(parseRetryAfterHeader('0', now)).toBe(0);

    const futureDate = new Date(now + 12_000).toUTCString();
    const parsedDateSec = parseRetryAfterHeader(futureDate, now);
    expect(parsedDateSec).toBeGreaterThanOrEqual(11);
    expect(parsedDateSec).toBeLessThanOrEqual(13);
  });

  it('classifies all required HTTP status codes and transport error families accurately', () => {
    const baseCtx = { method: 'GET', url: URL_, isRead: true };

    expect(classifyHttpError(jsonResponse({ error: 'bad input' }, 400), { error: 'bad input' }, baseCtx).family).toBe('validation');
    expect(classifyHttpError(jsonResponse({ error: 'unauthorized' }, 401), { error: 'unauthorized' }, baseCtx).family).toBe('auth');
    expect(classifyHttpError(jsonResponse({ error: 'forbidden' }, 403), { error: 'forbidden' }, baseCtx).family).toBe('auth');
    expect(classifyHttpError(jsonResponse({ error: 'not found' }, 404), { error: 'not found' }, baseCtx).family).toBe('not_found');
    expect(classifyHttpError(jsonResponse({ error: 'method not allowed' }, 405), { error: 'method not allowed' }, baseCtx).family).toBe('validation');
    expect(classifyHttpError(jsonResponse({ error: 'conflict' }, 409), { error: 'conflict' }, baseCtx).family).toBe('conflict');
    expect(classifyHttpError(jsonResponse({ error: 'gone' }, 410), { error: 'gone' }, baseCtx).family).toBe('not_found');
    expect(classifyHttpError(jsonResponse({ error: 'unprocessable' }, 422), { error: 'unprocessable' }, baseCtx).family).toBe('validation');

    const rateLim = classifyHttpError(
      jsonResponse({ error: 'rate limit' }, 429, { 'retry-after': '4' }),
      { error: 'rate limit' },
      baseCtx,
    );
    expect(rateLim.family).toBe('rate_limit');
    expect(rateLim.normalized.retryable).toBe(true);
    expect(rateLim.normalized.retryAfter).toBe(4);

    for (const code of [500, 502, 503, 504]) {
      const serverErr = classifyHttpError(
        jsonResponse({ error: 'upstream fail' }, code),
        { error: 'upstream fail' },
        baseCtx,
      );
      expect(serverErr.family).toBe(code === 504 ? 'timeout' : 'server');
      expect(serverErr.normalized.retryable).toBe(true);
    }

    // Transport / timeout / DNS / TLS / CORS errors
    const timeoutErr = new DOMException('The operation was aborted', 'AbortError');
    const classifiedTimeout = classifyHttpError(null, timeoutErr, baseCtx);
    expect(classifiedTimeout.family).toBe('timeout');
    expect(classifiedTimeout.normalized.retryable).toBe(true);

    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' });
    expect(classifyHttpError(null, dnsErr, baseCtx).family).toBe('network');

    const tlsErr = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    const classifiedTls = classifyHttpError(null, tlsErr, baseCtx);
    expect(classifiedTls.family).toBe('network');
    expect(classifiedTls.normalized.retryable).toBe(false); // TLS errors fail-closed without blind retry

    const corsErr = new TypeError('Failed to fetch: CORS policy blocked request');
    expect(classifyHttpError(null, corsErr, baseCtx).family).toBe('network');
  });

  it('detects disguised/hidden errors and partial-success envelopes inside HTTP 200 OK', () => {
    // Disguised error in 200 OK
    const hiddenAuth = inspectSuccessBodyForHiddenError({
      ok: false,
      status: 401,
      error: { code: 'TOKEN_EXPIRED', message: 'JWT has expired' },
    });
    expect(hiddenAuth.isHiddenError).toBe(true);
    expect(hiddenAuth.inferredStatus).toBe(401);

    // Partial success in 200 OK (GraphQL / batch style)
    const partial = inspectSuccessBodyForHiddenError({
      data: { orderId: 'ord_1', amount: 120 },
      errors: [{ message: 'Recommendations service timed out', path: ['recommendations'] }],
    });
    expect(partial.isPartialSuccess).toBe(true);
    expect(partial.extractedData).toEqual({ orderId: 'ord_1', amount: 120 });

    // Repair malformed JSON (XSSI prefix + trailing commas)
    const repaired = repairMalformedJson(`)]}'\n{"orderId": "123", "amount": 99,}`);
    expect(repaired.safe).toBe(true);
    expect(repaired.repaired).toEqual({ orderId: '123', amount: 99 });
  });

  it('resolves strategies in hybrid priority order and computes bounded backoff with Retry-After', () => {
    const baseCtx = {
      method: 'GET',
      url: URL_,
      isRead: true,
      hasAuthRefresh: true,
      hasLkg: true,
    };
    const err401 = classifyHttpError(
      jsonResponse({ error: 'Token expired' }, 401),
      { error: 'Token expired' },
      baseCtx,
    );
    const decision401 = decideHandler(err401, err401.signature, baseCtx);
    expect(decision401.strategy).toBe('auth_refresh');
    expect(decision401.tier).toBe('deterministic_rule');
    expect(FIX_REGISTRY[decision401.strategy]).toBeDefined();

    // Backoff respects Retry-After (seconds) when present
    const delayWithHeader = computeBackoffDelay(0, {
      baseDelayMs: 100,
      maxDelayMs: 5000,
      retryAfterSec: 3,
    });
    expect(delayWithHeader).toBe(3000);

    // Backoff without Retry-After stays within [1, maxDelayMs]
    const jittered = computeBackoffDelay(2, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      randomFn: () => 0.5,
    });
    expect(jittered).toBe(300);
  });
});

describe('HTTP Error Resilience Engine — End-to-End healerFetch Recovery', () => {
  it('401 Unauthorized -> executes authRefresh once and succeeds with AUTH_REFRESHED', async () => {
    queueResponse(jsonResponse({ error: { code: 'token_expired', message: 'JWT expired' } }, 401));
    queueResponse(jsonResponse({ orderId: 'ord_1', amount: 500 }, 200));

    const res = await healerFetch(
      URL_,
      { method: 'GET', headers: { authorization: 'Bearer expired_token' } },
      {
        contractId: CONTRACT_ID,
        authRefresh: async () => 'fresh_jwt_token_v2',
      },
    );

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(2);
    const secondHeaders = new Headers(fetchCalls[1]?.init?.headers);
    expect(secondHeaders.get('authorization')).toBe('Bearer fresh_jwt_token_v2');
    expect(res.__healer?.status).toBe('AUTH_REFRESHED');
    expect(runtimeCounters().authRefreshed).toBe(1);
  });

  it('404 Not Found / 410 Gone -> remaps to fallback endpoint with ENDPOINT_REMAPPED', async () => {
    queueResponse(jsonResponse({ error: 'Endpoint deprecated and removed' }, 410));
    queueResponse(jsonResponse({ orderId: 'ord_v2', amount: 750 }, 200));

    const res = await healerFetch(
      'https://upstream.test/v1/legacy-orders',
      { method: 'GET' },
      {
        contractId: CONTRACT_ID,
        endpointFallbacks: {
          'https://upstream.test/v1/legacy-orders': 'https://upstream.test/v2/orders',
        },
      },
    );

    expect(res.status).toBe(200);
    expect(res.__healer?.status).toBe('ENDPOINT_REMAPPED');
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://upstream.test/v1/legacy-orders',
      'https://upstream.test/v2/orders',
    ]);
    expect(runtimeCounters().endpointRemapped).toBe(1);
  });

  it('405 Method Not Allowed -> adapts to safe Allow header method (GET) and refuses unsafe DELETE', async () => {
    queueResponse(jsonResponse({ error: 'Method POST not allowed' }, 405, { allow: 'GET, HEAD' }));
    queueResponse(jsonResponse({ orderId: 'ord_get', amount: 100 }, 200));

    const safeRes = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ query: 'all' }) },
      { contractId: CONTRACT_ID },
    );
    expect(safeRes.status).toBe(200);
    expect(safeRes.__healer?.status).toBe('METHOD_CORRECTED');
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1]?.init?.method).toBe('GET');

    // Unsafe Allow: DELETE must NOT be auto-triggered
    fetchCalls = [];
    queueResponse(jsonResponse({ error: 'Only DELETE allowed' }, 405, { allow: 'DELETE' }));
    const unsafeRes = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });
    expect(unsafeRes.status).toBe(405);
    expect(fetchCalls.length).toBe(1);
  });

  it('409 Conflict -> invokes conflictResolver and retries with updated version', async () => {
    queueResponse(jsonResponse({ error: 'Version conflict', expectedVersion: 5 }, 409));
    queueResponse(jsonResponse({ orderId: 'ord_conflict', amount: 300, version: 5 }, 200));

    const res = await healerFetch(
      URL_,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ord_conflict', amount: 300, version: 4 }),
      },
      {
        contractId: CONTRACT_ID,
        conflictResolver: (sentBody, conflictBody) => {
          const expected = (conflictBody as { expectedVersion?: number })?.expectedVersion ?? 5;
          return { ...sentBody, version: expected };
        },
      },
    );

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({
      orderId: 'ord_conflict',
      amount: 300,
      version: 5,
    });
    expect(res.__healer?.status).toBe('CONFLICT_RESOLVED');
    expect(runtimeCounters().conflictResolved).toBe(1);
  });

  it('422 FastAPI/Pydantic validation error -> adapts outbound payload and retries once', async () => {
    queueResponse(
      jsonResponse(
        {
          detail: [
            {
              loc: ['body', 'amount'],
              msg: 'Input should be a valid number',
              type: 'float_parsing',
            },
          ],
        },
        422,
      ),
    );
    queueResponse(jsonResponse({ orderId: 'ord_fastapi', amount: 450 }, 200));

    const res = await healerFetch(
      URL_,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: 'ord_fastapi', amount: '450' }),
      },
      { contractId: CONTRACT_ID },
    );

    expect(res.status).toBe(200);
    expect(res.__healer?.status).toBe('OUTBOUND_ADAPTED');
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({
      orderId: 'ord_fastapi',
      amount: 450,
    });
  });

  it('503 Service Unavailable -> retries bounded times and succeeds with RETRIED_TRANSIENT', async () => {
    queueResponse(jsonResponse({ error: 'Upstream temporarily overloaded' }, 503, { 'retry-after': '0' }));
    queueResponse(jsonResponse({ orderId: 'ord_recovered', amount: 880 }, 200));

    const res = await healerFetch(
      URL_,
      { method: 'GET' },
      { contractId: CONTRACT_ID, maxRetries: 2, baseDelayMs: 5 },
    );

    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(2);
    expect(res.__healer?.status).toBe('RETRIED_TRANSIENT');
    expect(runtimeCounters().retriedTransient).toBe(1);
  });

  it('200 OK with malformed JSON, partial-success, or hidden error -> repairs or serves LKG safely', async () => {
    // Seed LKG for the contract
    setLastKnownGood(CONTRACT_ID, { orderId: 'ord_lkg', amount: 420 });

    // 1. Upstream returns 200 OK with XSSI prefix and trailing comma -> repaired automatically
    queueResponse(
      new Response(`)]}'\n{"orderId": "ord_xssi", "amount": 555,}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const repairedRes = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });
    expect(repairedRes.status).toBe(200);
    expect(repairedRes.headers.get('x-api-healer-syntax-repaired')).toBe('true');
    expect(await repairedRes.json()).toEqual({ orderId: 'ord_xssi', amount: 555 });

    // 2. Upstream returns 200 OK with partial-success envelope { data, errors } -> unwraps data
    queueResponse(
      jsonResponse(
        {
          data: { orderId: 'ord_partial', amount: 99 },
          errors: [{ message: 'Recommendations service unavailable' }],
        },
        200,
      ),
    );
    const partialRes = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });
    expect(partialRes.status).toBe(200);
    expect(partialRes.headers.get('x-api-healer-partial')).toBe('unwrapped');
    expect(await partialRes.json()).toEqual({ orderId: 'ord_partial', amount: 99 });

    // 3. Upstream returns 200 OK with disguised 503 error -> serves LKG stale cache instead of corrupt error payload
    setLastKnownGood(CONTRACT_ID, { orderId: 'ord_lkg', amount: 420 });
    queueResponse(
      jsonResponse(
        {
          ok: false,
          error: { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Database pool exhausted' },
        },
        200,
      ),
    );
    const hiddenErrRes = await healerFetch(URL_, { method: 'GET' }, { contractId: CONTRACT_ID });
    expect(hiddenErrRes.status).toBe(200);
    expect(hiddenErrRes.__healer?.status).toBe('FALLBACK_STALE');
    expect(await hiddenErrRes.json()).toEqual({ orderId: 'ord_lkg', amount: 420 });
  });

  it('Network / AbortError timeout on GET falls back to LKG, and on non-idempotent POST returns safe 503 DEGRADED without double-submitting', async () => {
    setLastKnownGood(CONTRACT_ID, { orderId: 'ord_cached', amount: 1000 });

    // GET timeout -> serves LKG
    queueResponse(async () => {
      throw new DOMException('Request timed out', 'AbortError');
    });
    const getRes = await healerFetch(
      URL_,
      { method: 'GET' },
      { contractId: CONTRACT_ID, maxRetries: 0 },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.__healer?.status).toBe('FALLBACK_STALE');
    expect(await getRes.json()).toEqual({ orderId: 'ord_cached', amount: 1000 });

    // Non-idempotent POST network error -> does NOT retry blindly, returns structured 503 DEGRADED
    fetchCalls = [];
    queueResponse(async () => {
      throw new TypeError('fetch failed: socket hang up');
    });
    const postRes = await healerFetch(
      URL_,
      { method: 'POST', body: JSON.stringify({ orderId: 'ord_new', amount: 5000 }) },
      { contractId: CONTRACT_ID, maxRetries: 3 },
    );
    expect(fetchCalls.length).toBe(1); // Never retried non-idempotent POST without Idempotency-Key
    expect(postRes.status).toBe(503);
    expect(postRes.__healer?.status).toBe('DEGRADED');
    const degradedBody = await postRes.json();
    expect(degradedBody.degraded).toBe(true);

    // Telemetry recorded the classified events
    const telemetry = getResilienceTelemetry();
    expect(telemetry.length).toBeGreaterThan(0);
  });

  it('resilientClientFetch retries 504 and refreshes token on 401 for browser/API client calls', async () => {
    let callCount = 0;
    const customFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const headers = new Headers(init?.headers);
      if (callCount === 1) {
        return jsonResponse({ error: 'Token expired' }, 401);
      }
      if (callCount === 2) {
        expect(headers.get('Authorization')).toBe('Bearer refreshed_client_token');
        return jsonResponse({ error: 'Gateway timeout' }, 504, { 'retry-after': '0' });
      }
      return jsonResponse({ ok: true, synced: true }, 200);
    }) as typeof fetch;

    const res = await resilientClientFetch(
      'https://api.example.com/api/auth/sync',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer old_token' },
      },
      {
        fetchImpl: customFetch,
        maxRetries: 2,
        baseDelayMs: 5,
        onUnauthorized: async () => 'refreshed_client_token',
      },
    );

    expect(res.status).toBe(200);
    expect(callCount).toBe(3);
    expect(await res.json()).toEqual({ ok: true, synced: true });
  });

  it('public/api-healer-client.ts standalone SDK exposes classifyHttpError, normalizeHttpErrorPayload, and repairMalformedJson', async () => {
    const sdk = await import('../../public/api-healer-client');
    const c401 = sdk.classifyHttpError({ status: 401 }, { error: { code: 'token_expired', message: 'JWT expired' } });
    expect(c401.family).toBe('auth');
    expect(c401.recommendedStrategy).toBe('auth_refresh');

    const c429 = sdk.classifyHttpError(
      { status: 429, headers: { 'retry-after': '7' } },
      { error: { type: 'rate_limit_error', message: 'Too many requests' } },
    );
    expect(c429.family).toBe('rate_limit');
    expect(c429.normalized.retryAfter).toBe(7);

    const repaired = sdk.repairMalformedJson(`)]}'\n{"ok":true,}`);
    expect(repaired.safe).toBe(true);
    expect(repaired.repaired).toEqual({ ok: true });
  });
});

