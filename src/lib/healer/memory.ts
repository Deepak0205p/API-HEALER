/**
 * API-HEALER · Memory tier
 * -------------------------
 * Two-tier heal memory:
 *   HOT  — in-process Map: last-known-good payloads + active hot patches,
 *          each entry carries a 24h TTL (emergency bridge / circuit breaker).
 *   COLD — SQLite fingerprint store: verified DSL plans indexed by the
 *          SHA-256 of the canonical drift signature. Repeat breaks resolve
 *          in ~0.8ms with zero LLM overhead. Sibling routes sharing the same
 *          drift signature inherit fleet-wide immunity.
 *
 * LAST-KNOWN-GOOD is itself two-tier since the dual-mode spec: the hot Map
 * serves Track A stale-fallbacks in <0.1ms, while a debounced write-behind
 * mirror in SQLite (Contract.lastGoodJson) survives process restarts. The
 * contract-cache hydrates the hot tier from the durable copy on first touch.
 */
import { createHash } from 'crypto';
import type { Classification, DriftFinding, HealPlan } from './types';
import { TTL_HOURS } from './types';
import { db } from '@/lib/db';

// ─── Signature ─────────────────────────────────────────────────────────────

/**
 * Canonical drift signature: endpoint + drift type + normalized findings.
 * Deliberately payload-value-independent so that the SAME structural drift
 * across sibling routes maps to one fingerprint (fleet immunity).
 */
export function canonicalSignature(
  contractId: string,
  classification: Classification,
): string {
  const norm = (f: DriftFinding) => {
    const meta: Record<string, unknown> = {};
    for (const key of ['observedKey', 'candidatePath', 'observedType', 'expectedType', 'mandatory', 'candidates', 'ambiguous']) {
      if (key in f.meta) meta[key] = f.meta[key];
    }
    return { path: f.path, type: f.type, meta };
  };
  const canonical = JSON.stringify({
    contractId,
    driftType: classification.driftType,
    findings: classification.findings.map(norm).sort((a, b) =>
      a.path === b.path ? a.type.localeCompare(b.type) : a.path.localeCompare(b.path),
    ),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * FLEET signature: drift structure WITHOUT the contract id — the same
 * structural break on sibling routes (e.g. /orders, /orders/{id}, /analytics
 * consuming the same upstream shape) maps to ONE fingerprint. A plan learned
 * on any endpoint is offered to the others, but is STILL fully re-verified by
 * the 3-gate refusal engine + Zod canary against the borrowing contract, so
 * an inapplicable plan is vetoed by Gate 1 (POLICY) — safety is structural.
 */
export function structuralSignature(classification: Classification): string {
  const norm = (f: DriftFinding) => {
    const meta: Record<string, unknown> = {};
    for (const key of ['observedKey', 'candidatePath', 'observedType', 'expectedType', 'mandatory', 'candidates', 'ambiguous']) {
      if (key in f.meta) meta[key] = f.meta[key];
    }
    return { path: f.path, type: f.type, meta };
  };
  const canonical = JSON.stringify({
    driftType: classification.driftType,
    findings: classification.findings.map(norm).sort((a, b) =>
      a.path === b.path ? a.type.localeCompare(b.type) : a.path.localeCompare(b.path),
    ),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── HOT tier ──────────────────────────────────────────────────────────────

export interface HotPatchEntry {
  signature: string;
  contractId: string;
  /** plan cached for 0.8ms re-heal */
  plan: HealPlan;
  /** last-known-good payload for 2ms deterministic fail-safe rollback */
  lastKnownGood: Record<string, unknown>;
  createdAt: number;
  ttlAt: number;
  hits: number;
}

interface HotStore {
  bySignature: Map<string, HotPatchEntry>;
  lastGoodByContract: Map<string, Record<string, unknown>>;
}

const globalForHot = globalThis as unknown as { __apiHealerHot?: HotStore };
const store: HotStore =
  globalForHot.__apiHealerHot ??
  (globalForHot.__apiHealerHot = {
    bySignature: new Map(),
    lastGoodByContract: new Map(),
  });

export function getLastKnownGood(contractId: string): Record<string, unknown> | undefined {
  return store.lastGoodByContract.get(contractId);
}

/** Hot-set WITHOUT scheduling a durable write (hydration from SQLite). */
export function setLastKnownGoodHotOnly(
  contractId: string,
  payload: Record<string, unknown>,
): void {
  store.lastGoodByContract.set(contractId, structuredClone(payload));
}

// ── durable LKG tier (write-behind mirror in SQLite) ───────────────────────

const globalForLkgTimers = globalThis as unknown as {
  __apiHealerLkgTimers?: Map<string, ReturnType<typeof setTimeout>>;
};
function lkgTimers(): Map<string, ReturnType<typeof setTimeout>> {
  if (!globalForLkgTimers.__apiHealerLkgTimers) {
    globalForLkgTimers.__apiHealerLkgTimers = new Map();
  }
  return globalForLkgTimers.__apiHealerLkgTimers;
}

/**
 * Record a last-known-good payload: hot tier synchronously (the 2ms
 * fail-safe reads it), durable tier debounced (never on the hot path's
 * critical section — a process crash costs at most one debounce window).
 */
export function setLastKnownGood(contractId: string, payload: Record<string, unknown>): void {
  setLastKnownGoodHotOnly(contractId, payload);
  const timers = lkgTimers();
  const existing = timers.get(contractId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(contractId);
    void persistLastKnownGood(contractId).catch(() => undefined);
  }, 5_000);
  timers.set(contractId, t);
}

/** Force the durable LKG write now (tests / shutdown / Track A first read). */
export async function persistLastKnownGood(contractId: string): Promise<void> {
  const payload = store.lastGoodByContract.get(contractId);
  if (!payload) return;
  await db.contract
    .update({
      where: { id: contractId },
      data: { lastGoodJson: JSON.stringify(payload), lastGoodAt: new Date() },
    })
    .catch(() => undefined);
}

/** Flush every pending durable-LKG write (operator reset / tests). */
export async function flushAllLastKnownGood(): Promise<void> {
  const timers = lkgTimers();
  for (const [id, t] of timers) {
    clearTimeout(t);
    timers.delete(id);
  }
  const ids = [...store.lastGoodByContract.keys()];
  await Promise.all(ids.map((id) => persistLastKnownGood(id).catch(() => undefined)));
}

/**
 * Track A stale-fallback lookup: hot tier first (<0.1ms), then the durable
 * SQLite mirror (survives restarts). Also hydrates the hot tier on a hit.
 */
export async function getDurableLastKnownGood(
  contractId: string,
): Promise<Record<string, unknown> | null> {
  const hot = store.lastGoodByContract.get(contractId);
  if (hot) return hot;
  const row = await db.contract
    .findUnique({ where: { id: contractId }, select: { lastGoodJson: true } })
    .catch(() => null);
  if (!row?.lastGoodJson) return null;
  try {
    const parsed = JSON.parse(row.lastGoodJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    setLastKnownGoodHotOnly(contractId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function putHotPatch(
  contractId: string,
  signature: string,
  plan: HealPlan,
  lastKnownGood: Record<string, unknown>,
): HotPatchEntry {
  const now = Date.now();
  const entry: HotPatchEntry = {
    signature,
    contractId,
    plan,
    lastKnownGood: structuredClone(lastKnownGood),
    createdAt: now,
    ttlAt: now + TTL_HOURS * 3600_000,
    hits: 0,
  };
  store.bySignature.set(signature, entry);
  return entry;
}

export function getHotPatch(signature: string): HotPatchEntry | undefined {
  const e = store.bySignature.get(signature);
  if (!e) return undefined;
  if (Date.now() > e.ttlAt) {
    store.bySignature.delete(signature); // 24h TTL circuit breaker
    return undefined;
  }
  e.hits++;
  return e;
}

export function dropHotPatch(signature: string): void {
  store.bySignature.delete(signature);
}

/** Purge every in-memory trace of a contract (hot patches + last-known-good). */
export function purgeContractMemory(contractId: string): void {
  for (const [sig, e] of store.bySignature) {
    if (e.contractId === contractId) store.bySignature.delete(sig);
  }
  store.lastGoodByContract.delete(contractId);
  const t = lkgTimers().get(contractId);
  if (t) {
    clearTimeout(t);
    lkgTimers().delete(contractId);
  }
}

export function listHotPatches(): HotPatchEntry[] {
  const now = Date.now();
  const out: HotPatchEntry[] = [];
  for (const [sig, e] of store.bySignature) {
    if (now > e.ttlAt) store.bySignature.delete(sig);
    else out.push(e);
  }
  return out;
}

export function remainingTtlMs(entry: HotPatchEntry): number {
  return Math.max(0, entry.ttlAt - Date.now());
}

// ─── COLD tier · SQLite fingerprint store ──────────────────────────────────

export interface FingerprintHit {
  plan: HealPlan;
  hits: number;
  id: string;
}

/** 0.8ms path: SHA-256 signature → verified plan (SQLite indexed lookup). */
export async function lookupFingerprint(signature: string): Promise<FingerprintHit | null> {
  const row = await db.fingerprint.findUnique({
    where: { signature },
    select: { id: true, planJson: true, hits: true, status: true, ttlAt: true },
  });
  if (!row) return null;
  if (row.status !== 'ACTIVE' || row.ttlAt.getTime() < Date.now()) return null;
  // fire-and-forget hit counter (do not block the hot path)
  void db.fingerprint
    .update({ where: { id: row.id }, data: { hits: { increment: 1 } } })
    .catch(() => undefined);
  return { id: row.id, plan: JSON.parse(row.planJson) as HealPlan, hits: row.hits + 1 };
}

/** Persist a gate-verified plan as a fingerprint (called after cold heal). */
export async function saveFingerprint(params: {
  contractId: string;
  signature: string;
  plan: HealPlan;
  opsSummary: string;
}): Promise<void> {
  const ttlAt = new Date(Date.now() + TTL_HOURS * 3600_000);
  await db.fingerprint.upsert({
    where: { signature: params.signature },
    create: {
      contractId: params.contractId,
      signature: params.signature,
      planJson: JSON.stringify(params.plan),
      opsSummary: params.opsSummary,
      confidence: params.plan.confidence,
      ttlAt,
      status: 'ACTIVE',
    },
    update: {
      planJson: JSON.stringify(params.plan),
      opsSummary: params.opsSummary,
      confidence: params.plan.confidence,
      ttlAt,
      status: 'ACTIVE',
      resolvedAt: null,
    },
  });
}

/** TTL sweeper: expire fingerprints past their 24h bridge. */
export async function sweepExpiredFingerprints(): Promise<number> {
  const res = await db.fingerprint.updateMany({
    where: { status: 'ACTIVE', ttlAt: { lt: new Date() } },
    data: { status: 'EXPIRED', resolvedAt: new Date() },
  });
  for (const [sig, e] of store.bySignature) {
    if (Date.now() > e.ttlAt) store.bySignature.delete(sig);
  }
  return res.count;
}

/** Full in-process memory reset (operator controls / test harness). */
export function resetMemoryTier(): void {
  store.bySignature.clear();
  store.lastGoodByContract.clear();
}
