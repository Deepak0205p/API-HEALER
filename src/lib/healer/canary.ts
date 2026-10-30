/**
 * API-HEALER · Zod Canary Verification (Loop 2 · cold path, step 1)
 * ------------------------------------------------------------------
 * Full canary suite executed by the async canary worker before a healed
 * transformation is eligible for a GitHub PR. Every transformation is
 * backed by a transparent, reproducible canary log.
 */
import type { ContractDef, CanaryLogEntry, HealPlan } from './types';
import { buildZodSchema, numericLeaves, readPath } from './contract';
import { applyPlan } from './dsl';
import { sigmaViolation } from './classifier';

export interface CanaryResult {
  passed: boolean;
  log: CanaryLogEntry[];
  ms: number;
}

export function runCanary(params: {
  rawPayload: Record<string, unknown>;
  healedPayload: Record<string, unknown>;
  plan: HealPlan;
  contractDef: ContractDef;
  mandatory: string[];
  history?: Record<string, number[]>;
}): CanaryResult {
  const t0 = Date.now();
  const log: CanaryLogEntry[] = [];
  const { rawPayload, healedPayload, plan, contractDef, mandatory, history = {} } = params;

  // 1. Strict schema assertion
  try {
    const schema = buildZodSchema(contractDef);
    const parsed = schema.safeParse(healedPayload);
    log.push({
      check: 'strict-schema',
      passed: parsed.success,
      detail: parsed.success
        ? 'healed payload satisfies the full contract'
        : `failure: ${parsed.error.issues[0]?.path?.join('.') ?? '?'} — ${parsed.error.issues[0]?.message ?? ''}`,
    });
  } catch (e) {
    log.push({ check: 'strict-schema', passed: false, detail: (e as Error).message });
  }

  // 2. Mandatory completeness
  const missingMandatory = mandatory.filter((p) => {
    const v = readPath(healedPayload, p);
    return v === undefined || v === null || v === '';
  });
  log.push({
    check: 'mandatory-completeness',
    passed: missingMandatory.length === 0,
    detail:
      missingMandatory.length === 0
        ? `all ${mandatory.length} mandatory fields present`
        : `missing: ${missingMandatory.join(', ')}`,
  });

  // 3. Numeric sanity (sigma + cold-start ratio quarantine on healed values)
  let numericFail: string | null = null;
  for (const { path, value } of numericLeaves(healedPayload)) {
    const violation = sigmaViolation(value, history[path] ?? []);
    if (violation) {
      numericFail = `${path} — ${violation.detail}`;
      break;
    }
  }
  log.push({
    check: 'numeric-sigma',
    passed: numericFail === null,
    detail: numericFail ?? 'healed numerics within 4.5σ / cold-start ratio bounds',
  });

  // 4. Idempotence — re-applying the plan to the healed payload is a no-op
  const twice = applyPlan(applyPlan(rawPayload, plan).result, plan);
  const once = applyPlan(rawPayload, plan);
  const idempotent = JSON.stringify(twice.result) === JSON.stringify(once.result);
  log.push({
    check: 'idempotence',
    passed: idempotent && once.opsFailed.length === 0,
    detail: idempotent
      ? 'plan is idempotent (apply twice == apply once)'
      : 'plan is NOT idempotent — promotion blocked',
  });

  // 5. Transformation evidence — the plan actually changed the payload
  const changed = JSON.stringify(rawPayload) !== JSON.stringify(healedPayload);
  log.push({
    check: 'transformation-evidence',
    passed: changed,
    detail: changed
      ? `${plan.ops.length} op(s) produced a distinct healed payload`
      : 'plan produced no change — nothing to promote',
  });

  const passed = log.every((l) => l.passed);
  return { passed, log, ms: Date.now() - t0 };
}
