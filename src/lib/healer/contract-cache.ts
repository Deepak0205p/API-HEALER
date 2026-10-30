/**
 * API-HEALER · Runtime Contract Cache (the <0.3ms healthy-path enabler)
 * ----------------------------------------------------------------------
 * Spec: "If zodContract.safeParse(payload).success === true … Do NOT clone,
 * buffer, or write to SQLite on healthy calls. Overhead must be <0.3ms."
 *
 * Before this cache every healRequest paid a Prisma SELECT (contract row)
 * plus — worse — a DriftEvent INSERT and a historyJson UPDATE on EVERY
 * healthy call. Now:
 *
 *   • Contract metadata (def/mandatory/defaults) is parsed once and served
 *     from an in-process Map (<0.01ms), revalidated against the row every
 *     30s so operator edits (pause, schema change) land within one window —
 *     and instantly via invalidateContractCache() from the CRUD API.
 *   • Rolling numeric history is the AUTHORITATIVE in-memory copy, learned
 *     on the hot path with zero SQLite traffic, and flushed write-behind
 *     (debounced) so a process crash costs at most one debounce window of
 *     statistical samples — never a transaction.
 *   • The durable Last-Known-Good payload hydrates the hot tier on first
 *     touch, so Track A stale-fallback survives process restarts.
 *
 * globalThis singleton: Next.js dev bundles each route chunk separately —
 * a plain module const would hand /api/heal and /api/metrics different
 * caches and the dashboard would lie.
 */
import { db } from '@/lib/db';
import type { ContractDef, HistoryMap } from './types';
import { parseContractDef } from './contract';
import { setLastKnownGoodHotOnly } from './memory';

/** Revalidation window for operator edits made outside the CRUD API. */
const REVALIDATE_MS = 30_000;
/** Trailing debounce for write-behind history flushes. */
const HISTORY_FLUSH_DEBOUNCE_MS = 1_500;
/** Hard cap on cached contracts (LRU-ish eviction keeps memory bounded). */
const MAX_CACHED = 500;

export interface ContractRuntime {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  contractDef: ContractDef;
  mandatory: string[];
  defaults: Record<string, unknown>;
  /** Authoritative rolling numeric history (write-behind to SQLite). */
  history: HistoryMap;
  /** History changed since the last durable flush. */
  dirty: boolean;
  /** DB row updatedAt (ms) at load — change detection for revalidation. */
  rowUpdatedAt: number;
  /** Last revalidation timestamp (ms). */
  loadedAt: number;
}

interface ContractCacheState {
  map: Map<string, ContractRuntime>;
  inFlight: Map<string, Promise<ContractRuntime | null>>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  dirtyIds: Set<string>;
}

const globalForCache = globalThis as unknown as {
  __apiHealerContractCache?: ContractCacheState;
};

function state(): ContractCacheState {
  if (!globalForCache.__apiHealerContractCache) {
    globalForCache.__apiHealerContractCache = {
      map: new Map(),
      inFlight: new Map(),
      flushTimer: null,
      dirtyIds: new Set(),
    };
  }
  if (!globalForCache.__apiHealerContractCache.inFlight) {
    globalForCache.__apiHealerContractCache.inFlight = new Map();
  }
  return globalForCache.__apiHealerContractCache;
}

function parseRow(
  row: {
    id: string;
    name: string;
    endpoint: string;
    enabled: boolean;
    schemaJson: string;
    mandatoryJson: string;
    defaultsJson: string;
    historyJson: string;
    updatedAt: Date;
    lastGoodJson: string | null;
  },
): ContractRuntime | null {
  try {
    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      enabled: row.enabled,
      contractDef: parseContractDef(row.schemaJson),
      mandatory: JSON.parse(row.mandatoryJson) as string[],
      defaults: JSON.parse(row.defaultsJson) as Record<string, unknown>,
      history: JSON.parse(row.historyJson) as HistoryMap,
      dirty: false,
      rowUpdatedAt: row.updatedAt.getTime(),
      loadedAt: Date.now(),
    };
  } catch {
    return null; // corrupt row — engine reports ERROR honestly
  }
}

const ROW_SELECT = {
  id: true,
  name: true,
  endpoint: true,
  enabled: true,
  schemaJson: true,
  mandatoryJson: true,
  defaultsJson: true,
  historyJson: true,
  updatedAt: true,
  lastGoodJson: true,
} as const;

/**
 * The engine's contract loader. Cache-first; hydrates the durable LKG into
 * the hot tier on first touch. Returns null when the contract does not
 * exist (engine reports ERROR) or its row is corrupt.
 */
export async function getContractRuntime(
  contractId: string,
): Promise<ContractRuntime | null> {
  const s = state();
  const cached = s.map.get(contractId);

  const needsRevalidate =
    !cached || Date.now() - cached.loadedAt > REVALIDATE_MS;
  if (cached && !needsRevalidate) return cached;

  const existingFlight = s.inFlight.get(contractId);
  if (existingFlight) return existingFlight;

  const loadPromise = (async (): Promise<ContractRuntime | null> => {
    try {
      const row = await db.contract
        .findUnique({ where: { id: contractId }, select: ROW_SELECT })
        .catch(() => null);

      if (!row) {
        s.map.delete(contractId);
        return null;
      }

      if (!cached) {
        const fresh = parseRow(row);
        if (!fresh) return null;
        if (row.lastGoodJson) {
          try {
            const lkg = JSON.parse(row.lastGoodJson) as Record<string, unknown>;
            if (lkg && typeof lkg === 'object') setLastKnownGoodHotOnly(contractId, lkg);
          } catch {
            // corrupt LKG — the hot tier simply stays empty
          }
        }
        if (s.map.size >= MAX_CACHED) {
          const oldest = s.map.keys().next().value;
          if (oldest !== undefined) s.map.delete(oldest);
        }
        s.map.set(contractId, fresh);
        return fresh;
      }

      const refreshed = parseRow(row);
      if (!refreshed) return cached;
      const preservedHistory = cached.history;
      const preservedDirty = cached.dirty;
      const merged: ContractRuntime = {
        ...refreshed,
        history: Object.keys(preservedHistory).length > 0 ? preservedHistory : refreshed.history,
        dirty: preservedDirty,
      };
      s.map.set(contractId, merged);
      return merged;
    } finally {
      s.inFlight.delete(contractId);
    }
  })();

  s.inFlight.set(contractId, loadPromise);
  return loadPromise;
}

/**
 * Learn a payload's numeric leaves into the contract's authoritative history.
 * Pure in-memory (<0.05ms typical) — the durable flush is debounced.
 */
export function learnHistory(rt: ContractRuntime, payload: Record<string, unknown>): void {
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' && Number.isFinite(v)) {
        const arr = rt.history[path] ?? [];
        arr.push(v);
        rt.history[path] = arr.slice(-50);
      } else if (v !== null && typeof v === 'object') {
        walk(v as Record<string, unknown>, path);
      }
    }
  };
  walk(payload, '');
  rt.dirty = true;
  scheduleHistoryFlush(rt.id);
}

function scheduleHistoryFlush(contractId: string): void {
  const s = state();
  s.dirtyIds.add(contractId);
  if (s.flushTimer) return; // trailing debounce already armed
  s.flushTimer = setTimeout(() => {
    s.flushTimer = null;
    void flushDirtyHistories().catch(() => undefined);
  }, HISTORY_FLUSH_DEBOUNCE_MS);
}

/** Persist every dirty history map to SQLite (fire-and-forget safe). */
async function flushDirtyHistories(): Promise<void> {
  const s = state();
  const ids = [...s.dirtyIds];
  s.dirtyIds.clear();
  for (const id of ids) {
    const rt = s.map.get(id);
    if (!rt || !rt.dirty) continue;
    await db.contract
      .update({
        where: { id },
        data: { historyJson: JSON.stringify(rt.history) },
      })
      .then(() => {
        rt.dirty = false;
      })
      .catch(() => undefined);
  }
}

/** Force-flush one contract's history (cold-path workers / tests / shutdown). */
export async function flushContractHistory(contractId: string): Promise<void> {
  const s = state();
  const rt = s.map.get(contractId);
  if (rt?.dirty) {
    await db.contract
      .update({ where: { id: contractId }, data: { historyJson: JSON.stringify(rt.history) } })
      .then(() => {
        rt.dirty = false;
      })
      .catch(() => undefined);
  }
  s.dirtyIds.delete(contractId);
}

/** Force-flush every cached contract's history. */
export async function flushAllContractCaches(): Promise<void> {
  const s = state();
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  await flushDirtyHistories();
}

/**
 * Drop cached entries (one or all). Called by the contract CRUD API and
 * /api/reset so operator edits are visible to the hot path immediately.
 */
export function invalidateContractCache(contractId?: string): void {
  const s = state();
  if (contractId) {
    s.map.delete(contractId);
    s.dirtyIds.delete(contractId);
  } else {
    s.map.clear();
    s.dirtyIds.clear();
  }
}

/** Introspection for metrics/tests. */
export function contractCacheStats(): { entries: number; dirty: number } {
  const s = state();
  return {
    entries: s.map.size,
    dirty: [...s.map.values()].filter((e) => e.dirty).length,
  };
}
