/**
 * API-HEALER · Declarative JSON DSL Engine (Loop 1 · step 3)
 * ----------------------------------------------------------
 * THE ZERO-RCE MOAT. Plans are pure data; this interpreter is the only
 * executor and it implements exactly 4 whitelisted operations:
 *
 *   RENAME  — rename a key within the same parent object
 *   MOVE    — relocate a value from one path to another
 *   COERCE  — strictly coerce a leaf's primitive type
 *   DEFAULT — insert a whitelisted safe default into an optional gap
 *
 * There is no eval(), no Function constructor, no node:vm, no prototype
 * pollution surface: op arguments are validated, `__proto__`/`constructor`
 * path segments are hard-rejected, and unknown ops throw before mutating.
 */
import type { DslOperation, HealPlan } from './types';
import { readPath, setPath, deletePath, coerceValue } from './contract';

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Validate a dotted path — blocks prototype pollution and empty segments. */
export function assertSafePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('DSL safety: path must be a non-empty string');
  }
  for (const seg of path.split('.')) {
    if (seg.length === 0) throw new Error(`DSL safety: empty segment in "${path}"`);
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      throw new Error(`DSL safety: forbidden segment "${seg}" in "${path}"`);
    }
  }
  if (path.length > 256) throw new Error('DSL safety: path exceeds 256 chars');
}

export interface ApplyReport {
  opsApplied: number;
  opsFailed: { op: DslOperation; error: string }[];
  result: Record<string, unknown>;
  ms: number;
}

/**
 * Execute a heal plan against a payload. Idempotent, order-sensitive,
 * fail-soft per op (failures collected — Gate 1 treats any failure as veto).
 */
export function applyPlan(
  payload: Record<string, unknown>,
  plan: HealPlan,
): ApplyReport {
  const t0 = performance.now();
  let result: Record<string, unknown> = structuredClone(payload);
  const opsFailed: { op: DslOperation; error: string }[] = [];
  let opsApplied = 0;

  for (const op of plan.ops) {
    try {
      switch (op.op) {
        case 'RENAME': {
          assertSafePath(op.from);
          assertSafePath(op.to);
          const fromParent = op.from.split('.').slice(0, -1).join('.');
          const toParent = op.to.split('.').slice(0, -1).join('.');
          if (fromParent !== toParent) {
            throw new Error('RENAME must stay within the same parent object');
          }
          const value = readPath(result, op.from);
          if (value === undefined) {
            throw new Error(`source "${op.from}" not found`);
          }
          if (readPath(result, op.to) !== undefined) {
            throw new Error(`target "${op.to}" already exists`);
          }
          result = setPath(result, op.to, value);
          deletePath(result, op.from);
          opsApplied++;
          break;
        }
        case 'MOVE': {
          assertSafePath(op.from);
          assertSafePath(op.to);
          if (op.from === op.to) throw new Error('MOVE source and target are identical');
          const value = readPath(result, op.from);
          if (value === undefined) {
            throw new Error(`source "${op.from}" not found`);
          }
          if (readPath(result, op.to) !== undefined) {
            throw new Error(`target "${op.to}" already exists`);
          }
          result = setPath(result, op.to, value);
          deletePath(result, op.from);
          opsApplied++;
          break;
        }
        case 'COERCE': {
          assertSafePath(op.path);
          const value = readPath(result, op.path);
          if (value === undefined) throw new Error(`path "${op.path}" not found`);
          const cast = coerceValue(value, op.cast);
          if (cast === undefined) {
            throw new Error(
              `cannot strictly coerce ${JSON.stringify(value)} to ${op.cast}`,
            );
          }
          result = setPath(result, op.path, cast);
          opsApplied++;
          break;
        }
        case 'DEFAULT': {
          assertSafePath(op.path);
          if (readPath(result, op.path) !== undefined) {
            // DEFAULT is a no-op when the field is present (idempotence)
            opsApplied++;
            break;
          }
          // value must be JSON-serializable primitive/null — never a function
          const t = typeof op.value;
          if (!(t === 'string' || t === 'number' || t === 'boolean' || op.value === null)) {
            throw new Error('DEFAULT value must be a JSON primitive or null');
          }
          result = setPath(result, op.path, op.value);
          opsApplied++;
          break;
        }
        default: {
          // Compile-time exhaustiveness guard — unknown ops can never run.
          const impossible: never = op;
          throw new Error(`DSL: unknown operation ${JSON.stringify(impossible)}`);
        }
      }
    } catch (err) {
      opsFailed.push({ op, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    opsApplied,
    opsFailed,
    result,
    ms: Math.round((performance.now() - t0) * 1000) / 1000,
  };
}

/** Human-readable summary of a plan, e.g. "RENAME a→b; COERCE x:number" */
export function summarizePlan(plan: HealPlan): string {
  return plan.ops
    .map((op) => {
      switch (op.op) {
        case 'RENAME':
          return `RENAME ${op.from}→${op.to}`;
        case 'MOVE':
          return `MOVE ${op.from}→${op.to}`;
        case 'COERCE':
          return `COERCE ${op.path}:${op.cast}`;
        case 'DEFAULT':
          return `DEFAULT ${op.path}=${JSON.stringify(op.value)}`;
      }
    })
    .join('; ');
}
