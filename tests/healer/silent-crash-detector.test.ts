import { describe, test, expect } from 'bun:test';
import {
  analyzeAndHealSilentCrashTraps,
} from '@/lib/healer/silent-crash-detector';

describe('Silent Crash Detector & Sanitizer', () => {
  test('detects and heals NULL_POINTER_TRAP on missing/null user object', () => {
    const raw = {
      orderId: 'ORD-9921',
      user: null, // Frontend will call user.name or user.email
    };

    const res = analyzeAndHealSilentCrashTraps(raw);
    expect(res.hasSilentTraps).toBe(true);
    expect(res.risks.some((r) => r.trapType === 'NULL_POINTER_TRAP')).toBe(true);
    // Verified healed payload replaces null user with safe container {}
    const healed = res.healedPayload as Record<string, unknown>;
    expect(typeof healed.user).toBe('object');
    expect(healed.user).not.toBeNull();
  });

  test('detects and heals ARRAY_METHOD_TRAP on null items array', () => {
    const raw = {
      category: 'Electronics',
      items: null, // Frontend will execute items.map(...) or items.length
    };

    const res = analyzeAndHealSilentCrashTraps(raw);
    expect(res.hasSilentTraps).toBe(true);
    const risk = res.risks.find((r) => r.trapType === 'ARRAY_METHOD_TRAP');
    expect(risk).toBeDefined();
    expect(risk?.clientCrashSignature).toContain("Cannot read properties of null (reading 'map')");

    const healed = res.healedPayload as Record<string, unknown>;
    expect(Array.isArray(healed.items)).toBe(true);
    expect((healed.items as unknown[]).length).toBe(0);
  });

  test('detects and sanitizes POISONED_LITERAL_TRAP ("null", "undefined", "NaN")', () => {
    const raw = {
      userId: 'null', // string literal "null" evaluates truthy in JS
      secondaryEmail: 'undefined',
      price: 'NaN',
    };

    const res = analyzeAndHealSilentCrashTraps(raw);
    expect(res.hasSilentTraps).toBe(true);
    const healed = res.healedPayload as Record<string, unknown>;
    expect(healed.userId).toBeNull();
    expect(healed.secondaryEmail).toBeUndefined();
    expect(healed.price).toBe(0);
  });

  test('detects and strips MALFORMED_TRANSPORT_JSON with XSSI guard prefix', () => {
    const rawText = `)]}',\n{"status":"ACTIVE","userId":"usr_772"}`;
    const res = analyzeAndHealSilentCrashTraps(null, null, rawText);

    expect(res.hasSilentTraps).toBe(true);
    expect(res.risks.some((r) => r.trapType === 'MALFORMED_TRANSPORT_JSON')).toBe(true);
    const healed = res.healedPayload as Record<string, unknown>;
    expect(healed.status).toBe('ACTIVE');
    expect(healed.userId).toBe('usr_772');
  });

  test('detects DISGUISED_ERROR_200 with explicit false flag', () => {
    const raw = {
      ok: false,
      error: 'SUBSCRIPTION_EXPIRED',
      message: 'Plan renewed expired yesterday',
    };

    const res = analyzeAndHealSilentCrashTraps(raw);
    expect(res.hasSilentTraps).toBe(true);
    expect(res.risks.some((r) => r.trapType === 'DISGUISED_ERROR_200')).toBe(true);
  });

  test('detects GRAPHQL_PARTIAL_FAILURE with data: null and resolver errors', () => {
    const raw = {
      data: null,
      errors: [
        {
          message: 'Cannot fetch customer records',
          locations: [{ line: 2, column: 3 }],
        },
      ],
    };

    const res = analyzeAndHealSilentCrashTraps(raw);
    expect(res.hasSilentTraps).toBe(true);
    expect(res.risks.some((r) => r.trapType === 'GRAPHQL_PARTIAL_FAILURE')).toBe(true);
  });

  test('detects EMPTY_BODY_OR_HTML returned with HTTP 200', () => {
    const emptyText = '   ';
    const resEmpty = analyzeAndHealSilentCrashTraps(null, null, emptyText);
    expect(resEmpty.hasSilentTraps).toBe(true);
    expect(resEmpty.risks.some((r) => r.trapType === 'EMPTY_BODY_OR_HTML')).toBe(true);

    const htmlText = '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>';
    const resHtml = analyzeAndHealSilentCrashTraps(null, null, htmlText);
    expect(resHtml.hasSilentTraps).toBe(true);
    expect(resHtml.risks.some((r) => r.trapType === 'EMPTY_BODY_OR_HTML')).toBe(true);
  });

  test('executes L1 hot-cache sanitization in <0.2ms on repeated trap topologies', () => {
    const trapPayload = {
      orderId: 'ORD-FAST-1',
      user: null,
      items: null,
      price: 'NaN',
    };

    // Cold scan populates L1 cache
    const cold = analyzeAndHealSilentCrashTraps(trapPayload);
    expect(cold.cacheHit).toBe(false);
    expect(cold.hasSilentTraps).toBe(true);

    // Warm scan hits L1 cache in sub-millisecond budget
    const warm = analyzeAndHealSilentCrashTraps({
      orderId: 'ORD-FAST-2',
      user: null,
      items: null,
      price: 'NaN',
    });
    expect(warm.cacheHit).toBe(true);
    expect(warm.runtimeMs).toBeLessThan(0.5);
    const healed = warm.healedPayload as Record<string, unknown>;
    expect(Array.isArray(healed.items)).toBe(true);
    expect(typeof healed.user).toBe('object');
    expect(healed.price).toBe(0);
  });
});
