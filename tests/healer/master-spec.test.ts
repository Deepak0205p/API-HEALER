/**
 * API-HEALER · MASTER SPEC integration suite (the five contractual proofs)
 * --------------------------------------------------------------------------
 * Spec §6 "Deliverables & Verification":
 *   1. Healthy call passthrough (<0.3ms)                       → scenario 1
 *   2. Unannounced 200 OK drift healing (<650ms cold, cached)  → scenario 2
 *   3. 50 concurrent breaking calls sharing 1 synthesis        → scenario 3
 *   4. The 100x Paise bug rejected in <2ms                     → scenario 4
 *   5. GitHub PR dispatched with 24-Hour TTL expiration        → scenario 5
 *
 * Everything runs against the real engine + real SQLite (Prisma), in-process.
 * Contracts are created per scenario and removed afterwards; the DB is left
 * as pristine as it was found (zero residue — the tool stays 100% user-owned).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { performance } from 'perf_hooks';
import { db } from '@/lib/db';
import { healRequest, planFlightStats } from '@/lib/healer/engine';
import { healerFetch } from '@/lib/healer/healerFetch';
import { flushHealWrites } from '@/lib/healer/audit';
import {
  invalidateContractCache,
  flushContractHistory,
  getContractRuntime,
  contractCacheStats,
} from '@/lib/healer/contract-cache';
import {
  resetMemoryTier,
  purgeContractMemory,
  flushAllLastKnownGood,
} from '@/lib/healer/memory';
import { resetBreakers } from '@/lib/healer/breaker';
import { resetRuntimeCounters, runtimeCounters } from '@/lib/healer/counters';
import { resetOutboundCache } from '@/lib/healer/outbound';
import { drainQueue } from '@/lib/jobs/queue';

const CHECKOUT_DEF = {
  fields: {
    orderId: { type: 'string', mandatory: true },
    amount: { type: 'number', mandatory: true, unit: 'INR' },
    currency: { type: 'string', mandatory: true },
    paymentMethod: { type: 'string' },
  },
};
const MANDATORY = ['orderId', 'amount', 'currency'];

const CONTRACTS: Record<string, string> = {
  s1: 'test-spec-s1-passthrough',
  s2: 'test-spec-s2-coldheal',
  s3: 'test-spec-s3-thundering',
  s4a: 'test-spec-s4-coldstart',
  s4b: 'test-spec-s4-sigma',
  s5: 'test-spec-s5-pr',
};

async function makeContract(id: string, historyJson = '{}') {
  await db.contract.delete({ where: { id } }).catch(() => undefined);
  await db.contract.create({
    data: {
      id,
      name: `spec-${id}`,
      endpoint: `https://upstream.test/v1/${id}`,
      method: 'POST',
      schemaJson: JSON.stringify(CHECKOUT_DEF),
      mandatoryJson: JSON.stringify(MANDATORY),
      historyJson,
    },
  });
  invalidateContractCache(id);
  purgeContractMemory(id);
}

async function dropContract(id: string) {
  await flushContractHistory(id).catch(() => undefined);
  await db.contract.delete({ where: { id } }).catch(() => undefined);
  invalidateContractCache(id);
  purgeContractMemory(id);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function timedHeal(contractId: string, payload: Record<string, unknown>, allowLlm = false) {
  const t0 = performance.now();
  const r = await healRequest({ contractId, payload, allowLlm });
  return { r, wallMs: performance.now() - t0 };
}

/** Poll until fn() truthy or timeout (ms). */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 15_000, everyMs = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

beforeAll(() => {
  // Hermetic bus: no socket.io client may keep the process alive or leak out.
  (globalThis as unknown as Record<string, unknown>).__apiHealerBus = {
    socket: { connected: false, emit: () => undefined },
    connecting: true,
    buffer: [],
  };
  delete process.env.GITHUB_TOKEN; // deterministic DRY_RUN PR artifacts
});

afterAll(async () => {
  for (const id of Object.values(CONTRACTS)) await dropContract(id);
  await flushHealWrites();
  await db.jobRun.deleteMany({}).catch(() => undefined);
  resetMemoryTier();
  resetBreakers();
  resetRuntimeCounters();
  resetOutboundCache();
});

// ─── Scenario 1 · Healthy call passthrough (<0.3ms) ───────────────────────

describe('spec 1 · healthy passthrough', () => {
  test('zero-copy fast path: no SQLite writes, <0.3ms warm, upstream identity', async () => {
    await makeContract(CONTRACTS.s1);
    const healthy = { orderId: 'TXN-1', amount: 499, currency: 'INR', paymentMethod: 'UPI' };

    // warm-up: JIT + contract cache population
    for (let i = 0; i < 5; i++) {
      await healRequest({ contractId: CONTRACTS.s1, payload: healthy, allowLlm: false });
    }
    await flushHealWrites();

    const eventsBefore = await db.driftEvent.count({ where: { contractId: CONTRACTS.s1 } });
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const { r, wallMs } = await timedHeal(CONTRACTS.s1, healthy);
      expect(r.status).toBe('PASSTHROUGH');
      times.push(wallMs);
    }
    await flushHealWrites();

    const med = Math.round(median(times) * 1000) / 1000;
    console.log(`    [spec-1] healthy passthrough: median ${med}ms over 30 warm calls (budget 0.3ms)`);
    expect(med).toBeLessThan(0.3);

    // SPEC: "Do NOT clone, buffer, or write to SQLite on healthy calls"
    const eventsAfter = await db.driftEvent.count({ where: { contractId: CONTRACTS.s1 } });
    expect(eventsAfter).toBe(eventsBefore); // zero audit rows for healthy traffic
    expect(runtimeCounters().passthrough).toBeGreaterThanOrEqual(35); // counted in memory

    // History IS learned — but write-behind (in-memory), not per-call SQLite
    const rt = await getContractRuntime(CONTRACTS.s1);
    expect(rt?.history.amount.length).toBeGreaterThanOrEqual(35);
    expect(rt?.dirty).toBe(true);
    const row = await db.contract.findUnique({ where: { id: CONTRACTS.s1 } });
    const persistedHistory = JSON.parse(row!.historyJson) as Record<string, number[]>;
    expect(persistedHistory.amount ?? []).toHaveLength(0); // not yet flushed — write-behind

    // healerFetch returns the pristine upstream Response object by identity
    const originalFetch = globalThis.fetch;
    const upstreamRef = new Response(JSON.stringify(healthy), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    globalThis.fetch = (async () => upstreamRef) as typeof fetch;
    try {
      const res = await healerFetch(
        'https://upstream.test/v1/checkout',
        { method: 'POST' },
        { contractId: CONTRACTS.s1 },
      );
      expect(res).toBe(upstreamRef); // same object — zero reconstruction
      expect(res.__healer?.status).toBe('PASSTHROUGH');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── Scenario 2 · Unannounced 200 OK drift (<650ms cold, cached fast) ─────

describe('spec 2 · cold heal + cached re-heal', () => {
  test('novel RENAME drift healed cold <650ms; cached re-heal <0.8ms hot tier', async () => {
    await makeContract(CONTRACTS.s2, JSON.stringify({ amount: [499, 509, 519] }));

    // COLD — never-seen drift, deterministic tier, full budget check
    const drifted = { order_ref: 'TXN-2', amount: 515, currency: 'INR', paymentMethod: 'UPI' };
    const cold = await timedHeal(CONTRACTS.s2, drifted);
    expect(cold.r.status).toBe('HEALED_COLD');
    expect(cold.r.servedPayload).toEqual({
      orderId: 'TXN-2',
      amount: 515,
      currency: 'INR',
      paymentMethod: 'UPI',
    });
    console.log(`    [spec-2] cold heal: ${cold.wallMs.toFixed(2)}ms (budget 650ms)`);
    expect(cold.wallMs).toBeLessThan(650);

    // HOT-TIER CACHED — same signature again: hot patch hit, no LLM, no compose
    const cachedTimes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { r, wallMs } = await timedHeal(CONTRACTS.s2, drifted);
      expect(r.status).toBe('HEALED_CACHED');
      cachedTimes.push(wallMs);
    }
    const cachedMed = Math.round(median(cachedTimes) * 1000) / 1000;
    console.log(`    [spec-2] cached re-heal (hot tier): median ${cachedMed}ms (budget 0.8ms)`);
    expect(cachedMed).toBeLessThan(0.8);

    // SQLITE CACHED — simulate process restart: hot tier empty, fingerprint
    // lookup must resolve from the durable store. Reported honestly.
    resetMemoryTier();
    invalidateContractCache(CONTRACTS.s2);
    const sqlite = await timedHeal(CONTRACTS.s2, drifted);
    expect(sqlite.r.status).toBe('HEALED_CACHED');
    expect(sqlite.r.composer).toBe('cache');
    console.log(`    [spec-2] cached re-heal (SQLite fingerprint tier): ${sqlite.wallMs.toFixed(2)}ms — durable tier, measured honestly`);
    expect(sqlite.wallMs).toBeLessThan(50); // regression guard; hot tier is the steady-state 0.8ms path

    // teardown now: later scenarios must not fleet-inherit this drift shape
    await dropContract(CONTRACTS.s2);
  });
});

// ─── Scenario 3 · 50 concurrent breaking calls → 1 synthesis ─────────────

describe('spec 3 · single-flight under thundering herd', () => {
  test('50 concurrent identical drifts share exactly ONE composePlan + ONE PR', async () => {
    await makeContract(CONTRACTS.s3, JSON.stringify({ amount: [499, 509, 519] }));

    const statsBefore = planFlightStats();
    // structurally-unique drift (TYPE on currency) — no fleet fingerprint can
    // pre-empt the synthesis, so the burst MUST go through single-flight
    const drifted = { orderId: 'TXN-3', amount: 525, currency: 356, paymentMethod: 'UPI' };

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        healRequest({ contractId: CONTRACTS.s3, payload: drifted, allowLlm: false }),
      ),
    );

    // every one of the 50 got healed with the correct payload
    for (const r of results) {
      expect(['HEALED_COLD', 'HEALED_CACHED']).toContain(r.status);
      expect(r.servedPayload).toEqual({
        orderId: 'TXN-3',
        amount: 525,
        currency: '356',
        paymentMethod: 'UPI',
      });
    }

    // exactly ONE leader synthesis for the whole burst
    const statsAfter = planFlightStats();
    expect(statsAfter.leadersTotal - statsBefore.leadersTotal).toBe(1);
    expect(statsAfter.inheritedTotal - statsBefore.inheritedTotal).toBe(49);

    // and the cold path is NOT stampeded: exactly ONE PR for this signature
    await flushHealWrites();
    const pr = await waitFor(
      async () => {
        await drainQueue();
        return db.pullRequest.count({ where: { contractId: CONTRACTS.s3 } });
      },
      15_000,
    ).then((n) => n);
    expect(pr).toBe(1);
    console.log(
      `    [spec-3] 50 concurrent → 1 leader, 49 inherited, ${pr} PR (no PR-bot stampede)`,
    );
    await dropContract(CONTRACTS.s3);
  });
});

// ─── Scenario 4 · The 100× Paise bug rejected <2ms ────────────────────────

describe('spec 4 · 100× paise bug', () => {
  test('cold-start regime (1 baseline sample): 499 → 49900 vetoed <2ms, history NOT poisoned', async () => {
    await makeContract(CONTRACTS.s4a, JSON.stringify({ amount: [499] })); // single baseline
    resetBreakers();
    // steady-state measurement: warm the runtime cache first (the 2:00 AM
    // break hits a WARM contract in production, not a cold Prisma read)
    const warm = await healRequest({
      contractId: CONTRACTS.s4a,
      payload: { orderId: 'TXN-W', amount: 501, currency: 'INR' },
      allowLlm: false,
    });
    expect(warm.status).toBe('PASSTHROUGH');
    const { r, wallMs } = await timedHeal(CONTRACTS.s4a, {
      orderId: 'TXN-4',
      amount: 49900, // the classic Rupees→Paise 100× bug
      currency: 'INR',
    });
    expect(r.status).toBe('ROLLED_BACK');
    expect(r.message).toContain('Cold-start magnitude anomaly');
    console.log(`    [spec-4] cold-start veto wall: ${wallMs.toFixed(2)}ms (budget 2ms)`);
    expect(wallMs).toBeLessThan(2);

    // no-poisoning guarantee: the spiked value never enters the baseline
    // (baseline [499] + warmed 501 only — 49900 quarantined)
    const rt = await getContractRuntime(CONTRACTS.s4a);
    expect(rt?.history.amount).toEqual([499, 501]);
  });

  test('statistical regime (≥3 samples): 4.5σ veto <2ms', async () => {
    await makeContract(
      CONTRACTS.s4b,
      JSON.stringify({ amount: [429, 499, 549, 649, 399, 799, 459, 899, 499, 599] }),
    );
    resetBreakers();
    // warm the cache (steady-state), then strike
    await healRequest({
      contractId: CONTRACTS.s4b,
      payload: { orderId: 'TXN-W', amount: 505, currency: 'INR' },
      allowLlm: false,
    });
    const { r, wallMs } = await timedHeal(CONTRACTS.s4b, {
      orderId: 'TXN-5',
      amount: 49900,
      currency: 'INR',
    });
    expect(r.status).toBe('ROLLED_BACK');
    expect(r.message).toContain('deviates');
    console.log(`    [spec-4] 4.5σ veto wall: ${wallMs.toFixed(2)}ms (budget 2ms)`);
    expect(wallMs).toBeLessThan(2);
    await dropContract(CONTRACTS.s4a);
    await dropContract(CONTRACTS.s4b);
  });
});

// ─── Scenario 5 · PR dispatched with 24-hour TTL ──────────────────────────

describe('spec 5 · automated PR + 24h TTL', () => {
  test('canary-proven PR artifact carries classification, telemetry badge, 24h warning, ~24h fingerprint TTL', async () => {
    await makeContract(CONTRACTS.s5, JSON.stringify({ amount: [499, 509, 519] }));

    // structurally-unique drift (RENAME payment_method) — no fleet inheritance
    const drifted = { orderId: 'TXN-6', amount: 533, currency: 'INR', payment_method: 'UPI' };
    const heal = await healRequest({
      contractId: CONTRACTS.s5,
      payload: drifted,
      allowLlm: false,
      callsite: 'services/checkout.ts:42',
    });
    expect(heal.status).toBe('HEALED_COLD');

    // fingerprint: ACTIVE with a strict ~24h TTL bridge
    const fpRow = await waitFor(async () => {
      await drainQueue();
      return db.fingerprint.findFirst({
        where: { contractId: CONTRACTS.s5, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
      });
    });
    expect(fpRow).not.toBeNull();
    const fp = fpRow!;
    const ttlHours = (fp.ttlAt.getTime() - Date.now()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.9);
    expect(ttlHours).toBeLessThan(24.1);
    console.log(`    [spec-5] fingerprint TTL: ${ttlHours.toFixed(3)}h (strict 24h bridge)`);

    // PR artifact (DRY_RUN without GITHUB_TOKEN — identical artifact offline)
    const prRow = await waitFor(async () => {
      await drainQueue();
      return db.pullRequest.findFirst({
        where: { contractId: CONTRACTS.s5 },
        orderBy: { createdAt: 'desc' },
      });
    });
    expect(prRow).not.toBeNull();
    const pr = prRow!;
    expect(pr.mode).toBe('DRY_RUN');
    expect(pr.branch).toMatch(/^api-healer\/spec-/);
    const body: string = pr.body ?? '';
    expect(body).toContain('### Drift classification');
    expect(body).toContain('| contract path |');
    expect(body).toContain('paymentMethod'); // the drifted path in the table
    expect(body).toContain('RENAME');        // the classification
    expect(body).toContain('### Canary verification');
    expect(body).toContain('img.shields.io/badge/z--score_guard'); // Z-Score telemetry badge
    expect(body).toContain('This runtime adapter will expire in 24 hours');
    expect(body).toContain('Merge this PR to make the fix permanent');
    expect(body).toContain('services/checkout.ts:42'); // blast radius
    expect(body).toContain('### Suggested permanent repair');
    expect((pr.diffText ?? '')).toContain('contracts/spec-'); // typed plan artifact

    // canary verdict lands on the originating event (Loop 2 closes)
    const ev = await db.driftEvent.findFirst({
      where: { contractId: CONTRACTS.s5, signature: heal.signature },
      orderBy: { createdAt: 'desc' },
    });
    expect(ev?.canaryPassed).toBe(true);
    console.log(`    [spec-5] PR #${pr.number} (${pr.mode}) with classification table, σ badge, 24h warning; canary passed`);
  });
});
