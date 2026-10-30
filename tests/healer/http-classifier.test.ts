import { beforeEach, describe, expect, it } from 'bun:test';
import {
  classifyHttpError,
  normalizeHttpErrorPayload,
  parseRetryAfterHeader,
  repairMalformedJson,
  inspectSuccessBodyForHiddenError,
  computeErrorSignature,
  registerCustomErrorRule,
  clearCustomErrorRules,
} from '@/lib/healer/http-classifier';

describe('src/lib/healer/http-classifier.ts — Foundation Unit Tests', () => {
  beforeEach(() => {
    clearCustomErrorRules();
  });

  it('normalizeHttpErrorPayload(rawError) works with single-argument vendor & wrapper payloads', () => {
    // 1. Single-arg Stripe error payload
    const stripe = normalizeHttpErrorPayload({
      error: {
        type: 'invalid_request_error',
        code: 'parameter_unknown',
        param: 'amount_cents',
        message: 'Received unknown parameter: amount_cents',
      },
    });
    expect(stripe.vendor).toBe('stripe');
    expect(stripe.code).toBe('parameter_unknown');
    expect(stripe.payloadSafeToRepair).toBe(true);

    // 2. Single-arg Axios/Fetch response wrapper `{ response: { status, headers, data } }`
    const wrapped = normalizeHttpErrorPayload({
      message: 'Request failed with status code 429',
      response: {
        status: 429,
        headers: { 'Retry-After': '18' },
        data: { error: { code: 'RATE_LIMITED', message: 'Slow down' } },
      },
    });
    expect(wrapped.status).toBe(429);
    expect(wrapped.retryAfter).toBe(18);
    expect(wrapped.retryable).toBe(true);

    // 3. Single-arg AWS exception payload
    const aws = normalizeHttpErrorPayload({
      __type: 'ProvisionedThroughputExceededException',
      message: 'Rate of requests exceeds allowed throughput',
    });
    expect(aws.vendor).toBe('aws');
    expect(aws.status).toBe(429);
    expect(aws.retryable).toBe(true);
  });

  it('classifyHttpError(response, error, context) classifies all major HTTP failure families', () => {
    const auth401 = classifyHttpError(
      { status: 401 },
      { error: { code: 'TOKEN_EXPIRED', message: 'JWT expired' } },
    );
    expect(auth401.family).toBe('auth');
    expect(auth401.recommendedStrategy).toBe('auth_refresh');

    const validation422 = classifyHttpError(
      { status: 422 },
      { detail: [{ loc: ['body', 'price'], msg: 'Input should be a valid number', type: 'float_parsing' }] },
    );
    expect(validation422.family).toBe('validation');
    expect(validation422.recommendedStrategy).toBe('payload_repair');
    expect(validation422.normalized.vendor).toBe('fastapi');

    const rate429 = classifyHttpError(
      { status: 429, headers: { 'retry-after': '30' } },
      { message: 'Too many requests' },
      { isRead: false },
    );
    expect(rate429.family).toBe('rate_limit');
    expect(rate429.recommendedStrategy).toBe('rate_limit_wait');
    expect(rate429.normalized.retryAfter).toBe(30);

    const hidden200 = classifyHttpError(
      { status: 200 },
      { ok: false, error_code: 'UNAUTHENTICATED', message: 'jwt expired' },
    );
    expect(hidden200.statusCode).toBe(401);
    expect(hidden200.family).toBe('auth');
    expect(hidden200.normalized.hiddenError).toBe(true);
    expect(hidden200.recommendedStrategy).toBe('auth_refresh');
  });

  it('supports custom rule registration via registerCustomErrorRule and structural hashing', () => {
    registerCustomErrorRule({
      id: 'custom-maintenance-window',
      match: (norm) => norm.code === 'MAINTENANCE_WINDOW',
      family: 'server',
      severity: 'critical',
      strategy: 'fallback_stale_payload',
      confidence: 0.99,
    });

    const classified = classifyHttpError(
      { status: 200 },
      { ok: false, code: 'MAINTENANCE_WINDOW', message: 'Scheduled maintenance' },
      { isRead: true, hasLkg: true },
    );
    expect(classified.family).toBe('server');
    expect(classified.recommendedStrategy).toBe('fallback_stale_payload');
    expect(classified.resolutionTier).toBe('signature_match');
    expect(classified.confidence).toBe(0.99);
    expect(classified.signature).toHaveLength(64);
  });

  it('exposes helper utilities for Retry-After, malformed JSON repair, and hidden error inspection', () => {
    expect(parseRetryAfterHeader('45')).toBe(45);
    const repaired = repairMalformedJson(")]}',\n{\"id\":\"ord_1\",\"amount\":99,}");
    expect(repaired.safe).toBe(true);
    expect(repaired.repaired).toEqual({ id: 'ord_1', amount: 99 });

    const partial = inspectSuccessBodyForHiddenError({
      data: { order_id: 'ord_1' },
      errors: [{ message: 'Non-critical warning' }],
    });
    expect(partial.isPartialSuccess).toBe(true);
    expect(partial.extractedData).toEqual({ order_id: 'ord_1' });

    const sig = computeErrorSignature({
      family: 'auth',
      statusCode: 401,
      vendor: 'stripe',
      code: 'TOKEN_EXPIRED',
      rawError: { error: { code: 'TOKEN_EXPIRED' } },
    });
    expect(sig).toHaveLength(64);
  });
});
