/**
 * API-HEALER · Automatic Circuit Breaker (Step 9 · the eject button)
 * -------------------------------------------------------------------
 * Per-contract state machine that strips the runtime adapter when the
 * fast loop itself keeps failing — repeated gate vetoes, canary failures,
 * or engine faults trip it:
 *
 *   CLOSED     → normal operation, all heals flow
 *   OPEN       → adapter stripped: heal attempts short-circuit to the
 *                deterministic fail-safe (last-known-good / refusal);
 *                cooldown doubles per consecutive trip (60s → 10min cap)
 *   HALF_OPEN  → cooldown elapsed; ONE trial heal is allowed through.
 *                Success ⇒ CLOSED, failure ⇒ OPEN again.
 *
 * Purely in-memory (global-singleton, like the hot tier) — breaker state is
 * runtime posture, not durable business data. Reset on process boot by design.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerSnapshot {
  contractId: string;
  state: BreakerState;
  /** consecutive failures inside the current window */
  failures: number;
  /** why the breaker last tripped (human-readable) */
  reason: string | null;
  /** ms remaining until the OPEN breaker allows a HALF_OPEN trial */
  cooldownRemainingMs: number;
  openedAt: number | null;
  updatedAt: number;
}

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  windowStart: number;
  lastFailureAt: number;
  reason: string | null;
  openedAt: number | null;
  cooldownMs: number;
  updatedAt: number;
}

const FAILURE_WINDOW_MS = 60_000; // consecutive-failure window
const FAILURE_THRESHOLD = 3;      // vetoes/canary-fails inside window ⇒ OPEN
const BASE_COOLDOWN_MS = 60_000;  // first OPEN cooldown
const MAX_COOLDOWN_MS = 600_000;  // escalation cap (10min)

const globalForBreaker = globalThis as unknown as {
  __apiHealerBreakers?: Map<string, BreakerEntry>;
};
const breakers: Map<string, BreakerEntry> =
  globalForBreaker.__apiHealerBreakers ?? (globalForBreaker.__apiHealerBreakers = new Map());

function entry(contractId: string): BreakerEntry {
  let e = breakers.get(contractId);
  if (!e) {
    e = {
      state: 'CLOSED',
      failures: 0,
      windowStart: 0,
      lastFailureAt: 0,
      reason: null,
      openedAt: null,
      cooldownMs: BASE_COOLDOWN_MS,
      updatedAt: Date.now(),
    };
    breakers.set(contractId, e);
  }
  return e;
}

/**
 * Read the breaker posture for a contract. Transitions an elapsed OPEN
 * breaker to HALF_OPEN (single trial allowed).
 */
export function checkBreaker(contractId: string): BreakerSnapshot {
  const e = entry(contractId);
  const now = Date.now();

  if (e.state === 'OPEN' && e.openedAt !== null && now - e.openedAt >= e.cooldownMs) {
    e.state = 'HALF_OPEN'; // one trial heal permitted
    e.updatedAt = now;
  }

  return {
    contractId,
    state: e.state,
    failures: e.failures,
    reason: e.reason,
    cooldownRemainingMs:
      e.state === 'OPEN' && e.openedAt !== null
        ? Math.max(0, e.cooldownMs - (now - e.openedAt))
        : 0,
    openedAt: e.openedAt,
    updatedAt: e.updatedAt,
  };
}

/** True when the breaker blocks the heal fast path right now. */
export function isBreakerOpen(contractId: string): boolean {
  return checkBreaker(contractId).state === 'OPEN';
}

/**
 * Record a fast-loop failure (gate veto / refusal / canary fail / fault /
 * upstream overload reported by Track A). `cooldownHintMs` (e.g. a 429's
 * Retry-After) raises — never shortens — the OPEN cooldown.
 */
export function recordFailure(
  contractId: string,
  reason: string,
  cooldownHintMs?: number,
): BreakerSnapshot {
  const e = entry(contractId);
  const now = Date.now();

  // failures outside the window start a fresh streak
  if (now - (e.windowStart || now) > FAILURE_WINDOW_MS) {
    e.windowStart = now;
    e.failures = 0;
  }
  e.failures += 1;
  e.lastFailureAt = now;
  e.reason = reason.slice(0, 300);
  e.updatedAt = now;

  // upstream-suggested cooldown (Retry-After): respected as a lower bound
  const hint =
    cooldownHintMs !== undefined && Number.isFinite(cooldownHintMs)
      ? Math.min(MAX_COOLDOWN_MS, Math.max(BASE_COOLDOWN_MS, cooldownHintMs))
      : null;

  if (e.state === 'HALF_OPEN') {
    // trial failed — re-open with escalated cooldown
    e.state = 'OPEN';
    e.openedAt = now;
    e.cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.max(e.cooldownMs * 2, hint ?? 0));
  } else if (e.state === 'CLOSED' && e.failures >= FAILURE_THRESHOLD) {
    e.state = 'OPEN';
    e.openedAt = now;
    e.cooldownMs = Math.max(BASE_COOLDOWN_MS, hint ?? 0);
  }
  return checkBreaker(contractId);
}

/** Record a healthy outcome — closes the breaker and clears the streak. */
export function recordSuccess(contractId: string): BreakerSnapshot {
  const e = entry(contractId);
  e.state = 'CLOSED';
  e.failures = 0;
  e.windowStart = 0;
  e.reason = null;
  e.openedAt = null;
  e.cooldownMs = BASE_COOLDOWN_MS;
  e.updatedAt = Date.now();
  return checkBreaker(contractId);
}

/** All breaker snapshots (metrics + dashboard). */
export function listBreakers(): BreakerSnapshot[] {
  const ids = new Set(breakers.keys());
  return [...ids].map((id) => checkBreaker(id));
}

/** Operator/test reset. */
export function resetBreakers(): void {
  breakers.clear();
}
