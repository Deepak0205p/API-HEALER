/** Job system monitor: stats + recent runs, on-demand execution, auto-retry, and fault injection for alert testing. */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { emitEvent } from '@/lib/events';
import {
  enqueueJob,
  drainQueue,
  queueStats,
  retryFailedJob,
  type JobType,
} from '@/lib/jobs/queue';
import { recordAuditLog } from '@/lib/audit';

const CORE_WORKERS: JobType[] = ['CANARY', 'PR_GENERATION', 'TTL_SWEEP', 'METRICS'];
const TRIGGERABLE_WORKERS: JobType[] = ['TTL_SWEEP', 'METRICS'];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(250, Math.max(1, Number(searchParams.get('limit') ?? 150)));
  const [stats, recent] = await Promise.all([
    queueStats(),
    db.jobRun.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
  ]);
  return NextResponse.json({ stats, recent });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      type?: string;
      simulateFailure?: boolean;
      errorReason?: string;
    };
    const requestedType = String(body.type ?? 'METRICS').toUpperCase() as JobType;

    if (body.simulateFailure) {
      if (!CORE_WORKERS.includes(requestedType)) {
        return NextResponse.json(
          { error: `Unknown worker type: ${requestedType}` },
          { status: 400 },
        );
      }

      const errorMsg =
        body.errorReason?.trim() ||
        `${requestedType} worker execution failed (threshold verification fault)`;

      const failedRow = await db.jobRun.create({
        data: {
          type: requestedType,
          status: 'FAILED',
          priority: 1,
          attempts: 2,
          ms: 12,
          error: errorMsg,
          payloadJson: JSON.stringify({ simulatedFault: true }),
          finishedAt: new Date(),
        },
      });

      void emitEvent('jobs:update', {
        id: failedRow.id,
        type: requestedType,
        status: 'FAILED',
        error: errorMsg,
      });

      void db.notification.create({
        data: {
          category: 'ALERT',
          severity: 'WARNING',
          title: `${requestedType} Worker Failure Recorded`,
          description: errorMsg,
          source: `worker:${requestedType.toLowerCase()}`,
          metadataJson: JSON.stringify({ jobId: failedRow.id, type: requestedType }),
        },
      });

      void recordAuditLog({
        action: 'SIMULATE_WORKER_FAULT',
        category: 'SYSTEM_ACTION',
        target: `worker:${requestedType.toLowerCase()}`,
        status: 'FAILED',
        details: `Injected simulated verification fault into ${requestedType} worker queue for alert validation.`,
        metadata: { jobId: failedRow.id, type: requestedType, error: errorMsg },
      }).catch(() => undefined);

      const [stats, recent] = await Promise.all([
        queueStats(),
        db.jobRun.findMany({ orderBy: { createdAt: 'desc' }, take: 150 }),
      ]);

      return NextResponse.json({ ok: true, job: failedRow, stats, recent });
    }

    if (!TRIGGERABLE_WORKERS.includes(requestedType)) {
      return NextResponse.json(
        { error: `Worker ${requestedType} cannot be triggered manually without a drift payload.` },
        { status: 400 },
      );
    }

    const job = await enqueueJob(requestedType, { triggeredBy: 'operator' }, 1);
    await drainQueue();

    void recordAuditLog({
      action: 'TRIGGER_WORKER',
      category: 'SYSTEM_ACTION',
      target: `worker:${requestedType.toLowerCase()}`,
      status: 'SUCCESS',
      details: `Operator manually triggered on-demand execution cycle for ${requestedType} worker.`,
      metadata: { jobId: job.id, type: requestedType },
    }).catch(() => undefined);

    const [stats, recent] = await Promise.all([
      queueStats(),
      db.jobRun.findMany({ orderBy: { createdAt: 'desc' }, take: 150 }),
    ]);

    return NextResponse.json({ ok: true, job, stats, recent });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to process worker job request' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      jobId?: string;
      autoRetry?: boolean;
    };
    const jobId = body.jobId?.trim();
    if (!jobId) {
      return NextResponse.json({ error: 'jobId is required for Auto-Retry' }, { status: 400 });
    }

    const updatedJob = await retryFailedJob(jobId);
    if (!updatedJob) {
      return NextResponse.json({ error: `Job ${jobId} not found` }, { status: 404 });
    }

    void db.notification.create({
      data: {
        category: 'SYSTEM',
        severity: updatedJob.status === 'DONE' ? 'SUCCESS' : 'WARNING',
        title:
          updatedJob.status === 'DONE'
            ? `Auto-Retry Succeeded · ${updatedJob.type}`
            : `Auto-Retry Queued · ${updatedJob.type}`,
        description:
          updatedJob.status === 'DONE'
            ? `Transient failure on job ${jobId.slice(0, 8)} recovered on attempt #${updatedJob.attempts} (${updatedJob.ms ?? 1}ms).`
            : `Retry attempt #${updatedJob.attempts} queued for job ${jobId.slice(0, 8)}.`,
        source: `worker:${updatedJob.type.toLowerCase()}`,
        metadataJson: JSON.stringify({
          jobId: updatedJob.id,
          type: updatedJob.type,
          status: updatedJob.status,
          attempts: updatedJob.attempts,
          autoRetry: true,
        }),
      },
    });

    void recordAuditLog({
      action: 'RETRY_JOB',
      category: 'JOB_RETRY',
      target: `job:${updatedJob.id}`,
      status: updatedJob.status === 'DONE' ? 'SUCCESS' : updatedJob.status === 'FAILED' ? 'FAILED' : 'PENDING',
      details:
        updatedJob.status === 'DONE'
          ? `Auto-Retry resolved transient failure for ${updatedJob.type} job #${updatedJob.id.slice(0, 8)} in ${updatedJob.ms ?? 1}ms (Attempt #${updatedJob.attempts}).`
          : `Auto-Retry attempt #${updatedJob.attempts} queued for ${updatedJob.type} job #${updatedJob.id.slice(0, 8)}.`,
      metadata: {
        jobId: updatedJob.id,
        type: updatedJob.type,
        status: updatedJob.status,
        attempts: updatedJob.attempts,
        durationMs: updatedJob.ms,
      },
    }).catch(() => undefined);

    const [stats, recent] = await Promise.all([
      queueStats(),
      db.jobRun.findMany({ orderBy: { createdAt: 'desc' }, take: 150 }),
    ]);

    return NextResponse.json({ ok: true, job: updatedJob, stats, recent });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to auto-retry job' },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const workerType = searchParams.get('type')?.toUpperCase();
    await db.jobRun.deleteMany({
      where: {
        status: 'FAILED',
        ...(workerType ? { type: workerType } : {}),
      },
    });

    void recordAuditLog({
      action: 'CLEAR_FAILED_JOBS',
      category: 'SYSTEM_ACTION',
      target: workerType ? `worker:${workerType}` : 'all_workers',
      status: 'SUCCESS',
      details: `Operator purged failed jobs queue for ${workerType || 'all workers'}.`,
      metadata: { workerType: workerType || 'ALL' },
    }).catch(() => undefined);

    const [stats, recent] = await Promise.all([
      queueStats(),
      db.jobRun.findMany({ orderBy: { createdAt: 'desc' }, take: 150 }),
    ]);
    return NextResponse.json({ ok: true, stats, recent });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to clear failed jobs' },
      { status: 500 },
    );
  }
}

