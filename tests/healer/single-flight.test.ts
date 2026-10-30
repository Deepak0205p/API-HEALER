/**
 * SingleFlight unit tests — the thundering-herd guard.
 * Verifies: 1 execution for N concurrent identical keys, per-caller
 * shared flags, map cleanup on resolve AND reject, no cross-key bleed,
 * and identical value/error identity for followers.
 */
import { describe, expect, test } from 'bun:test';
import { SingleFlight } from '@/lib/healer/single-flight';
import type { HealPlan } from '@/lib/healer/types';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('single-flight', () => {
  test('50 concurrent identical keys ⇒ exactly 1 execution, 49 inherited', async () => {
    const sf = new SingleFlight<string, HealPlan>();
    let executions = 0;
    const mkPlan = (): HealPlan => ({
      version: 1,
      ops: [{ op: 'RENAME', from: 'order_ref', to: 'orderId' }],
      confidence: 0.92,
      rationale: 'synthesis',
      composer: 'deterministic',
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        sf.run('sig-1', async () => {
          executions += 1;
          await delay(20); // simulate LLM/compose latency window
          return mkPlan();
        }),
      ),
    );

    expect(executions).toBe(1);
    const leaders = results.filter((r) => !r.shared).length;
    const followers = results.filter((r) => r.shared).length;
    expect(leaders).toBe(1);
    expect(followers).toBe(49);
    // every caller got the same plan reference (true sharing, not copies)
    expect(new Set(results.map((r) => r.value)).size).toBe(1);
  });

  test('distinct keys never share an execution', async () => {
    const sf = new SingleFlight<string, number>();
    let executions = 0;
    await Promise.all([
      sf.run('sig-A', async () => { executions += 1; await delay(10); return 1; }),
      sf.run('sig-B', async () => { executions += 1; await delay(10); return 2; }),
    ]);
    expect(executions).toBe(2);
  });

  test('map entry is cleaned up after resolution — next caller re-executes', async () => {
    const sf = new SingleFlight<string, number>();
    let executions = 0;
    const first = await sf.run('k', async () => { executions += 1; await delay(5); return 10; });
    expect(first.shared).toBe(false);
    // flight settled ⇒ map must be empty ⇒ this is a fresh leader
    const second = await sf.run('k', async () => { executions += 1; await delay(5); return 20; });
    expect(executions).toBe(2);
    expect(second.shared).toBe(false);
    expect(second.value).toBe(20);
    expect(sf.stats().active).toBe(0);
  });

  test('map entry is cleaned up after rejection — failure does not poison the key', async () => {
    const sf = new SingleFlight<string, number>();
    let executions = 0;
    const boom = sf.run('k', async () => {
      executions += 1;
      await delay(5);
      throw new Error('LLM transport down');
    });
    // followers attached during flight receive the SAME rejection instance
    const follower = sf.run('k', async () => { executions += 1; return 99; });
    let leaderErr: unknown = null;
    let followerErr: unknown = null;
    try { await boom; } catch (e) { leaderErr = e; }
    try { await follower; } catch (e) { followerErr = e; }
    expect(executions).toBe(1); // follower did NOT re-execute
    expect((leaderErr as Error).message).toBe('LLM transport down');
    expect(followerErr).toBe(leaderErr); // identical error object
    expect(sf.stats().active).toBe(0);
    // after the failed flight settles, a new caller becomes a fresh leader
    const retry = await sf.run('k', async () => { executions += 1; return 7; });
    expect(retry.value).toBe(7);
    expect(retry.shared).toBe(false);
    expect(executions).toBe(2);
  });

  test('stats track leaders and inherited callers cumulatively', async () => {
    const sf = new SingleFlight<string, number>();
    const flight = sf.run('x', async () => { await delay(10); return 1; });
    await Promise.all([
      sf.run('x', async () => 2),
      sf.run('x', async () => 3),
      sf.run('x', async () => 4),
    ]);
    await flight;
    const s = sf.stats();
    expect(s.active).toBe(0);
    expect(s.leadersTotal).toBe(1);
    expect(s.inheritedTotal).toBe(3);
    sf.reset();
    expect(sf.stats()).toEqual({ active: 0, inheritedTotal: 0, leadersTotal: 0 });
  });
});
