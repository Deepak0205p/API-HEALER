/**
 * API-HEALER · Background Job Queue (the Bridge's async muscle)
 * --------------------------------------------------------------
 * A durable, single-writer job queue persisted in SQLite (JobRun table).
 * The hot path ENQUEUES and moves on — canary verification, GitHub PR
 * generation, TTL sweeping and metrics aggregation all run asynchronously
 * exactly as the "Async Telemetry Relay" invariant prescribes.
 *
 * Features: priority lanes, at-least-once claim semantics, crash recovery
 * (stale RUNNING jobs re-queued at boot), attempt counters, live bus events.
 */
import { db } from '@/lib/db';
import { emitEvent } from '@/lib/events';
import { buildAutoRetryJobPayload } from '@/lib/healer/system-health';
import { ensureWorkersBooted } from './boot';

export type JobType = 'CANARY' | 'PR_GENERATION' | 'TTL_SWEEP' | 'METRICS' | 'ALERT';

export interface EnqueuedJob {
  id: string;
  type: JobType;
}

/** Enqueue a job and trigger an async drain. Never throws, never blocks. */
export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  priority = 5,
): Promise<EnqueuedJob> {
  try {
    // arm handlers first so the drain never sees an unhandled job
    await ensureWorkersBooted();
    const row = await db.jobRun.create({
      data: { type, payloadJson: JSON.stringify(payload), priority },
    });
    // fire-and-forget drain — the hot path is already done with us
    void drainQueue();
    void emitEvent('jobs:update', { id: row.id, type, status: 'QUEUED' });
    return { id: row.id, type };
  } catch (e) {
    console.error('[jobs] enqueue failed', type, e);
    return { id: '', type };
  }
}

const globalForQ = globalThis as unknown as {
  __apiHealerDraining?: boolean;
  __apiHealerHandlers?: Map<JobType, JobHandler>;
};

export type JobHandler = (
  payload: Record<string, unknown>,
  job: { id: string; attempts: number },
) => Promise<Record<string, unknown>>;

export function registerHandler(type: JobType, handler: JobHandler): void {
  const map = globalForQ.__apiHealerHandlers ?? new Map<JobType, JobHandler>();
  map.set(type, handler);
  globalForQ.__apiHealerHandlers = map;
}

/** Claim jobs atomically-enough for a single writer process (SQLite). */
async function claimNext(): Promise<{ id: string; type: JobType; payload: Record<string, unknown>; attempts: number } | null> {
  const candidates = await db.jobRun.findMany({
    where: { status: 'QUEUED' },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: 5,
  });
  for (const c of candidates) {
    const claimed = await db.jobRun.updateMany({
      where: { id: c.id, status: 'QUEUED' },
      data: { status: 'RUNNING', attempts: { increment: 1 } },
    });
    if (claimed.count === 1) {
      return {
        id: c.id,
        type: c.type as JobType,
        payload: JSON.parse(c.payloadJson) as Record<string, unknown>,
        attempts: c.attempts + 1,
      };
    }
  }
  return null;
}

let draining = false;

export async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const job = await claimNext();
      if (!job) break;
      const t0 = Date.now();
      const handler = globalForQ.__apiHealerHandlers?.get(job.type);
      if (!handler && job.attempts <= 2) {
        // handler not registered yet (cold race) — requeue, bounded retries
        await db.jobRun.update({
          where: { id: job.id },
          data: { status: 'QUEUED', attempts: { increment: 1 } },
        }).catch(() => undefined);
        continue;
      }
      try {
        const rawResult = handler
          ? await handler(job.payload, { id: job.id, attempts: job.attempts })
          : { error: `no handler for ${job.type}` };
        const result =
          job.payload.autoRetry === true
            ? { ...(rawResult ?? {}), autoRetried: true }
            : (rawResult ?? {});
        await db.jobRun.update({
          where: { id: job.id },
          data: {
            status: handler ? 'DONE' : 'FAILED',
            resultJson: JSON.stringify(result),
            ms: Math.max(1, Date.now() - t0),
            finishedAt: new Date(),
            error: handler ? null : `no handler for ${job.type}`,
          },
        });
        void emitEvent('jobs:update', {
          id: job.id,
          type: job.type,
          status: handler ? 'DONE' : 'FAILED',
          ms: Math.max(1, Date.now() - t0),
          autoRetried: job.payload.autoRetry === true,
        });
      } catch (e) {
        await db.jobRun
          .update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              error: e instanceof Error ? e.message : String(e),
              ms: Math.max(1, Date.now() - t0),
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        void emitEvent('jobs:update', {
          id: job.id,
          type: job.type,
          status: 'FAILED',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Queue an immediate retry attempt for an individual failed job (Auto-Retry toggle).
 * Resets the failed job row to QUEUED with priority 1, clears previous error,
 * and drains the queue so the retry executes through the registered worker handler.
 */
export async function retryFailedJob(jobId: string) {
  await ensureWorkersBooted();
  const existing = await db.jobRun.findUnique({ where: { id: jobId } });
  if (!existing) {
    throw new Error(`Job ${jobId} not found`);
  }

  const nextPayload = buildAutoRetryJobPayload(existing.payloadJson, existing.attempts);

  await db.jobRun.update({
    where: { id: jobId },
    data: {
      status: 'QUEUED',
      priority: 1,
      error: null,
      finishedAt: null,
      payloadJson: JSON.stringify(nextPayload),
    },
  });

  void emitEvent('jobs:update', {
    id: jobId,
    type: existing.type,
    status: 'QUEUED',
    autoRetry: true,
  });

  await drainQueue();

  return db.jobRun.findUnique({ where: { id: jobId } });
}

/** Boot-time crash recovery: requeue jobs stuck in RUNNING from a prior life. */
export async function recoverStaleJobs(): Promise<number> {
  const stale = await db.jobRun.findMany({ where: { status: 'RUNNING' } });
  if (stale.length === 0) return 0;
  const res = await db.jobRun.updateMany({
    where: { id: { in: stale.map((s) => s.id) } },
    data: { status: 'QUEUED' },
  });
  if (res.count > 0) void drainQueue();
  return res.count;
}

export async function queueStats() {
  const grouped = await db.jobRun.groupBy({
    by: ['status'],
    _count: { status: true },
  });
  const byType = await db.jobRun.groupBy({
    by: ['type', 'status'],
    _count: { status: true },
  });
  return {
    byStatus: Object.fromEntries(grouped.map((g) => [g.status, g._count.status])),
    byType: byType.map((g) => ({ type: g.type, status: g.status, count: g._count.status })),
  };
}
