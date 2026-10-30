/**
 * API-HEALER · Audit writer (background persistence for hot-path events)
 * ------------------------------------------------------------------------
 * The hot path must never block on the audit trail: a 4.5σ veto has a <2ms
 * wall-time budget and a cold heal a 650ms budget — an awaited SQLite INSERT
 * on the response path would burn both. DriftEvent persistence therefore runs
 * in the background: the caller returns immediately, the row lands a few ms
 * later, and the bus event is emitted WITH the persisted eventId once the
 * write settles.
 *
 * The pending-write set is a globalThis singleton (Next dev route-chunk
 * safety): the cold-path workers can `flushHealWrites()` and be certain every
 * event their originating request produced is queryable before they link a
 * PR to it — across route chunks, in the same process.
 */
import { db } from '@/lib/db';
import { emitEvent } from '@/lib/events';

export interface DriftEventCreate {
  id?: string;
  contractId: string;
  signature?: string;
  driftType?: string;
  callsite?: string | null;
  classificationJson?: string;
  rawPayloadJson?: string;
  healedPayloadJson?: string | null;
  planJson?: string | null;
  gatesJson?: string | null;
  status?: string;
  composer?: string;
  confidence?: number;
  classifyMs?: number;
  composeMs?: number;
  gatesMs?: number;
  totalMs?: number;
  canaryPassed?: boolean | null;
  prId?: string | null;
}

const globalForAudit = globalThis as unknown as {
  __apiHealerPendingWrites?: Set<Promise<unknown>>;
};

function pending(): Set<Promise<unknown>> {
  if (!globalForAudit.__apiHealerPendingWrites) {
    globalForAudit.__apiHealerPendingWrites = new Set();
  }
  return globalForAudit.__apiHealerPendingWrites;
}

/**
 * Persist one DriftEvent in the background; emit `heal:event` (with eventId)
 * once it lands. Never throws, never blocks the caller.
 */
export function recordDriftEventInBackground(
  data: DriftEventCreate,
  eventPayload: Record<string, unknown>,
): void {
  const write = (async () => {
    await Promise.resolve();
    const ev = await db.driftEvent.create({ data });
    emitEvent('heal:event', { ...eventPayload, eventId: ev.id });
    return ev.id as string | undefined;
  })().catch(() => {
    // audit is best-effort telemetry — never take the firewall down
    emitEvent('heal:event', eventPayload);
    return undefined;
  });
  const set = pending();
  set.add(write);
  void write.finally(() => set.delete(write));
}

/** True when no background audit writes are in flight. */
export function healWritesIdle(): boolean {
  return pending().size === 0;
}

/**
 * Await every in-flight audit write (and any writes chained during the
 * drain). Used by cold-path workers and the test harness so downstream
 * queries (PR linking, canary verdicts, assertions) never race the writer.
 */
export async function flushHealWrites(): Promise<void> {
  const set = pending();
  while (set.size > 0) {
    await Promise.all([...set]);
  }
}
