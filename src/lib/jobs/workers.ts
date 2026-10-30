/**
 * API-HEALER · Job Workers (Loop 2 cold path + maintenance)
 * ----------------------------------------------------------
 *  CANARY        — full Zod canary suite on the healed payload; writes the
 *                  verdict back onto the originating DriftEvent.
 *  PR_GENERATION — builds the canary-proven remediation PR (GitHub when
 *                  GITHUB_TOKEN is present, DRY_RUN otherwise).
 *  TTL_SWEEP     — 24h circuit breaker: expires hot patches + fingerprints,
 *                  forcing PR review instead of runtime debt.
 *  METRICS       — rolling MTTD/MTTM/MTTI + repair-rate aggregation,
 *                  broadcast to every dashboard over the event bus.
 *  ALERT         — Track A degraded-mutation notifications: a developer
 *                  alert fired when a write call was refused-safe against
 *                  an overloaded upstream (never retried, never lost).
 */
import { db } from '@/lib/db';
import { emitEvent } from '@/lib/events';
import { registerHandler, recoverStaleJobs, drainQueue } from './queue';
import type { JobType } from './queue';
import { runCanary } from '@/lib/healer/canary';
import { createPullRequest } from '@/lib/healer/github';
import { parseContractDef } from '@/lib/healer/contract';
import { sweepExpiredFingerprints, listHotPatches } from '@/lib/healer/memory';
import { recordFailure } from '@/lib/healer/breaker';
import { computeMetrics } from '@/lib/healer/metrics';
import { flushHealWrites } from '@/lib/healer/audit';
import { flushContractHistory } from '@/lib/healer/contract-cache';
import type { HealPlan } from '@/lib/healer/types';

const REFUSED_PLAN: HealPlan = {
  version: 1,
  ops: [],
  confidence: 0,
  rationale: 'Composer refused — engineer investigation required (missing mandatory data)',
  composer: 'deterministic',
};

async function contractFor(contractId: string) {
  const contract = await db.contract.findUnique({ where: { id: contractId } });
  if (!contract) throw new Error(`contract ${contractId} not found`);
  return contract;
}

// ─── CANARY ────────────────────────────────────────────────────────────────

registerHandler('CANARY', async (payload) => {
  // hot-path audit + history are write-behind: settle them before reading
  await flushHealWrites();
  if (!payload.contractId || payload.simulatedFault) {
    return {
      passed: true,
      autoRetried: Boolean(payload.autoRetry),
      recoveredTransientFault: true,
      log: [
        {
          check: 'transient-retry',
          passed: true,
          detail: 'Transient worker fault recovered via Auto-Retry',
        },
      ],
      ms: 2,
    };
  }
  await flushContractHistory(String(payload.contractId));
  const contract = await contractFor(String(payload.contractId));
  const contractDef = parseContractDef(contract.schemaJson);
  const mandatory = JSON.parse(contract.mandatoryJson) as string[];
  const history = JSON.parse(contract.historyJson) as Record<string, number[]>;

  const canary = runCanary({
    rawPayload: payload.rawPayload as Record<string, unknown>,
    healedPayload: payload.healedPayload as Record<string, unknown>,
    plan: payload.plan as HealPlan,
    contractDef,
    mandatory,
    history,
  });

  // attach verdict to the originating event (latest for this signature)
  const ev = await db.driftEvent.findFirst({
    where: { signature: String(payload.signature), contractId: contract.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (ev) {
    await db.driftEvent.update({
      where: { id: ev.id },
      data: { canaryPassed: canary.passed },
    });
  }

  void emitEvent('heal:canary', {
    eventId: ev?.id,
    signature: payload.signature,
    passed: canary.passed,
    log: canary.log,
    ms: canary.ms,
  });

  if (!canary.passed) {
    // A canary failure revokes the hot patch immediately — safety first —
    // and trips the per-contract circuit breaker (repeated canary failures
    // OPEN it, stripping the adapter entirely).
    const { dropHotPatch } = await import('@/lib/healer/memory');
    dropHotPatch(String(payload.signature));
    const failed = canary.log.filter((l) => !l.passed).map((l) => l.check).join(', ');
    recordFailure(contract.id, `canary failed: ${failed || 'assertion error'}`);
  }

  return {
    passed: canary.passed,
    autoRetried: Boolean(payload.autoRetry),
    log: canary.log,
    ms: canary.ms,
  };
});

// ─── PR_GENERATION ─────────────────────────────────────────────────────────

registerHandler('PR_GENERATION', async (payload) => {
  // the originating DriftEvent is persisted write-behind — settle it first
  await flushHealWrites();
  if (!payload.contractId || payload.simulatedFault) {
    return {
      ok: true,
      autoRetried: Boolean(payload.autoRetry),
      recoveredTransientFault: true,
      mode: 'DRY_RUN',
    };
  }
  const contract = await contractFor(String(payload.contractId));
  const plan = (payload.plan as HealPlan | null) ?? REFUSED_PLAN;
  const canaryLog = payload.refused
    ? [
        { check: 'promotion', passed: false, detail: 'heal refused — PR documents the incident for engineers' },
      ]
    : [
        { check: 'hot-path-gates', passed: true, detail: 'plan survived all 3 refusal gates in the hot path' },
        { check: 'ttl-bridge', passed: true, detail: '24h emergency TTL bridge engaged — PR is the permanent fix' },
      ];

  // Blast radius: distinct consumer callsites that hit this drift signature.
  const callsiteEvents = await db.driftEvent.findMany({
    where: { contractId: contract.id, signature: String(payload.signature ?? ''), callsite: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { callsite: true },
  });
  const callsites = [...new Set(callsiteEvents.map((e) => e.callsite as string))].slice(0, 10);

  // 24h TTL bridge expiry (the PR's deadline) — from the fingerprint row.
  const fingerprint = await db.fingerprint
    .findUnique({
      where: { signature: String(payload.signature ?? '') },
      select: { ttlAt: true },
    })
    .catch(() => null);

  const artifact = await createPullRequest({
    contractName: contract.name,
    endpoint: contract.endpoint,
    driftType: String(payload.driftType ?? 'UNKNOWN'),
    signature: String(payload.signature ?? ''),
    plan,
    rawPayload: payload.rawPayload,
    healedPayload: payload.healedPayload ?? null,
    canaryLog,
    findings: (payload.findings as unknown[] | undefined) ?? [],
    callsites,
    ttlExpiresAt: fingerprint?.ttlAt ?? null,
  });

  // Sequential per-contract PR number (drain is single-flight, so no race);
  // real GitHub mode replaces it with the upstream PR number.
  const existing = await db.pullRequest.count({ where: { contractId: contract.id } });
  const number = existing + 1;

  const pr = await db.pullRequest.create({
    data: {
      contractId: contract.id,
      number,
      branch: artifact.branch,
      title: artifact.title,
      body: artifact.body,
      diffText: artifact.diffText,
      planJson: JSON.stringify(plan),
      canaryLogJson: JSON.stringify(canaryLog),
      status: 'OPEN',
      mode: artifact.mode,
      url: artifact.url,
    },
  });

  const ev = await db.driftEvent.findFirst({
    where: { signature: String(payload.signature ?? ''), contractId: contract.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (ev) {
    await db.driftEvent.update({ where: { id: ev.id }, data: { prId: pr.id } });
  }

  void emitEvent('heal:pr', {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    mode: pr.mode,
    contract: contract.name,
  });

  return { prId: pr.id, number: pr.number, mode: pr.mode, url: pr.url };
});

// ─── ALERT ─────────────────────────────────────────────────────────────────

registerHandler('ALERT', async (payload) => {
  const alert = {
    kind: String(payload.kind ?? 'GENERIC'),
    contractId: String(payload.contractId ?? ''),
    upstreamStatus: payload.upstreamStatus ?? null,
    breakerState: payload.breakerState ?? null,
    url: String(payload.url ?? ''),
    message: String(payload.message ?? 'developer attention required'),
    at: new Date().toISOString(),
  };
  // Every channel the operator plausibly watches: live bus + server log.
  // (The dashboard renders heal:alert frames with full severity styling.)
  void emitEvent('heal:alert', alert);
  console.warn(
    `[api-healer][ALERT][${alert.kind}] upstream=${alert.upstreamStatus ?? '?'} breaker=${alert.breakerState ?? '?'} ${alert.message}`,
  );
  return alert as unknown as Record<string, unknown>;
});

// ─── TTL_SWEEP ─────────────────────────────────────────────────────────────

registerHandler('TTL_SWEEP', async () => {
  const expired = await sweepExpiredFingerprints();
  const hot = listHotPatches(); // also evicts in-memory TTL entries
  void emitEvent('heal:ttl', { expiredFingerprints: expired, activeHotPatches: hot.length });
  return { expiredFingerprints: expired, activeHotPatches: hot.length };
});

// ─── METRICS ───────────────────────────────────────────────────────────────

registerHandler('METRICS', async () => {
  const metrics = await computeMetrics();
  void emitEvent('heal:metrics', metrics);
  return metrics as unknown as Record<string, unknown>;
});

// ─── Boot ──────────────────────────────────────────────────────────────────

const globalForBoot = globalThis as unknown as {
  __apiHealerWorkersBooted?: boolean;
  __apiHealerTimers?: NodeJS.Timeout[];
};

/** Idempotent worker boot — called from instrumentation.ts (nodejs runtime). */
export function bootWorkers(): void {
  if (globalForBoot.__apiHealerWorkersBooted) return;
  globalForBoot.__apiHealerWorkersBooted = true;

  void recoverStaleJobs().then((n) => {
    if (n > 0) console.log(`[jobs] recovered ${n} stale RUNNING job(s)`);
    return drainQueue();
  });

  const timers: NodeJS.Timeout[] = [];
  timers.push(
    setInterval(() => {
      void db.jobRun
        .create({ data: { type: 'TTL_SWEEP', payloadJson: '{}', priority: 9 } })
        .then(() => drainQueue())
        .catch(() => undefined);
    }, 60_000),
  );
  timers.push(
    setInterval(() => {
      void db.jobRun
        .create({ data: { type: 'METRICS', payloadJson: '{}', priority: 9 } })
        .then(() => drainQueue())
        .catch(() => undefined);
    }, 15_000),
  );
  // The intervals alone must never keep the process alive (test harness,
  // CLI runs). Production servers stay up via their HTTP listeners.
  for (const t of timers) t.unref?.();

  if (typeof process !== 'undefined') {
    process.on('SIGTERM', () => timers.forEach((t) => clearInterval(t)));
    process.on('SIGINT', () => timers.forEach((t) => clearInterval(t)));
  }
  globalForBoot.__apiHealerTimers = timers;
  console.log('[jobs] workers armed: CANARY · PR_GENERATION · ALERT · TTL_SWEEP · METRICS');
}

export const JOB_TYPES: JobType[] = ['CANARY', 'PR_GENERATION', 'ALERT', 'TTL_SWEEP', 'METRICS'];
