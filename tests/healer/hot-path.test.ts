/**
 * Hot-path optimization tests.
 *
 * A) healerFetch: PASSTHROUGH must return the ORIGINAL upstream Response
 *    object (reference identity) — zero body reconstruction. Drifted
 *    traffic must be reconstructed with heal telemetry headers.
 * B) composer: a hung LLM provider must be cut at the 650ms ceiling and
 *    composePlan must fall back seamlessly to the deterministic plan.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { db } from '@/lib/db';
import { healerFetch } from '@/lib/healer/healerFetch';
import { composePlan, composeWithLlm, LLM_TIMEOUT_MS } from '@/lib/healer/composer';
import type { ComposeInput } from '@/lib/healer/composer';
import type { Classification, ContractDef } from '@/lib/healer/types';
import { purgeContractMemory } from '@/lib/healer/memory';
import { resetBreakers } from '@/lib/healer/breaker';

// ─── A · healerFetch passthrough identity ───────────────────────────────────

const CONTRACT_ID = 'test-hotpath-contract';
const CONTRACT_DEF: ContractDef = {
  fields: {
    orderId: { type: 'string', mandatory: true },
    amount: { type: 'number', mandatory: true },
  },
};

const originalFetch = globalThis.fetch;
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await db.contract.delete({ where: { id: CONTRACT_ID } }).catch(() => undefined);
  purgeContractMemory(CONTRACT_ID);
  resetBreakers();
});

describe('healerFetch hot path', () => {
  test('PASSTHROUGH returns the pristine upstream Response object (no reconstruction)', async () => {
    await db.contract.create({
      data: {
        id: CONTRACT_ID,
        name: 'hot-path test',
        endpoint: 'https://upstream.test/v1/orders',
        method: 'POST',
        schemaJson: JSON.stringify(CONTRACT_DEF),
        mandatoryJson: JSON.stringify(['orderId', 'amount']),
        defaultsJson: '{}',
        historyJson: '{}',
      },
    });

    const healthy = { orderId: 'TXN-1', amount: 499 };
    const upstreamRef = jsonResponse(healthy);
    globalThis.fetch = (async () => upstreamRef) as typeof fetch;

    const res = await healerFetch(
      'https://upstream.test/v1/orders',
      { method: 'POST' },
      { contractId: CONTRACT_ID },
    );

    // THE assertion: same object identity — zero clone/rebuild on healthy traffic
    expect(res).toBe(upstreamRef);
    expect(res.__healer?.status).toBe('PASSTHROUGH');
    // the original body stream was never consumed by the firewall
    expect(await res.json()).toEqual(healthy);
  });

  test('drifted traffic is reconstructed with telemetry headers', async () => {
    const upstreamRef = jsonResponse({ order_ref: 'TXN-2', amount: 499 });
    globalThis.fetch = (async () => upstreamRef) as typeof fetch;

    const res = await healerFetch(
      'https://upstream.test/v1/orders',
      { method: 'POST' },
      { contractId: CONTRACT_ID },
    );

    expect(res).not.toBe(upstreamRef); // drifted ⇒ rebuilt
    expect(res.headers.get('x-api-healer-status')).toMatch(/^HEALED_/);
    expect(res.__healer?.servedPayload).toEqual({ orderId: 'TXN-2', amount: 499 });
    expect(await res.json()).toEqual({ orderId: 'TXN-2', amount: 499 });
  });
});

// ─── B · composer 650ms hard ceiling ────────────────────────────────────────

// Hung provider: the SDK promise never settles within the test's lifetime.
mock.module('z-ai-web-dev-sdk', () => ({
  default: {
    create: async () => ({
      chat: {
        completions: {
          create: async () => {
            await new Promise(() => undefined); // never resolves — provider outage
          },
        },
      },
    }),
  },
}));

function escalateInput(): ComposeInput {
  const classification: Classification = {
    driftType: 'MOVE',
    findings: [
      {
        type: 'MOVE',
        path: 'status',
        meta: { candidatePath: 'state', strength: 'fuzzy', candidates: ['state'], ambiguous: false },
      },
    ],
    diffMs: 0.1,
  };
  return {
    payload: { state: 'SHIPPED' },
    contractDef: { fields: { status: { type: 'string', mandatory: true } } },
    classification,
    defaults: {},
  };
}

describe('composer LLM hard timeout', () => {
  test('composeWithLlm rejects at the 650ms ceiling', async () => {
    expect(LLM_TIMEOUT_MS).toBe(650);
    const t0 = Date.now();
    expect(composeWithLlm(escalateInput())).rejects.toThrow(/timed out after 650ms/);
    const elapsed = await new Promise<number>((resolve) => {
      void composeWithLlm(escalateInput()).catch(() => undefined).finally(() => resolve(Date.now() - t0));
    });
    expect(elapsed).toBeGreaterThanOrEqual(640);
    expect(elapsed).toBeLessThan(2000); // hard wall, not 30s
  }, 10_000);

  test('composePlan falls back seamlessly to the deterministic plan', async () => {
    const t0 = Date.now();
    const out = await composePlan(escalateInput(), { allowLlm: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000); // cut at ~650ms, not hung
    expect(out.composer).toBe('deterministic'); // local heuristic plan, zero throw
    expect(out.plan?.ops[0]?.op).toBe('MOVE');
    expect(out.plan?.ops[0]).toEqual({ op: 'MOVE', from: 'state', to: 'status' });
  }, 10_000);
});
