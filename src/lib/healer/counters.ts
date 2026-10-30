/**
 * API-HEALER · Runtime counters (process-local, zero-dependency)
 * ----------------------------------------------------------------
 * Spec invariant: "Do NOT clone, buffer, or write to SQLite on healthy
 * calls." Healthy passthroughs therefore leave NO DB trace — these
 * in-memory counters keep the dashboard honest about live traffic volume
 * (passthroughs since boot) and Track-A / HTTP resilience interventions
 * without paying a DB write on the hot path.
 */

export type RuntimeCounterKey =
  | 'passthrough'
  | 'fallbackStale'
  | 'degraded'
  | 'outboundAdapted'
  | 'authRefreshed'
  | 'endpointRemapped'
  | 'methodCorrected'
  | 'conflictResolved'
  | 'retriedTransient';

interface CounterStore {
  counts: Map<RuntimeCounterKey, number>;
  sinceBoot: number;
}

const globalForCounters = globalThis as unknown as {
  __apiHealerCounters?: CounterStore;
};

function store(): CounterStore {
  if (!globalForCounters.__apiHealerCounters) {
    globalForCounters.__apiHealerCounters = {
      counts: new Map(),
      sinceBoot: Date.now(),
    };
  }
  return globalForCounters.__apiHealerCounters;
}

export function bumpRuntimeCounter(key: RuntimeCounterKey, n = 1): void {
  const s = store();
  s.counts.set(key, (s.counts.get(key) ?? 0) + n);
}

export interface RuntimeCounterSnapshot {
  passthrough: number;
  fallbackStale: number;
  degraded: number;
  outboundAdapted: number;
  authRefreshed: number;
  endpointRemapped: number;
  methodCorrected: number;
  conflictResolved: number;
  retriedTransient: number;
  sinceBoot: number;
}

export function runtimeCounters(): RuntimeCounterSnapshot {
  const s = store();
  return {
    passthrough: s.counts.get('passthrough') ?? 0,
    fallbackStale: s.counts.get('fallbackStale') ?? 0,
    degraded: s.counts.get('degraded') ?? 0,
    outboundAdapted: s.counts.get('outboundAdapted') ?? 0,
    authRefreshed: s.counts.get('authRefreshed') ?? 0,
    endpointRemapped: s.counts.get('endpointRemapped') ?? 0,
    methodCorrected: s.counts.get('methodCorrected') ?? 0,
    conflictResolved: s.counts.get('conflictResolved') ?? 0,
    retriedTransient: s.counts.get('retriedTransient') ?? 0,
    sinceBoot: s.sinceBoot,
  };
}

/** Operator/test reset. */
export function resetRuntimeCounters(): void {
  const s = store();
  s.counts.clear();
  s.sinceBoot = Date.now();
}
