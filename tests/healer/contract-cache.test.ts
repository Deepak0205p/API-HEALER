/**
 * API-HEALER · Runtime Contract Cache tests
 * ------------------------------------------
 * The <0.3ms healthy path depends on this cache: contract metadata served
 * from memory, history learned in-memory with write-behind durability, and
 * operator edits (pause/resume/reset/delete) visible instantly via
 * invalidation — not just on the 30s revalidation window.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@/lib/db';
import {
  getContractRuntime,
  learnHistory,
  flushContractHistory,
  invalidateContractCache,
  contractCacheStats,
  type ContractRuntime,
} from '@/lib/healer/contract-cache';
import { purgeContractMemory, resetMemoryTier } from '@/lib/healer/memory';

const CONTRACT_ID = 'test-contract-cache';

async function makeContract(overrides: Record<string, unknown> = {}) {
  await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
  await db.contract.create({
    data: {
      id: CONTRACT_ID,
      name: 'cache test',
      endpoint: 'https://upstream.test/v1/cache',
      method: 'POST',
      schemaJson: JSON.stringify({
        fields: {
          orderId: { type: 'string', mandatory: true },
          amount: { type: 'number', mandatory: true },
        },
      }),
      mandatoryJson: JSON.stringify(['orderId', 'amount']),
      historyJson: JSON.stringify({ amount: [499] }),
      ...overrides,
    },
  });
  invalidateContractCache(CONTRACT_ID);
}

beforeAll(makeContract);

afterAll(async () => {
  await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
  invalidateContractCache(CONTRACT_ID);
  purgeContractMemory(CONTRACT_ID);
});

describe('contract runtime cache', () => {
  test('loads and parses the contract (def, mandatory, history)', async () => {
    const rt = await getContractRuntime(CONTRACT_ID);
    expect(rt).not.toBeNull();
    expect(rt!.contractDef.fields.orderId.type).toBe('string');
    expect(rt!.mandatory).toEqual(['orderId', 'amount']);
    expect(rt!.history.amount).toEqual([499]);
    expect(rt!.enabled).toBe(true);
  });

  test('second read is the SAME cached object (zero Prisma on the hot path)', async () => {
    const a = await getContractRuntime(CONTRACT_ID);
    const b = await getContractRuntime(CONTRACT_ID);
    expect(b).toBe(a); // reference identity — cache hit, no row reload
  });

  test('learnHistory mutates in-memory and flushContractHistory persists', async () => {
    const rt = (await getContractRuntime(CONTRACT_ID)) as ContractRuntime;
    learnHistory(rt, { orderId: 'O-1', amount: 512 });
    expect(rt.history.amount).toEqual([499, 512]);
    expect(rt.dirty).toBe(true);

    // DB not yet written (write-behind)
    const rowBefore = await db.contract.findUnique({ where: { id: CONTRACT_ID } });
    expect(JSON.parse(rowBefore!.historyJson)).toEqual({ amount: [499] });

    await flushContractHistory(CONTRACT_ID);
    const rowAfter = await db.contract.findUnique({ where: { id: CONTRACT_ID } });
    expect(JSON.parse(rowAfter!.historyJson)).toEqual({ amount: [499, 512] });
    expect((await getContractRuntime(CONTRACT_ID))?.dirty).toBe(false);
  });

  test('operator pause via PATCH-invalidation reaches the hot path immediately', async () => {
    await db.contract.update({ where: { id: CONTRACT_ID }, data: { enabled: false } });
    // without invalidation the cached copy is still enabled (revalidate window)
    expect((await getContractRuntime(CONTRACT_ID))?.enabled).toBe(true);
    // the CRUD API calls this — simulating it:
    invalidateContractCache(CONTRACT_ID);
    expect((await getContractRuntime(CONTRACT_ID))?.enabled).toBe(false);
    // restore
    await db.contract.update({ where: { id: CONTRACT_ID }, data: { enabled: true } });
    invalidateContractCache(CONTRACT_ID);
  });

  test('durable last-known-good hydrates the hot tier on first cache load', async () => {
    resetMemoryTier(); // hot tier empty (fresh process simulation)
    await db.contract.update({
      where: { id: CONTRACT_ID },
      data: { lastGoodJson: JSON.stringify({ orderId: 'O-9', amount: 499 }) },
    });
    invalidateContractCache(CONTRACT_ID);

    const rt = await getContractRuntime(CONTRACT_ID);
    expect(rt).not.toBeNull();
    // hydration happened as a side effect of the cache load
    const lkg = (await import('@/lib/healer/memory')).getLastKnownGood(CONTRACT_ID);
    expect(lkg).toEqual({ orderId: 'O-9', amount: 499 });
  });

  test('cache eviction on delete: getContractRuntime returns null', async () => {
    await makeContract();
    expect(await getContractRuntime(CONTRACT_ID)).not.toBeNull();
    await db.contract.delete({ where: { id: CONTRACT_ID } });
    invalidateContractCache(CONTRACT_ID);
    expect(await getContractRuntime(CONTRACT_ID)).toBeNull();
    await makeContract(); // restore for afterAll ordering
  });

  test('contractCacheStats reflects entries', async () => {
    await getContractRuntime(CONTRACT_ID);
    expect(contractCacheStats().entries).toBeGreaterThanOrEqual(1);
  });
});
