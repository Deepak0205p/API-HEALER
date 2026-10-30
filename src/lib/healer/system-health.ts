/**
 * Pure telemetry computation for the System Health dashboard component.
 * Derives live status, latency sparklines, success rates, and queue depth
 * for all four background worker types (CANARY, PR_GENERATION, TTL_SWEEP, METRICS).
 */

export const CORE_WORKER_TYPES = [
  'CANARY',
  'PR_GENERATION',
  'TTL_SWEEP',
  'METRICS',
] as const;

export type CoreWorkerType = (typeof CORE_WORKER_TYPES)[number];

export type WorkerHealthState = 'RUNNING' | 'HEALTHY' | 'DEGRADED' | 'STANDBY';

export interface JobRunInput {
  id: string;
  type: string;
  status: string;
  ms: number | null;
  attempts: number;
  error: string | null;
  createdAt: string;
}

export interface QueueStatsInput {
  byStatus?: Record<string, number>;
  byType?: { type: string; status: string; count: number }[];
}

export interface WorkerHealthSummary {
  type: CoreWorkerType;
  title: string;
  role: string;
  cadence: string;
  state: WorkerHealthState;
  stateLabel: string;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  runningCount: number;
  queuedCount: number;
  successRatePct: number;
  avgMs: number;
  lastRunMs: number | null;
  lastRunAt: string | null;
  lastError: string | null;
  recentLatencies: number[];
  canTriggerManually: boolean;
}

export interface SystemHealthOverview {
  overallState: 'NOMINAL' | 'ACTIVE' | 'DEGRADED';
  overallLabel: string;
  healthyWorkerCount: number;
  totalWorkers: number;
  totalJobsProcessed: number;
  activeQueueDepth: number;
  avgExecutionMs: number;
  workers: WorkerHealthSummary[];
}

const WORKER_METADATA: Record<
  CoreWorkerType,
  { title: string; role: string; cadence: string; canTriggerManually: boolean }
> = {
  CANARY: {
    title: 'Canary Verification',
    role: 'Replays healed payloads through the 5-assertion schema & sigma suite',
    cadence: 'Event-driven',
    canTriggerManually: false,
  },
  PR_GENERATION: {
    title: 'PR Remediation',
    role: 'Synthesizes canary-proven schema patch pull requests with blast radius',
    cadence: 'Event-driven',
    canTriggerManually: false,
  },
  TTL_SWEEP: {
    title: 'TTL Circuit Sweep',
    role: 'Expires 24-hour hot patches and flips stale fingerprints for re-verification',
    cadence: 'Every 60s',
    canTriggerManually: true,
  },
  METRICS: {
    title: 'Telemetry Aggregation',
    role: 'Computes rolling MTTD, MTTM, repair rate and broadcasts live snapshots',
    cadence: 'Every 15s',
    canTriggerManually: true,
  },
};

const STATE_LABELS: Record<WorkerHealthState, string> = {
  RUNNING: 'Processing',
  HEALTHY: 'Operational',
  DEGRADED: 'Degraded',
  STANDBY: 'Armed · Standby',
};

export function computeSystemHealth(
  recentJobs: JobRunInput[],
  queueStats?: QueueStatsInput | null,
): SystemHealthOverview {
  const safeJobs = Array.isArray(recentJobs) ? recentJobs : [];
  const byTypeStats = queueStats?.byType ?? [];

  const workers: WorkerHealthSummary[] = CORE_WORKER_TYPES.map((type) => {
    const meta = WORKER_METADATA[type];
    const matchingRecent = safeJobs.filter((j) => j.type === type);

    // Aggregate historical counts from queueStats.byType when available,
    // falling back to recentJobs counts if stats were not provided.
    const typeStatRows = byTypeStats.filter((r) => r.type === type);
    const statCountFor = (status: string) => {
      if (typeStatRows.length > 0) {
        return typeStatRows
          .filter((r) => r.status === status)
          .reduce((acc, r) => acc + r.count, 0);
      }
      return matchingRecent.filter((j) => j.status === status).length;
    };

    const doneCount = Math.max(
      statCountFor('DONE'),
      matchingRecent.filter((j) => j.status === 'DONE').length,
    );
    const failedCount = Math.max(
      statCountFor('FAILED'),
      matchingRecent.filter((j) => j.status === 'FAILED').length,
    );
    const runningCount = Math.max(
      statCountFor('RUNNING'),
      matchingRecent.filter((j) => j.status === 'RUNNING').length,
    );
    const queuedCount = Math.max(
      statCountFor('QUEUED'),
      matchingRecent.filter((j) => j.status === 'QUEUED').length,
    );

    const totalRuns = doneCount + failedCount + runningCount + queuedCount;
    const finishedCount = doneCount + failedCount;
    const successRatePct =
      finishedCount > 0 ? Math.round((doneCount / finishedCount) * 1000) / 10 : 100;

    const timedRuns = matchingRecent.filter(
      (j) => typeof j.ms === 'number' && Number.isFinite(j.ms) && j.ms >= 0,
    );
    const avgMs =
      timedRuns.length > 0
        ? Math.round(
            (timedRuns.reduce((sum, j) => sum + (j.ms as number), 0) / timedRuns.length) * 10,
          ) / 10
        : 0;

    const latestRun = matchingRecent[0] ?? null;
    const latestTimed = timedRuns[0] ?? null;
    const latestFailed = matchingRecent.find((j) => j.status === 'FAILED') ?? null;

    // Chronological order (oldest -> newest) for sparkline bars
    const recentLatencies = timedRuns
      .slice(0, 8)
      .map((j) => Math.max(1, Math.round((j.ms as number) * 10) / 10))
      .reverse();

    let state: WorkerHealthState = 'STANDBY';
    if (runningCount > 0 || queuedCount > 0) {
      state = 'RUNNING';
    } else if (
      (latestRun && latestRun.status === 'FAILED') ||
      (finishedCount > 0 && successRatePct < 75)
    ) {
      state = 'DEGRADED';
    } else if (doneCount > 0) {
      state = 'HEALTHY';
    } else {
      state = 'STANDBY';
    }

    return {
      type,
      title: meta.title,
      role: meta.role,
      cadence: meta.cadence,
      state,
      stateLabel: STATE_LABELS[state],
      totalRuns,
      doneCount,
      failedCount,
      runningCount,
      queuedCount,
      successRatePct,
      avgMs,
      lastRunMs: latestTimed?.ms ?? null,
      lastRunAt: latestRun?.createdAt ?? null,
      lastError: latestFailed?.error ?? null,
      recentLatencies,
      canTriggerManually: meta.canTriggerManually,
    };
  });

  const degradedCount = workers.filter((w) => w.state === 'DEGRADED').length;
  const runningWorkers = workers.filter((w) => w.state === 'RUNNING').length;
  const healthyWorkerCount = workers.length - degradedCount;
  const totalJobsProcessed = workers.reduce((sum, w) => sum + w.doneCount + w.failedCount, 0);
  const activeQueueDepth = workers.reduce((sum, w) => sum + w.runningCount + w.queuedCount, 0);

  const workersWithTiming = workers.filter((w) => w.avgMs > 0);
  const avgExecutionMs =
    workersWithTiming.length > 0
      ? Math.round(
          (workersWithTiming.reduce((sum, w) => sum + w.avgMs, 0) / workersWithTiming.length) * 10,
        ) / 10
      : 0;

  let overallState: SystemHealthOverview['overallState'] = 'NOMINAL';
  let overallLabel = 'All Workers Operational';
  if (degradedCount > 0) {
    overallState = 'DEGRADED';
    overallLabel = `${degradedCount} Worker${degradedCount > 1 ? 's' : ''} Degraded`;
  } else if (runningWorkers > 0) {
    overallState = 'ACTIVE';
    overallLabel = 'Workers Actively Draining';
  }

  return {
    overallState,
    overallLabel,
    healthyWorkerCount,
    totalWorkers: CORE_WORKER_TYPES.length,
    totalJobsProcessed,
    activeQueueDepth,
    avgExecutionMs,
    workers,
  };
}

// ─── Worker Failure Threshold Alerting ─────────────────────────────────────

export interface WorkerAlertRule {
  enabled: boolean;
  failureThreshold: number;
}

export type WorkerAlertConfig = Record<CoreWorkerType, WorkerAlertRule>;

export const DEFAULT_WORKER_ALERT_CONFIG: WorkerAlertConfig = {
  CANARY: { enabled: true, failureThreshold: 2 },
  PR_GENERATION: { enabled: true, failureThreshold: 2 },
  TTL_SWEEP: { enabled: true, failureThreshold: 2 },
  METRICS: { enabled: true, failureThreshold: 3 },
};

export interface WorkerAlertBreach {
  workerType: CoreWorkerType;
  title: string;
  failedCount: number;
  consecutiveFailures: number;
  threshold: number;
  lastError: string | null;
  signature: string;
  headline: string;
  description: string;
}

export function normalizeWorkerAlertConfig(
  raw?: Partial<Record<CoreWorkerType, Partial<WorkerAlertRule>>> | null,
): WorkerAlertConfig {
  const out = {} as WorkerAlertConfig;
  for (const type of CORE_WORKER_TYPES) {
    const def = DEFAULT_WORKER_ALERT_CONFIG[type];
    const r = raw?.[type];
    const rawThreshold = Number(r?.failureThreshold ?? def.failureThreshold);
    const clampedThreshold = Number.isFinite(rawThreshold)
      ? Math.max(1, Math.min(20, Math.round(rawThreshold)))
      : def.failureThreshold;
    out[type] = {
      enabled: typeof r?.enabled === 'boolean' ? r.enabled : def.enabled,
      failureThreshold: clampedThreshold,
    };
  }
  return out;
}

/**
 * Evaluates all four workers against user-configured failure thresholds.
 * Returns active breaches and newly-triggered breaches (those whose signature
 * has not yet been notified via toast).
 */
export function evaluateWorkerAlerts(
  workers: WorkerHealthSummary[],
  recentJobs: JobRunInput[],
  config: WorkerAlertConfig,
  notifiedSignatures?: ReadonlySet<string>,
): {
  activeBreaches: WorkerAlertBreach[];
  newBreaches: WorkerAlertBreach[];
} {
  const safeJobs = Array.isArray(recentJobs) ? recentJobs : [];
  const normalized = normalizeWorkerAlertConfig(config);
  const activeBreaches: WorkerAlertBreach[] = [];
  const newBreaches: WorkerAlertBreach[] = [];

  for (const worker of workers) {
    const rule = normalized[worker.type];
    if (!rule || !rule.enabled) continue;

    const matchingJobs = safeJobs.filter((j) => j.type === worker.type);
    let consecutiveFailures = 0;
    for (const job of matchingJobs) {
      if (job.status === 'FAILED') {
        consecutiveFailures += 1;
      } else if (job.status === 'DONE') {
        break;
      }
    }

    if (worker.failedCount >= rule.failureThreshold) {
      const signature = `${worker.type}:failed-${worker.failedCount}:threshold-${rule.failureThreshold}`;
      const headline = `${worker.type} worker failure threshold reached (${worker.failedCount}/${rule.failureThreshold})`;
      const description = worker.lastError
        ? `${worker.title} recorded ${worker.failedCount} failures. Latest error: ${worker.lastError}`
        : `${worker.title} recorded ${worker.failedCount} failures (threshold: ${rule.failureThreshold}).`;

      const breach: WorkerAlertBreach = {
        workerType: worker.type,
        title: worker.title,
        failedCount: worker.failedCount,
        consecutiveFailures,
        threshold: rule.failureThreshold,
        lastError: worker.lastError,
        signature,
        headline,
        description,
      };

      activeBreaches.push(breach);
      if (!notifiedSignatures || !notifiedSignatures.has(signature)) {
        newBreaches.push(breach);
      }
    }
  }

  return { activeBreaches, newBreaches };
}

// ─── 24-Hour Worker Latency Trend Series ───────────────────────────────────

export interface LatencyTrendPoint {
  bucketLabel: string;
  windowLabel: string;
  timestampMs: number;
  CANARY: number | null;
  PR_GENERATION: number | null;
  TTL_SWEEP: number | null;
  METRICS: number | null;
  totalSamples: number;
}

export interface WorkerLatencyStats24h {
  type: CoreWorkerType;
  sampleCount: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  peakMs: number;
}

export interface WorkerLatencyTrends24h {
  hourlyPoints: LatencyTrendPoint[];
  adaptivePoints: LatencyTrendPoint[];
  byWorker: Record<CoreWorkerType, WorkerLatencyStats24h>;
  overall: {
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
    peakMs: number;
  };
}

function computePercentile(sortedValues: number[], pct: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sortedValues.length) - 1),
  );
  return Math.round(sortedValues[idx] * 10) / 10;
}

function formatHourBucket(tsMs: number, isNow: boolean): string {
  if (isNow) return 'Now';
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  return `${hh}:00`;
}

function formatTimePoint(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function buildWorkerLatencyTrends24h(
  jobs: JobRunInput[],
  nowMs: number = Date.now(),
): WorkerLatencyTrends24h {
  const windowStartMs = nowMs - 24 * 60 * 60 * 1000;
  const safeJobs = Array.isArray(jobs) ? jobs : [];

  // Filter valid timed runs within the last 24 hours
  const validRuns = safeJobs
    .map((j) => {
      const ts = new Date(j.createdAt).getTime();
      return {
        ...j,
        ts: Number.isFinite(ts) ? ts : nowMs,
      };
    })
    .filter(
      (j) =>
        j.ts >= windowStartMs &&
        j.ts <= nowMs + 60_000 &&
        typeof j.ms === 'number' &&
        Number.isFinite(j.ms) &&
        j.ms >= 0 &&
        (CORE_WORKER_TYPES as readonly string[]).includes(j.type),
    )
    .sort((a, b) => a.ts - b.ts);

  // 1. Strict 24 hourly buckets (from T-23h to Now)
  const hourMs = 60 * 60 * 1000;
  const currentHourFloor = Math.floor(nowMs / hourMs) * hourMs;
  const hourlyPoints: LatencyTrendPoint[] = [];

  for (let i = 23; i >= 0; i--) {
    const slotStart = currentHourFloor - i * hourMs;
    const slotEnd = i === 0 ? nowMs + 60_000 : slotStart + hourMs;
    const inSlot = validRuns.filter((r) => r.ts >= slotStart && r.ts < slotEnd);

    const avgFor = (type: CoreWorkerType): number | null => {
      const typed = inSlot.filter((r) => r.type === type);
      if (typed.length === 0) return null;
      const sum = typed.reduce((acc, r) => acc + (r.ms as number), 0);
      return Math.round((sum / typed.length) * 10) / 10;
    };

    hourlyPoints.push({
      bucketLabel: formatHourBucket(slotStart, i === 0),
      windowLabel: i === 0 ? 'Current hour' : `${i}h ago (${formatHourBucket(slotStart, false)})`,
      timestampMs: slotStart,
      CANARY: avgFor('CANARY'),
      PR_GENERATION: avgFor('PR_GENERATION'),
      TTL_SWEEP: avgFor('TTL_SWEEP'),
      METRICS: avgFor('METRICS'),
      totalSamples: inSlot.length,
    });
  }

  // 2. Adaptive 24h timeline points (subdivides the active 24h span into up to 16 chronological buckets
  // so multi-point trend lines always render clearly even when runs are clustered in recent hours)
  const adaptivePoints: LatencyTrendPoint[] = [];
  if (validRuns.length === 0) {
    adaptivePoints.push(...hourlyPoints.slice(-12));
  } else {
    const earliestTs = validRuns[0].ts;
    const latestTs = Math.max(validRuns[validRuns.length - 1].ts, earliestTs + 1000);
    const spanMs = Math.max(latestTs - earliestTs, 60_000);
    const bucketCount = Math.min(16, Math.max(6, Math.ceil(validRuns.length / 2)));
    const stepMs = spanMs / bucketCount;

    for (let b = 0; b < bucketCount; b++) {
      const bStart = earliestTs + b * stepMs;
      const bEnd = b === bucketCount - 1 ? latestTs + 1000 : earliestTs + (b + 1) * stepMs;
      const inBucket = validRuns.filter((r) => r.ts >= bStart && r.ts < bEnd);

      const avgFor = (type: CoreWorkerType): number | null => {
        const typed = inBucket.filter((r) => r.type === type);
        if (typed.length === 0) return null;
        const sum = typed.reduce((acc, r) => acc + (r.ms as number), 0);
        return Math.round((sum / typed.length) * 10) / 10;
      };

      adaptivePoints.push({
        bucketLabel: b === bucketCount - 1 ? 'Now' : formatTimePoint(Math.round(bStart)),
        windowLabel: `${formatTimePoint(Math.round(bStart))} – ${formatTimePoint(Math.round(bEnd))}`,
        timestampMs: Math.round(bStart),
        CANARY: avgFor('CANARY'),
        PR_GENERATION: avgFor('PR_GENERATION'),
        TTL_SWEEP: avgFor('TTL_SWEEP'),
        METRICS: avgFor('METRICS'),
        totalSamples: inBucket.length,
      });
    }
  }

  // 3. Per-worker & overall 24h percentile stats
  const byWorker = {} as Record<CoreWorkerType, WorkerLatencyStats24h>;
  for (const type of CORE_WORKER_TYPES) {
    const values = validRuns
      .filter((r) => r.type === type)
      .map((r) => r.ms as number)
      .sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    byWorker[type] = {
      type,
      sampleCount: values.length,
      avgMs: values.length > 0 ? Math.round((sum / values.length) * 10) / 10 : 0,
      p50Ms: computePercentile(values, 50),
      p95Ms: computePercentile(values, 95),
      peakMs: values.length > 0 ? Math.round(values[values.length - 1] * 10) / 10 : 0,
    };
  }

  const allValues = validRuns.map((r) => r.ms as number).sort((a, b) => a - b);
  return {
    hourlyPoints,
    adaptivePoints,
    byWorker,
    overall: {
      sampleCount: allValues.length,
      p50Ms: computePercentile(allValues, 50),
      p95Ms: computePercentile(allValues, 95),
      peakMs: allValues.length > 0 ? Math.round(allValues[allValues.length - 1] * 10) / 10 : 0,
    },
  };
}

// ─── Job Ledger CSV Export (RFC 4180 Audit Format) ─────────────────────────

export interface JobAuditRowInput extends JobRunInput {
  resultJson?: string | null;
}

export const JOB_LEDGER_CSV_HEADERS = [
  'job_id',
  'worker_type',
  'status',
  'attempts',
  'latency_ms',
  'created_at',
  'error',
  'result_json',
] as const;

export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatJobsCsv(jobs: JobAuditRowInput[]): string {
  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const headerLine = JOB_LEDGER_CSV_HEADERS.join(',');
  const rows = safeJobs.map((job) =>
    [
      escapeCsvCell(job.id),
      escapeCsvCell(job.type),
      escapeCsvCell(job.status),
      escapeCsvCell(job.attempts),
      escapeCsvCell(job.ms ?? ''),
      escapeCsvCell(job.createdAt),
      escapeCsvCell(job.error ?? ''),
      escapeCsvCell(job.resultJson ?? ''),
    ].join(','),
  );
  return [headerLine, ...rows].join('\r\n');
}

// ─── Individual Failed Job Auto-Retry Helpers ──────────────────────────────

export interface AutoRetryJobCandidate {
  id: string;
  type: string;
  status: string;
  attempts?: number;
  error?: string | null;
  payloadJson?: string | null;
  resultJson?: string | null;
}

export function canAutoRetryJob(job: Pick<AutoRetryJobCandidate, 'status'> | null | undefined): boolean {
  if (!job) return false;
  return job.status === 'FAILED';
}

export function buildAutoRetryJobPayload(
  payloadJson?: string | null,
  previousAttempts = 1,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (typeof payloadJson === 'string' && payloadJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(payloadJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      base = {};
    }
  }

  return {
    ...base,
    autoRetry: true,
    transientRecovery: true,
    previousAttempts: Math.max(1, Math.round(previousAttempts)),
    retriedAt: nowIso,
  };
}

export function isAutoRetriedJob(
  job: Pick<AutoRetryJobCandidate, 'payloadJson' | 'resultJson'> | null | undefined,
): boolean {
  if (!job) return false;
  for (const raw of [job.payloadJson, job.resultJson]) {
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.autoRetry === true ||
          parsed.autoRetried === true ||
          parsed.recoveredTransientFault === true)
      ) {
        return true;
      }
    } catch {
      // ignore malformed JSON
    }
  }
  return false;
}

