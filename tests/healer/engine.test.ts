/**
 * API-HEALER · Engine core test suite (bun test)
 * Covers: classifier · DSL interpreter · plan composer · 3-gate refusal engine
 */
import { describe, expect, test } from 'bun:test';
import { classify, namesSimilar } from '../../src/lib/healer/classifier';
import { applyPlan, assertSafePath, summarizePlan } from '../../src/lib/healer/dsl';
import { composeDeterministic } from '../../src/lib/healer/composer';
import { runGates, gateSigma } from '../../src/lib/healer/gates';
import type { ContractDef, HealPlan } from '../../src/lib/healer/types';

const CHECKOUT: ContractDef = {
  fields: {
    orderId: { type: 'string', mandatory: true },
    amount: { type: 'number', mandatory: true, unit: '₹' },
    currency: { type: 'string', mandatory: true },
    paymentMethod: { type: 'string' },
  },
};

const HEALTHY = { orderId: 'ORD-1', amount: 499, currency: 'INR', paymentMethod: 'UPI' };

const HISTORY = { amount: [429, 499, 549, 649, 399, 799, 459, 899, 499, 599] };

const plan = (ops: HealPlan['ops'], confidence = 0.95): HealPlan => ({
  version: 1,
  ops,
  confidence,
  rationale: 'test',
  composer: 'deterministic',
});

// ─── Classifier ────────────────────────────────────────────────────────────

describe('classifier', () => {
  test('healthy payload → NONE', () => {
    const c = classify({ payload: HEALTHY, contractDef: CHECKOUT, history: HISTORY });
    expect(c.driftType).toBe('NONE');
    expect(c.diffMs).toBeLessThan(5);
  });

  test('detects TYPE drift (string amount)', () => {
    const c = classify({
      payload: { ...HEALTHY, amount: '499' },
      contractDef: CHECKOUT,
      history: HISTORY,
    });
    expect(c.driftType).toBe('TYPE');
    expect(c.findings[0].meta.expectedType).toBe('number');
  });

  test('detects RENAME drift (order_id → orderId)', () => {
    const { orderId, ...rest } = HEALTHY;
    const c = classify({ payload: { ...rest, order_id: orderId }, contractDef: CHECKOUT });
    expect(c.driftType).toBe('RENAME');
    expect(c.findings[0].meta.observedKey).toBe('order_id');
  });

  test('detects MOVE drift (status → logistics.current_status)', () => {
    const LOGISTICS: ContractDef = {
      fields: {
        awb: { type: 'string', mandatory: true },
        status: { type: 'string', mandatory: true },
        logistics: { type: 'object', fields: { current_status: { type: 'string' } } },
      },
    };
    const c = classify({
      payload: { awb: 'SR-1', logistics: { current_status: 'IN_TRANSIT' } },
      contractDef: LOGISTICS,
    });
    expect(c.driftType).toBe('MOVE');
    expect(c.findings[0].meta.candidatePath).toBe('logistics.current_status');
  });

  test('flags ambiguity instead of guessing (3 similar candidates)', () => {
    const LOGISTICS: ContractDef = {
      fields: {
        awb: { type: 'string', mandatory: true },
        status: { type: 'string', mandatory: true },
      },
    };
    const c = classify({
      payload: {
        awb: 'SR-1',
        statusDetail: 'shipment in transit',
        status_code: 'IN_',
        latest_status: 'IN_TRANSIT',
      },
      contractDef: LOGISTICS,
    });
    expect(c.driftType).toBe('MOVE');
    expect(c.findings[0].meta.ambiguous).toBe(true);
    expect((c.findings[0].meta.candidates as string[]).length).toBe(3);
  });

  test('detects 4.5σ SPIKE (Rupees→Paise 100×)', () => {
    const c = classify({
      payload: { ...HEALTHY, amount: 49900 },
      contractDef: CHECKOUT,
      history: HISTORY,
    });
    expect(c.driftType).toBe('SPIKE');
    expect(Number(c.findings[0].meta.zScore)).toBeGreaterThan(4.5);
  });

  test('MISSING mandatory field flagged', () => {
    const { paymentMethod, ...rest } = HEALTHY;
    const { amount, ...missing } = rest;
    const c = classify({ payload: missing as Record<string, unknown>, contractDef: CHECKOUT });
    const f = c.findings.find((x) => x.path === 'amount');
    expect(f?.type).toBe('MISSING');
    expect(f?.meta.mandatory).toBe(true);
  });

  test('optional missing without candidates is not RENAME/MOVE', () => {
    const { paymentMethod, ...rest } = HEALTHY;
    const c = classify({ payload: rest, contractDef: CHECKOUT });
    expect(c.findings.every((f) => f.type === 'MISSING' && f.meta.mandatory === false)).toBe(true);
  });

  test('namesSimilar semantics', () => {
    expect(namesSimilar('order_id', 'orderId')).toBe(true);
    expect(namesSimilar('current_status', 'status')).toBe(true);
    expect(namesSimilar('amount', 'currency')).toBe(false);
  });
});

// ─── DSL interpreter ───────────────────────────────────────────────────────

describe('dsl', () => {
  test('RENAME moves key within parent', () => {
    const r = applyPlan({ order_id: 'X', amount: 1 }, plan([{ op: 'RENAME', from: 'order_id', to: 'orderId' }]));
    expect(r.opsFailed).toHaveLength(0);
    expect(r.result).toEqual({ orderId: 'X', amount: 1 });
  });

  test('MOVE relocates across parents', () => {
    const r = applyPlan(
      { logistics: { current_status: 'OK' } },
      plan([{ op: 'MOVE', from: 'logistics.current_status', to: 'status' }]),
    );
    expect(r.result).toEqual({ logistics: {}, status: 'OK' });
  });

  test('COERCE strict numeric coercion', () => {
    const r = applyPlan({ amount: '499.50' }, plan([{ op: 'COERCE', path: 'amount', cast: 'number' }]));
    expect(r.result.amount).toBe(499.5);
  });

  test('COERCE refuses garbage instead of guessing', () => {
    const r = applyPlan({ amount: '₹499' }, plan([{ op: 'COERCE', path: 'amount', cast: 'number' }]));
    expect(r.opsFailed).toHaveLength(1);
  });

  test('DEFAULT inserts whitelisted primitive', () => {
    const r = applyPlan({ orderId: 'X' }, plan([{ op: 'DEFAULT', path: 'paymentMethod', value: 'UPI' }]));
    expect(r.result.paymentMethod).toBe('UPI');
  });

  test('prototype pollution hard-rejected', () => {
    expect(() => assertSafePath('__proto__.polluted')).toThrow();
    expect(() => assertSafePath('a.constructor')).toThrow();
    expect(() => assertSafePath('ok.path')).not.toThrow();
    const r = applyPlan(
      { a: {} },
      plan([{ op: 'DEFAULT', path: '__proto__.x', value: 'evil' }]),
    );
    expect(r.opsFailed).toHaveLength(1);
    expect({} as Record<string, unknown>).not.toHaveProperty('x');
  });

  test('plan is idempotent', () => {
    const p = plan([{ op: 'COERCE', path: 'amount', cast: 'number' }]);
    const once = applyPlan({ amount: '499' }, p);
    const twice = applyPlan(once.result, p);
    expect(twice.result).toEqual(once.result);
  });

  test('unknown ops can never execute (compile-time exhaustiveness)', () => {
    const evil = { op: 'EVAL', code: 'process.exit(1)' } as unknown as HealPlan['ops'][number];
    const r = applyPlan(HEALTHY, plan([evil]));
    expect(r.opsFailed).toHaveLength(1);
  });

  test('summarizePlan human output', () => {
    expect(summarizePlan(plan([{ op: 'COERCE', path: 'amount', cast: 'number' }]))).toBe(
      'COERCE amount:number',
    );
  });
});

// ─── Composer ──────────────────────────────────────────────────────────────

describe('composer', () => {
  test('composes COERCE for TYPE drift', () => {
    const classification = classify({
      payload: { ...HEALTHY, amount: '499' },
      contractDef: CHECKOUT,
      history: HISTORY,
    });
    const out = composeDeterministic({
      payload: { ...HEALTHY, amount: '499' },
      contractDef: CHECKOUT,
      classification,
      defaults: {},
    });
    expect(out.plan?.ops).toEqual([{ op: 'COERCE', path: 'amount', cast: 'number' }]);
    expect(out.plan!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test('abstains on mandatory missing (no hallucination)', () => {
    const { amount, ...rest } = HEALTHY;
    const classification = classify({ payload: rest, contractDef: CHECKOUT });
    const out = composeDeterministic({
      payload: rest,
      contractDef: CHECKOUT,
      classification,
      defaults: {},
    });
    expect(out.plan).toBeNull();
  });

  test('DEFAULT only from whitelist', () => {
    const { paymentMethod, ...rest } = HEALTHY;
    const classification = classify({ payload: rest, contractDef: CHECKOUT });
    const withDefault = composeDeterministic({
      payload: rest,
      contractDef: CHECKOUT,
      classification,
      defaults: { paymentMethod: 'UPI' },
    });
    expect(withDefault.plan?.ops[0]).toEqual({ op: 'DEFAULT', path: 'paymentMethod', value: 'UPI' });

    const withoutDefault = composeDeterministic({
      payload: rest,
      contractDef: CHECKOUT,
      classification,
      defaults: {},
    });
    expect(withoutDefault.plan).toBeNull();
  });

  test('caps confidence on ambiguous MOVE (forces LLM tier / refusal)', () => {
    const LOGISTICS: ContractDef = {
      fields: {
        awb: { type: 'string', mandatory: true },
        status: { type: 'string', mandatory: true },
      },
    };
    const payload = { awb: 'S', statusDetail: 'x', status_code: 'IN', latest_status: 'IN' };
    const classification = classify({ payload, contractDef: LOGISTICS });
    const out = composeDeterministic({
      payload,
      contractDef: LOGISTICS,
      classification,
      defaults: {},
    });
    expect(out.plan!.confidence).toBeLessThan(0.85);
  });
});

// ─── 3-Gate Refusal Engine ─────────────────────────────────────────────────

describe('gates', () => {
  const gateInput = (payloadOver: Record<string, unknown>, p: HealPlan, history = HISTORY) => ({
    payload: { ...HEALTHY, ...payloadOver },
    plan: p,
    contractDef: CHECKOUT,
    defaults: { paymentMethod: 'UPI' },
    history,
    mandatory: ['orderId', 'amount', 'currency'],
  });

  test('valid plan passes all 3 gates', () => {
    const out = runGates(
      gateInput({ amount: '499' }, plan([{ op: 'COERCE', path: 'amount', cast: 'number' }])),
    );
    expect(out.report.passed).toBe(true);
    expect(out.report.results).toHaveLength(3);
    expect(out.healedPayload!.amount).toBe(499);
  });

  test('Gate 2 · 4.5σ veto blocks 100× Rupees→Paise even inside a plan', () => {
    const out = runGates(
      gateInput(
        { amount: 49900 },
        plan([{ op: 'COERCE', path: 'amount', cast: 'number' }]),
        { amount: [...HISTORY.amount] },
      ),
    );
    expect(out.report.passed).toBe(false);
    const sigma = out.report.results.find((g) => g.gate === 'SIGMA');
    expect(sigma?.passed).toBe(false);
    expect(sigma?.detail).toContain('4.5σ');
  });

  test('Gate 3 · low confidence veto (<85%)', () => {
    const out = runGates(
      gateInput({ amount: '499' }, plan([{ op: 'COERCE', path: 'amount', cast: 'number' }], 0.7)),
    );
    expect(out.report.passed).toBe(false);
    expect(out.report.results.find((g) => g.gate === 'CONFIDENCE')?.passed).toBe(false);
  });

  test('Gate 1 · DEFAULT on mandatory field vetoed (GSTN rule)', () => {
    const out = runGates(
      gateInput({}, plan([{ op: 'DEFAULT', path: 'amount', value: 0 }])),
    );
    expect(out.report.passed).toBe(false);
    expect(out.report.results[0].detail).toContain('hallucination blocked');
  });

  test('Gate 1 · DEFAULT value outside whitelist vetoed', () => {
    const out = runGates(
      gateInput(
        {},
        plan([{ op: 'DEFAULT', path: 'paymentMethod', value: 'CARD' }]),
      ),
    );
    expect(out.report.passed).toBe(false);
    expect(out.report.results[0].detail).toContain('not whitelisted');
  });

  test('Gate 1 · target outside contract vetoed', () => {
    const out = runGates(
      gateInput({}, plan([{ op: 'DEFAULT', path: 'not.in.contract', value: 'x' }])),
    );
    expect(out.report.passed).toBe(false);
  });

  test('standalone sigma gate math', () => {
    const veto = gateSigma({ amount: 49900 }, { amount: HISTORY.amount });
    expect(veto.passed).toBe(false);
    const ok = gateSigma({ amount: 505 }, { amount: HISTORY.amount });
    expect(ok.passed).toBe(true);
  });
});
