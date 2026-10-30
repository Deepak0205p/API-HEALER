/**
 * Cold-Start Quarantine tests — closes the blindness window where the first
 * 1-2 requests of a 100× unit bug (499 ↔ 49900) sailed through because a
 * z-score needs ≥3 history samples. Regimes:
 *   ≥3 samples → |z| > 4.5 (unchanged)
 *   1-2 samples → ratio vs history[0]: >10× or <0.1× ⇒ veto with an honest reason
 *   0 samples   → blind by information theory (documented residual)
 */
import { describe, expect, test } from 'bun:test';
import { classify, sigmaViolation, zScore } from '@/lib/healer/classifier';
import { gateSigma } from '@/lib/healer/gates';
import { runCanary } from '@/lib/healer/canary';
import type { ContractDef, HealPlan, HistoryMap } from '@/lib/healer/types';

const CONTRACT: ContractDef = {
  fields: {
    orderId: { type: 'string', mandatory: true },
    amount: { type: 'number', mandatory: true, unit: 'INR' },
  },
};

describe('sigmaViolation regimes', () => {
  test('≥3 samples → standard |z| > 4.5 regime (unchanged behavior)', () => {
    const history = [495, 500, 505, 498, 502];
    expect(sigmaViolation(499, history)).toBeNull();        // healthy
    expect(sigmaViolation(49900, history)?.kind).toBe('sigma'); // 100× bug
  });

  test('1-2 samples → 100× jump is vetoed with the honest cold-start reason', () => {
    const v = sigmaViolation(49900, [499]);
    expect(v).not.toBeNull();
    expect(v?.kind).toBe('cold-start');
    expect(v?.detail).toContain('Cold-start magnitude anomaly detected. Auto-patch refused.');
  });

  test('cold-start applies with 2 samples too', () => {
    expect(sigmaViolation(49900, [499, 505])?.kind).toBe('cold-start');
  });

  test('ratio boundaries: exactly 10× and 0.1× allowed, just beyond vetoed', () => {
    expect(sigmaViolation(5000, [500])).toBeNull();   // 10.0× — allowed (spec: > 10 vetoes)
    expect(sigmaViolation(50, [500])).toBeNull();     // 0.1× — allowed (spec: < 0.1 vetoes)
    expect(sigmaViolation(5100, [500])?.kind).toBe('cold-start'); // 10.2×
    expect(sigmaViolation(45, [500])?.kind).toBe('cold-start');   // 0.09×
  });

  test('legit variation inside the ±10× band passes on 1-2 samples', () => {
    expect(sigmaViolation(749, [499])).toBeNull();    // 1.5× — normal growth
    expect(sigmaViolation(199, [499])).toBeNull();    // 0.4× — normal dip
  });

  test('zero baseline has no magnitude meaning — no false veto of the first real value', () => {
    expect(sigmaViolation(250, [0])).toBeNull();
    // but a value collapsing TO zero vs a real baseline is a <0.1× anomaly ⇒ veto (spec)
    expect(sigmaViolation(0, [250])?.kind).toBe('cold-start');
  });

  test('0 samples → statistically blind (value forms the baseline)', () => {
    expect(sigmaViolation(49900, [])).toBeNull();
  });

  test('zScore math itself is untouched', () => {
    expect(zScore(499, [499, 499, 499])).toBe(0);
    expect(zScore(1, [499, 499, 499])).toBe(Infinity); // zero-sd branch: magnitude-only, unsigned
    expect(zScore(499, [])).toBeNull();
  });
});

describe('integration: classification + gates + canary', () => {
  test('classify() emits a cold-start SPIKE finding on 1-sample history', () => {
    const history: HistoryMap = { amount: [499] };
    const result = classify({
      payload: { orderId: 'T-1', amount: 49900 },
      contractDef: CONTRACT,
      history,
    });
    const spike = result.findings.find((f) => f.type === 'SPIKE');
    expect(spike).toBeDefined();
    expect(spike?.meta.kind).toBe('cold-start');
    expect(String(spike?.meta.reason)).toContain('Cold-start magnitude anomaly detected. Auto-patch refused.');
    expect(result.driftType).toBe('SPIKE');
  });

  test('classify() stays silent on healthy numerics with 1-sample history', () => {
    const result = classify({
      payload: { orderId: 'T-1', amount: 512 },
      contractDef: CONTRACT,
      history: { amount: [499] },
    });
    expect(result.findings.filter((f) => f.type === 'SPIKE')).toHaveLength(0);
  });

  test('gateSigma vetoes a 100× healed payload with the honest refusal reason', () => {
    const g = gateSigma({ orderId: 'T-1', amount: 49900 }, { amount: [499] });
    expect(g.passed).toBe(false);
    expect(g.detail).toContain('Cold-start magnitude anomaly detected. Auto-patch refused.');
    expect(g.detail).toContain('"amount"');
  });

  test('gateSigma keeps the statistical message in the ≥3-sample regime', () => {
    const g = gateSigma({ orderId: 'T-1', amount: 49900 }, { amount: [495, 500, 505] });
    expect(g.passed).toBe(false);
    expect(g.detail).toContain('100× unit-bug protection engaged');
  });

  test('runCanary numeric-sigma check honors the cold-start quarantine', () => {
    const plan: HealPlan = {
      version: 1,
      ops: [{ op: 'RENAME', from: 'order_ref', to: 'orderId' }],
      confidence: 0.92,
      rationale: 'rename',
      composer: 'deterministic',
    };
    const result = runCanary({
      rawPayload: { order_ref: 'T-9', amount: 49900 },
      healedPayload: { orderId: 'T-9', amount: 49900 },
      plan,
      contractDef: CONTRACT,
      mandatory: ['orderId', 'amount'],
      history: { amount: [499] },
    });
    const check = result.log.find((l) => l.check === 'numeric-sigma');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('Cold-start magnitude anomaly detected');
    expect(result.passed).toBe(false);
  });
});
