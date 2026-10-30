/**
 * API-HEALER · Core type system
 * ------------------------------
 * Zero-RCE Declarative JSON DSL · 3-Gate Refusal Engine · Dual-Loop Firewall
 *
 * Design invariant: a heal plan is PURE DATA (JSON). Nothing in this module
 * (or the whole engine) ever calls eval(), new Function(), or node:vm.
 * Every transformation is interpreted by a closed set of 4 whitelisted ops.
 */

/** The only 4 operations the DSL interpreter will ever execute. */
export type DslOp = 'RENAME' | 'MOVE' | 'COERCE' | 'DEFAULT';

/** Coercion targets — closed union, never a dynamic type expression. */
export type CoerceTo = 'string' | 'number' | 'boolean';

/**
 * A single declarative operation.
 *  RENAME  : { from: 'a.b', to: 'a.c' }              — key rename in same parent
 *  MOVE    : { from: 'x.y', to: 'p.q' }              — relocate value across paths
 *  COERCE  : { path: 'a.b', cast: 'number' }         — primitive type coercion
 *  DEFAULT : { path: 'a.b', value: <json>, mandatory?: false } — fill optional gap
 */
export type DslOperation =
  | { op: 'RENAME'; from: string; to: string }
  | { op: 'MOVE'; from: string; to: string }
  | { op: 'COERCE'; path: string; cast: CoerceTo }
  | { op: 'DEFAULT'; path: string; value: unknown };

/** A heal plan: an ordered, idempotent list of declarative ops. */
export interface HealPlan {
  version: 1;
  ops: DslOperation[];
  /** Composer self-assessed confidence 0..1 (Gate 3 requires >= 0.85) */
  confidence: number;
  rationale: string;
  composer: 'deterministic' | 'llm' | 'cache';
}

/** Deterministic drift classification output (structural diff, ~1ms). */
export type DriftType =
  | 'RENAME'    // key renamed, value identical
  | 'MOVE'      // value relocated to a nested/other path
  | 'TYPE'      // primitive type changed on an existing path
  | 'MISSING'   // expected field absent from payload
  | 'SPIKE'     // numeric value deviates >4.5σ from rolling history
  | 'COMPOUND'  // multiple simultaneous drift classes
  | 'NONE';     // payload satisfies contract

export interface DriftFinding {
  type: Exclude<DriftType, 'NONE' | 'COMPOUND'>;
  /** Contract path that drifted, e.g. "order.amount" */
  path: string;
  /** Extra evidence: observedKey, expectedKey, observedType, expectedType, candidatePath, zScore… */
  meta: Record<string, unknown>;
}

export interface Classification {
  driftType: DriftType;
  findings: DriftFinding[];
  /** Microseconds — determinism budget is 1ms */
  diffMs: number;
}

/** Gate verdicts (3-Layer Refusal & 4.5-Sigma Gate). */
export interface GateResult {
  gate: 'POLICY' | 'SIGMA' | 'CONFIDENCE';
  passed: boolean;
  detail: string;
  ms: number;
}

export interface GatesReport {
  passed: boolean;
  results: GateResult[];
  totalMs: number;
}

/** Canary (Loop-2 cold path) strict re-validation log. */
export interface CanaryLogEntry {
  check: string;
  passed: boolean;
  detail: string;
}

/** Full hot-path timing waterfall. */
export interface HealTiming {
  classifyMs: number;
  composeMs: number;
  gatesMs: number;
  totalMs: number;
}

export type HealStatus =
  | 'PASSTHROUGH'   // payload valid — served untouched
  | 'HEALED_COLD'   // novel drift healed via composer in <650ms
  | 'HEALED_CACHED' // fingerprint hit — 0.8ms re-heal, zero LLM
  | 'REFUSED'       // a refusal gate blocked the plan
  | 'ROLLED_BACK'   // 4.5σ anomaly detected → deterministic fail-safe
  | 'ERROR'         // engine-level fault (contract missing/corrupt)
  // ── Track A · dual-mode interception (loud HTTP failures) ──
  | 'FALLBACK_STALE'    // 429/5xx overload → cached last-known-good read served
  | 'DEGRADED'          // overload on a mutation → NO retry, degraded envelope
  | 'OUTBOUND_ADAPTED'  // 400/422 → request body adapted via DSL + one retry
  | 'AUTH_REFRESHED'    // 401/403 expired token → refreshed + retried once
  | 'ENDPOINT_REMAPPED' // 404/410 moved route → remapped to fallback endpoint
  | 'METHOD_CORRECTED'  // 405 method mismatch → retried with safe allowed method
  | 'CONFLICT_RESOLVED' // 409 conflict → resolved via conflictResolver/idempotency retry
  | 'RETRIED_TRANSIENT'; // transient 5xx/network/timeout/429 → recovered via bounded backoff retry

/** The result envelope returned by the engine for one intercepted payload. */
export interface HealResult {
  status: HealStatus;
  contractId: string;
  contractName: string;
  endpoint: string;
  servedPayload: Record<string, unknown> | null;
  rawPayload: Record<string, unknown>;
  plan: HealPlan | null;
  classification: Classification | null;
  gates: GatesReport | null;
  signature: string;
  timing: HealTiming;
  composer: HealPlan['composer'] | 'none';
  confidence: number;
  canaryPassed: boolean | null;
  /** Consumer callsite (file:line) captured by the SDK client, when provided */
  callsite?: string | null;
  /** Populated when a cold heal is queued for the Loop-2 async workers */
  jobsQueued: string[];
  message: string;
  eventId?: string;
}

/** JSON contract definition stored on Contract.schemaJson */
export interface FieldDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'unknown';
  mandatory?: boolean;
  /** Nested object fields (one level of nesting is modelled explicitly) */
  fields?: Record<string, FieldDef>;
  /** Unit hint used by the sigma gate for human-readable refusal reasons */
  unit?: string;
}

export interface ContractDef {
  fields: Record<string, FieldDef>;
}

/** Rolling numeric statistics maintained per numeric leaf path. */
export interface FieldHistory {
  values: number[];
}

export interface HistoryMap {
  [path: string]: number[];
}

export const SIGMA_THRESHOLD = 4.5;
/**
 * Cold-start quarantine ratio: with only 1-2 baseline samples a z-score is
 * not computable, so any magnitude jump beyond ±10× against the first
 * baseline value is treated as the classic unit-bug signature (499 ↔ 49900)
 * and vetoed BEFORE it can poison the rolling history.
 */
export const COLD_START_RATIO = 10;
export const MIN_CONFIDENCE = 0.85;
export const TTL_HOURS = 24;
/** Cold heal budget per the project mission (<650ms end-to-end) */
export const COLD_HEAL_BUDGET_MS = 650;
/** Healthy-call overhead budget for the zero-copy fast path (spec §1). */
export const PASSTHROUGH_BUDGET_MS = 0.3;
/** Statistical veto wall-time budget (spec: 100× paise bug rejected <2ms). */
export const VETO_BUDGET_MS = 2;
/** Hard cap on outbound (request-side) adaptation ops — conservative. */
export const MAX_OUTBOUND_OPS = 8;
