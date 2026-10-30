/**
 * API-HEALER · Telemetry aggregation (Core Telemetry & Performance Targets)
 * ---------------------------------------------------------------------------
 * MTTD  — mean classify time (<1ms target)
 * MTTM  — mean time-to-mitigation across healed traffic (<650ms target)
 * MTTI  — mean cached re-heal time (0.8ms target, zero LLM)
 * Repair rate — healed / (healed + refused + rolled back)
 */
import { db } from '@/lib/db';
import { listBreakers } from './breaker';
import { planFlightStats } from './engine';
import { runtimeCounters, type RuntimeCounterSnapshot } from './counters';

export interface HealerMetrics {
  totals: {
    events: number;
    passthrough: number;
    healedCold: number;
    healedCached: number;
    refused: number;
    rolledBack: number;
    errors: number;
    /** Track A · dual-mode interception interventions (persisted) */
    fallbackStale: number;
    degraded: number;
    outboundAdapted: number;
    authRefreshed?: number;
    endpointRemapped?: number;
    methodCorrected?: number;
    conflictResolved?: number;
    retriedTransient?: number;
  };
  repairRatePct: number;
  mttdMs: number;
  mtmMs: number;
  mttiMs: number;
  cacheHitRatePct: number;
  avgGatesMs: number;
  llmComposed: number;
  fingerprints: { active: number; expired: number; totalHits: number };
  prs: { open: number; github: number; dryRun: number };
  jobs: Record<string, number>;
  canaryPassed: number;
  canaryFailed: number;
  /** Step 9 · per-contract circuit-breaker posture */
  breakers: {
    open: number;
    halfOpen: number;
    closed: number;
    list: { contractId: string; state: string; failures: number; reason: string | null; cooldownRemainingMs: number }[];
  };
  /** Single-flight plan synthesis: concurrent-break dedup (thundering-herd guard) */
  singleFlight: {
    /** syntheses currently in flight */
    active: number;
    /** leader composePlan() executions since boot */
    leadersTotal: number;
    /** callers that inherited an in-flight synthesis instead of duplicating it */
    inheritedTotal: number;
  };
  /**
   * Process-local counters since boot. Healthy passthroughs leave NO DB
   * trace by design (spec: no SQLite writes on healthy calls) — these
   * counters keep the dashboard honest about live traffic volume.
   */
  runtime: RuntimeCounterSnapshot;
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function computeMetrics(): Promise<HealerMetrics> {
  const [
    totalEvents,
    passthrough,
    healedCold,
    healedCached,
    refused,
    rolledBack,
    errors,
    fallbackStale,
    degraded,
    outboundAdapted,
    authRefreshed,
    endpointRemapped,
    methodCorrected,
    conflictResolved,
    retriedTransient,
    healedAgg,
    cachedAgg,
    classifyAgg,
    gatesAgg,
    llmCount,
    fpActive,
    fpExpired,
    fpHits,
    prOpen,
    prGithub,
    prDryRun,
    canaryPassed,
    canaryFailed,
    jobsGrouped,
  ] = await Promise.all([
    db.driftEvent.count(),
    db.driftEvent.count({ where: { status: 'PASSTHROUGH' } }),
    db.driftEvent.count({ where: { status: 'HEALED_COLD' } }),
    db.driftEvent.count({ where: { status: 'HEALED_CACHED' } }),
    db.driftEvent.count({ where: { status: 'REFUSED' } }),
    db.driftEvent.count({ where: { status: 'ROLLED_BACK' } }),
    db.driftEvent.count({ where: { status: 'ERROR' } }),
    db.driftEvent.count({ where: { status: 'FALLBACK_STALE' } }),
    db.driftEvent.count({ where: { status: 'DEGRADED' } }),
    db.driftEvent.count({ where: { status: 'OUTBOUND_ADAPTED' } }),
    db.driftEvent.count({ where: { status: 'AUTH_REFRESHED' } }),
    db.driftEvent.count({ where: { status: 'ENDPOINT_REMAPPED' } }),
    db.driftEvent.count({ where: { status: 'METHOD_CORRECTED' } }),
    db.driftEvent.count({ where: { status: 'CONFLICT_RESOLVED' } }),
    db.driftEvent.count({ where: { status: 'RETRIED_TRANSIENT' } }),
    db.driftEvent.aggregate({ where: { status: 'HEALED_COLD' }, _avg: { totalMs: true }, _count: { _all: true } }),
    db.driftEvent.aggregate({ where: { status: 'HEALED_CACHED' }, _avg: { totalMs: true }, _count: { _all: true } }),
    db.driftEvent.aggregate({ _avg: { classifyMs: true } }),
    db.driftEvent.aggregate({ where: { status: { in: ['HEALED_COLD', 'HEALED_CACHED'] } }, _avg: { gatesMs: true } }),
    db.driftEvent.count({ where: { composer: 'llm' } }),
    db.fingerprint.count({ where: { status: 'ACTIVE' } }),
    db.fingerprint.count({ where: { status: 'EXPIRED' } }),
    db.fingerprint.aggregate({ _sum: { hits: true } }),
    db.pullRequest.count({ where: { status: 'OPEN' } }),
    db.pullRequest.count({ where: { mode: 'GITHUB' } }),
    db.pullRequest.count({ where: { mode: 'DRY_RUN' } }),
    db.driftEvent.count({ where: { canaryPassed: true } }),
    db.driftEvent.count({ where: { canaryPassed: false } }),
    db.jobRun.groupBy({ by: ['status'], _count: { status: true } }),
  ]);

  const healed = healedCold + healedCached;
  const interventions = healed + refused + rolledBack;
  const repairRate = interventions > 0 ? (healed / interventions) * 100 : 100;

  return {
    totals: {
      events: totalEvents,
      passthrough,
      healedCold,
      healedCached,
      refused,
      rolledBack,
      errors,
      fallbackStale,
      degraded,
      outboundAdapted,
      authRefreshed,
      endpointRemapped,
      methodCorrected,
      conflictResolved,
      retriedTransient,
    },
    repairRatePct: round(repairRate),
    mttdMs: round(classifyAgg._avg.classifyMs ?? 0),
    mtmMs: round(healedAgg._avg.totalMs ?? 0),
    mttiMs: round(cachedAgg._avg.totalMs ?? 0),
    cacheHitRatePct: round(healed > 0 ? (healedCached / healed) * 100 : 0),
    avgGatesMs: round(gatesAgg._avg.gatesMs ?? 0),
    llmComposed: llmCount,
    fingerprints: { active: fpActive, expired: fpExpired, totalHits: fpHits._sum.hits ?? 0 },
    prs: { open: prOpen, github: prGithub, dryRun: prDryRun },
    jobs: Object.fromEntries(jobsGrouped.map((g) => [g.status, g._count.status])),
    canaryPassed,
    canaryFailed,
    breakers: (() => {
      const snaps = listBreakers();
      return {
        open: snaps.filter((b) => b.state === 'OPEN').length,
        halfOpen: snaps.filter((b) => b.state === 'HALF_OPEN').length,
        closed: snaps.filter((b) => b.state === 'CLOSED').length,
        list: snaps.map((b) => ({
          contractId: b.contractId,
          state: b.state,
          failures: b.failures,
          reason: b.reason,
          cooldownRemainingMs: b.cooldownRemainingMs,
        })),
      };
    })(),
    singleFlight: planFlightStats(),
    runtime: runtimeCounters(),
  };
}
