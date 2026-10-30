import { describe, test, expect } from 'bun:test';
import { generateAiCodeFix } from '@/lib/ai/code-fixer';

describe('AI Code Fixer & Resilience Rules Engine', () => {
  test('generates production patch and test for NULL_POINTER_TRAP enforcing Gate 1 and Zod', async () => {
    const res = await generateAiCodeFix({
      errorType: 'NULL_POINTER_TRAP',
      statusCode: 200,
      rawPayload: { user: null, items: null },
      crashSignature: "TypeError: Cannot read properties of null (reading 'map')",
      context: { url: '/api/v1/dashboard', method: 'GET' },
      forceFallback: true,
    });

    expect(res.success).toBe(true);
    expect(res.productionPatch).toContain('zod');
    expect(res.productionPatch).toContain('default');
    expect(res.testSnippet).toContain('test');
    expect(res.rulesEnforced.length).toBeGreaterThan(0);
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.gateChecklist.contractSafetyPassed).toBe(true);
    expect(res.rootCauseHindi).toBeDefined();
    expect(res.hackathonPitchHindi).toBeDefined();
  });

  test('generates production patch for 401 Unauthorized with token refresh mutex', async () => {
    const res = await generateAiCodeFix({
      errorType: 'AUTH_401',
      statusCode: 401,
      rawPayload: { error: 'TOKEN_EXPIRED', message: 'JWT access token expired' },
      context: { url: '/api/v1/checkout', method: 'POST' },
      forceFallback: true,
    });

    expect(res.success).toBe(true);
    expect(res.productionPatch).toContain('401');
    expect(res.productionPatch).toContain('Authorization');
    expect(res.gateChecklist.failClosedGuaranteed).toBe(true);
  });

  test('generates production patch for 429/503 with bounded backoff and jitter', async () => {
    const res = await generateAiCodeFix({
      errorType: 'RATE_LIMIT_429',
      statusCode: 429,
      rawPayload: { error: 'Too many requests' },
      context: { url: '/api/v1/status', method: 'GET' },
      forceFallback: true,
    });

    expect(res.success).toBe(true);
    expect(res.productionPatch).toContain('Math.random()');
    expect(res.productionPatch).toContain('retry-after');
    expect(res.gateChecklist.anomalyBoundaryProtected).toBe(true);
  });
});
