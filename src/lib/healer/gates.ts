/**
 * API-HEALER · 3-Gate Refusal Engine (Loop 1 · step 4)
 * -----------------------------------------------------
 * Every plan — deterministic OR LLM-composed — must survive all three gates
 * before the DSL interpreter's output is promoted to a hot patch:
 *
 *   GATE 1 · POLICY      — structural legality of every op (whitelist,
 *                          prototype-pollution-proof paths, source/target
 *                          sanity, DEFAULT whitelist, dry-run application)
 *   GATE 2 · SIGMA 4.5σ  — statistical veto: every numeric leaf of the HEALED
 *                          payload is checked against rolling history; any
 *                          |z| > 4.5 (100× unit bug) ⇒ veto + rollback
 *   GATE 3 · CONFIDENCE  — composer confidence ≥ 0.85, mandatory-field
 *                          completeness (no hallucinated business data), and a
 *                          strict Zod canary of the healed payload.
 *
 * Knows when NOT to patch: any veto ⇒ deterministic fail-safe (2ms rollback
 * to last-known-good) decided by the engine orchestrator.
 */
import { performance } from 'perf_hooks';
import type {
  ContractDef,
  GatesReport,
  GateResult,
  HealPlan,
  HistoryMap,
} from './types';
import { MIN_CONFIDENCE, SIGMA_THRESHOLD } from './types';
import {
  applyPlan,
  assertSafePath,
  type ApplyReport,
} from './dsl';
import {
  buildZodSchema,
  flattenLeaves,
  numericLeaves,
  readPath,
} from './contract';
import { sigmaViolation } from './classifier';

export interface GateInput {
  payload: Record<string, unknown>;
  plan: HealPlan;
  contractDef: ContractDef;
  /** Whitelisted safe defaults for the DEFAULT op */
  defaults: Record<string, unknown>;
  /** Rolling numeric history keyed by contract path */
  history: HistoryMap;
  /** Mandatory contract paths */
  mandatory: string[];
}

const MAX_OPS = 16;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: Math.round((performance.now() - t0) * 1000) / 1000 };
}

// ─── Gate 1 · Policy ───────────────────────────────────────────────────────

export function gatePolicy(input: GateInput, precomputed?: ApplyReport): GateResult {
  const { value, ms } = timed(() => {
    const { plan, contractDef, payload, defaults, mandatory } = input;

    if (plan.ops.length === 0) {
      return 'VETO: empty plan — nothing to heal with';
    }
    if (plan.ops.length > MAX_OPS) {
      return `VETO: plan exceeds ${MAX_OPS} op safety cap`;
    }

    const contractPaths = new Set(flattenLeaves(contractDef.fields).map((l) => l.path));
    const mandatorySet = new Set(mandatory);

    for (const op of plan.ops) {
      // 1a) path safety (prototype pollution hard-reject)
      try {
        if ('from' in op) assertSafePath(op.from);
        if ('to' in op) assertSafePath(op.to);
        if ('path' in op) assertSafePath(op.path);
      } catch (e) {
        return `VETO: ${(e as Error).message}`;
      }

      // 1b) every plan TARGET must be a real contract path
      const target = 'to' in op ? op.to : 'path' in op ? op.path : '';
      if (target && !contractPaths.has(target)) {
        return `VETO: target "${target}" is not declared in the contract`;
      }

      // 1c) DEFAULT: only optional paths, only exact whitelisted values
      if (op.op === 'DEFAULT') {
        if (mandatorySet.has(op.path)) {
          return `VETO: DEFAULT targets mandatory field "${op.path}" — hallucination blocked`;
        }
        if (!(op.path in defaults) || defaults[op.path] !== op.value) {
          return `VETO: DEFAULT value for "${op.path}" is not whitelisted in contract safe-defaults`;
        }
      }

      // 1d) RENAME must stay within its parent (semantic sanity)
      if (op.op === 'RENAME') {
        const fromParent = op.from.split('.').slice(0, -1).join('.');
        const toParent = op.to.split('.').slice(0, -1).join('.');
        if (fromParent !== toParent) {
          return `VETO: RENAME ${op.from}→${op.to} crosses parent boundaries (use MOVE)`;
        }
      }
    }

    // 1e) dry-run application — any interpreter failure vetoes the plan.
    // The pipeline pre-computes this apply (gates 2/3 need the healed
    // payload anyway) and passes it in — one structuredClone, not two.
    const report = precomputed ?? applyPlan(payload, plan);
    if (report.opsFailed.length > 0) {
      return `VETO: ${report.opsFailed.length} op(s) failed: ${report.opsFailed[0].error}`;
    }
    return null;
  });
  return { gate: 'POLICY', passed: value === null, detail: value ?? 'all ops legal, dry-run applied cleanly', ms };
}

// ─── Gate 2 · 4.5σ Sigma (+ cold-start ratio quarantine) ──────────────────

export function gateSigma(
  healedPayload: Record<string, unknown>,
  history: HistoryMap,
  units?: Map<string, string>,
): GateResult {
  const { value, ms } = timed(() => {
    const numeric = numericLeaves(healedPayload);
    const worst: { path: string; kind: 'sigma' | 'cold-start'; detail: string }[] = [];
    for (const { path, value: v } of numeric) {
      const violation = sigmaViolation(v, history[path] ?? []);
      if (violation) worst.push({ path, kind: violation.kind, detail: violation.detail });
    }
    if (worst.length > 0) {
      // statistical violations report first (strongest evidence), then cold-start
      const w = worst.sort((a, b) =>
        a.kind === b.kind ? 0 : a.kind === 'sigma' ? -1 : 1,
      )[0];
      const unit = units?.get(w.path) ? ` [${units.get(w.path)}]` : '';
      const tail = w.kind === 'sigma' ? ' — 100× unit-bug protection engaged' : '';
      return `VETO: "${w.path}" ${w.detail}${unit}${tail}`;
    }
    return null;
  });
  return {
    gate: 'SIGMA',
    passed: value === null,
    detail: value ?? 'all numeric leaves within 4.5σ / cold-start ratio bounds',
    ms,
  };
}

// ─── Gate 3 · Confidence & Completeness (canary pre-promotion) ─────────────

export function gateConfidence(
  healedPayload: Record<string, unknown>,
  plan: HealPlan,
  contractDef: ContractDef,
  mandatory: string[],
): GateResult {
  const { value, ms } = timed(() => {
    if (plan.confidence < MIN_CONFIDENCE) {
      return `VETO: composer confidence ${(plan.confidence * 100).toFixed(1)}% < ${(MIN_CONFIDENCE * 100).toFixed(0)}% threshold`;
    }
    // Mandatory completeness — no hallucinated values for required fields
    for (const path of mandatory) {
      const v = readPath(healedPayload, path);
      if (v === undefined || v === null || v === '') {
        return `VETO: mandatory field "${path}" missing/empty after heal — hallucinated data refused`;
      }
    }
    // Strict Zod canary — validate before promotion
    try {
      const schema = buildZodSchema(contractDef);
      const parsed = schema.safeParse(healedPayload);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return `VETO: canary assertion failed at "${first?.path?.join('.') ?? '?'}": ${first?.message ?? 'schema mismatch'}`;
      }
    } catch (e) {
      return `VETO: canary construction error: ${(e as Error).message}`;
    }
    return null;
  });
  return { gate: 'CONFIDENCE', passed: value === null, detail: value ?? `confidence ${(plan.confidence * 100).toFixed(1)}% ≥ ${(MIN_CONFIDENCE * 100).toFixed(0)}%, mandatory complete, canary passed`, ms };
}

// ─── Pipeline ──────────────────────────────────────────────────────────────

export interface GatesOutcome {
  report: GatesReport;
  healedPayload: Record<string, unknown> | null;
}

/**
 * Run all 3 gates in order. Short-circuits on first veto.
 * Returns the healed payload when everything passes.
 */
export function runGates(input: GateInput): GatesOutcome {
  const t0 = performance.now();
  const results: GateResult[] = [];

  // Pre-compute the healed payload via dry-run for gates 2 & 3
  const apply = applyPlan(input.payload, input.plan);
  const healed = apply.result;
  const units = new Map<string, string>();
  for (const leaf of flattenLeaves(input.contractDef.fields)) {
    if (leaf.def.unit) units.set(leaf.path, leaf.def.unit);
  }

  const g1 = gatePolicy(input, apply);
  results.push(g1);
  if (!g1.passed) {
    return {
      report: { passed: false, results, totalMs: Math.round((performance.now() - t0) * 1000) / 1000 },
      healedPayload: null,
    };
  }

  const g2 = gateSigma(healed, input.history, units);
  results.push(g2);
  if (!g2.passed) {
    return {
      report: { passed: false, results, totalMs: Math.round((performance.now() - t0) * 1000) / 1000 },
      healedPayload: null,
    };
  }

  const g3 = gateConfidence(healed, input.plan, input.contractDef, input.mandatory);
  results.push(g3);
  const passed = g3.passed;

  return {
    report: {
      passed,
      results,
      totalMs: Math.round((performance.now() - t0) * 1000) / 1000,
    },
    healedPayload: passed ? healed : null,
  };
}
