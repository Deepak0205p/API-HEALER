/**
 * Runtime reset — wipe all traffic-derived state (events, fingerprints, PRs,
 * job ledger) + the in-memory hot tier. Contracts are user-owned and kept.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resetMemoryTier } from '@/lib/healer/memory';
import { resetBreakers } from '@/lib/healer/breaker';
import { invalidateContractCache, flushAllContractCaches } from '@/lib/healer/contract-cache';
import { resetRuntimeCounters } from '@/lib/healer/counters';
import { resetOutboundCache } from '@/lib/healer/outbound';
import { recordAuditLog } from '@/lib/audit';

export async function POST() {
  await db.driftEvent.deleteMany({});
  await db.fingerprint.deleteMany({});
  await db.pullRequest.deleteMany({});
  await db.jobRun.deleteMany({});
  // settle write-behind state, then clear every in-memory tier
  await flushAllContractCaches().catch(() => undefined);
  invalidateContractCache();
  resetMemoryTier();
  resetBreakers();
  resetRuntimeCounters();
  resetOutboundCache();

  void recordAuditLog({
    action: 'RESET_RUNTIME_STATE',
    category: 'SYSTEM_ACTION',
    target: 'runtime:cache_and_state',
    status: 'SUCCESS',
    details: 'Wiped all traffic-derived state (drift events, fingerprints, PRs, job queue) and flushed in-memory tiers.',
    performedByEmail: 'operator@api-healer.internal',
  }).catch(() => undefined);

  return NextResponse.json({ ok: true });
}
