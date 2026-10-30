/**
 * API-HEALER · Fleet immunity + circuit breaker + blast-radius test suite
 * Covers: structural (cross-endpoint) fingerprints · Step-9 breaker states ·
 * callsite parsing · AST repo scanner.
 */
import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { canonicalSignature, structuralSignature } from '../../src/lib/healer/memory';
import {
  checkBreaker,
  recordFailure,
  recordSuccess,
  resetBreakers,
} from '../../src/lib/healer/breaker';
import { parseCallsite } from '../../src/lib/healer/callsite';
import { scanBlastRadius } from '../../src/lib/healer/blast-radius';
import type { Classification } from '../../src/lib/healer/types';

const cls = (path: string, type: 'RENAME' | 'TYPE' | 'MISSING'): Classification => ({
  driftType: type,
  findings: [{ type, path, meta: { observedKey: 'x', expectedType: 'number' } }],
  diffMs: 0.5,
});

// ─── Step 4 · Fleet (structural) fingerprints ────────────────────────────────

describe('structural fleet signatures', () => {
  test('same structural drift on different contracts ⇒ ONE fleet signature', () => {
    const a = structuralSignature(cls('total', 'TYPE'));
    const b = structuralSignature(cls('total', 'TYPE'));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test('fleet signature differs from the contract-scoped canonical signature', () => {
    const canonical = canonicalSignature('contract-A', cls('total', 'TYPE'));
    const structural = structuralSignature(cls('total', 'TYPE'));
    expect(canonical).not.toBe(structural);
  });

  test('different drift classes ⇒ different fleet signatures', () => {
    expect(structuralSignature(cls('total', 'TYPE'))).not.toBe(
      structuralSignature(cls('total', 'RENAME')),
    );
  });

  test('different drifted paths ⇒ different fleet signatures', () => {
    expect(structuralSignature(cls('total', 'TYPE'))).not.toBe(
      structuralSignature(cls('amount', 'TYPE')),
    );
  });
});

// ─── Step 9 · Circuit breaker ───────────────────────────────────────────────

describe('circuit breaker', () => {
  test('starts CLOSED, trips OPEN after 3 consecutive failures', () => {
    resetBreakers();
    expect(checkBreaker('c1').state).toBe('CLOSED');
    recordFailure('c1', 'gate veto [CONFIDENCE]: low confidence');
    recordFailure('c1', 'gate veto [CONFIDENCE]: low confidence');
    const mid = checkBreaker('c1');
    expect(mid.state).toBe('CLOSED');
    expect(mid.failures).toBe(2);
    const snapped = recordFailure('c1', 'gate veto [SIGMA]: spike');
    expect(snapped.state).toBe('OPEN');
    expect(snapped.failures).toBe(3);
    expect(snapped.cooldownRemainingMs).toBeGreaterThan(55_000);
  });

  test('OPEN breaker transitions to HALF_OPEN after cooldown, trial fail re-opens with doubled cooldown', () => {
    resetBreakers();
    recordFailure('c2', 'canary failed: idempotence');
    recordFailure('c2', 'canary failed: idempotence');
    recordFailure('c2', 'canary failed: idempotence');
    expect(checkBreaker('c2').state).toBe('OPEN');

    // simulate cooldown elapse by rewinding openedAt on the global store
    const store = (globalThis as unknown as { __apiHealerBreakers: Map<string, { openedAt: number | null }> })
      .__apiHealerBreakers;
    const entry = store.get('c2');
    entry!.openedAt = Date.now() - 61_000;
    expect(checkBreaker('c2').state).toBe('HALF_OPEN');

    // trial fails → re-open, cooldown doubled 60s ⇒ 120s
    const reopened = recordFailure('c2', 'canary failed: strict-schema');
    expect(reopened.state).toBe('OPEN');
    expect(reopened.cooldownRemainingMs).toBeGreaterThan(110_000);
  });

  test('HALF_OPEN trial success ⇒ CLOSED and streak cleared', () => {
    resetBreakers();
    recordFailure('c3', 'veto');
    recordFailure('c3', 'veto');
    recordFailure('c3', 'veto');
    const store = (globalThis as unknown as { __apiHealerBreakers: Map<string, { openedAt: number | null }> })
      .__apiHealerBreakers;
    store.get('c3')!.openedAt = Date.now() - 61_000;
    expect(checkBreaker('c3').state).toBe('HALF_OPEN');
    const closed = recordSuccess('c3');
    expect(closed.state).toBe('CLOSED');
    expect(closed.failures).toBe(0);
    expect(closed.reason).toBeNull();
  });

  test('breakers are isolated per contract', () => {
    resetBreakers();
    recordFailure('c4', 'veto');
    expect(checkBreaker('c5').failures).toBe(0);
  });
});

// ─── Step 3 · Callsite parsing ──────────────────────────────────────────────

describe('callsite parsing', () => {
  test('V8 stack → consumer file:line (skips healer + node internals)', () => {
    const stack = [
      'Error: api-healer-callsite',
      '    at healPayload (/home/z/me/app/api-healer-client.ts:120:15)',
      '    at healRequest (/home/z/me/app/node_modules/@healer/runtime.js:9:1)',
      '    at processOrder (/home/z/me/app/services/checkout.ts:42:10)',
      '    at Node.process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    expect(parseCallsite(stack)).toBe('me/app/services/checkout.ts:42');
  });

  test('SpiderMonkey/JSC stack (Deno) parses', () => {
    const stack = 'Error\nprocessOrder@/home/z/me/app/services/orders.ts:7:3';
    expect(parseCallsite(stack)).toBe('me/app/services/orders.ts:7');
  });

  test('returns null for empty/noise-only stacks', () => {
    expect(parseCallsite(null)).toBeNull();
    expect(parseCallsite('Error\n    at healPayload (/x/api-healer-client.ts:1:1)')).toBeNull();
  });
});

// ─── Step 3 · Repo blast-radius scanner ────────────────────────────────────

describe('blast-radius repo scanner', () => {
  const ROOT = '/home/z/my-project/.tmp-blast-test';
  const ENDPOINT = 'https://api.upstream.io/v2/pay';

  test('finds the consumer file:line in a fixture repo', async () => {
    await fs.mkdir(join(ROOT, 'src/svc'), { recursive: true });
    await fs.writeFile(
      join(ROOT, 'src/svc/checkout.ts'),
      `import { useState } from 'state';\nexport async function pay(order) {\n  const res = await fetch('${ENDPOINT}', { method: 'POST', body: JSON.stringify(order) });\n  return res.json();\n}\n`,
      'utf8',
    );
    await fs.writeFile(
      join(ROOT, 'src/other.ts'),
      `// unrelated code\nconst x = fetch('https://api.other.io/v1/health');\n`,
      'utf8',
    );
    await fs.mkdir(join(ROOT, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(
      join(ROOT, 'node_modules/pkg/index.js'),
      `fetch('${ENDPOINT}');\n`,
      'utf8',
    );

    const report = await scanBlastRadius({ root: ROOT, endpoint: ENDPOINT });
    expect(report.scannedFiles).toBe(2); // node_modules skipped
    expect(report.matches.length).toBe(1);
    const m = report.matches[0];
    expect(m.file).toBe('src/svc/checkout.ts');
    expect(m.line).toBe(3);
    expect(m.callee).toBe('fetch');
    expect(m.enclosing).toBe('pay');
    expect(m.snippet).toContain(ENDPOINT);

    await fs.rm(ROOT, { recursive: true, force: true });
  });

  test('returns zero matches for untouched codebases', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(join(ROOT, 'a.ts'), `const x = 1;\n`, 'utf8');
    const report = await scanBlastRadius({ root: ROOT, endpoint: ENDPOINT });
    expect(report.matches.length).toBe(0);
    await fs.rm(ROOT, { recursive: true, force: true });
  });
});
