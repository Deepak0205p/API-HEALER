/**
 * API-HEALER · SingleFlight — dedup for concurrent identical async work
 * ----------------------------------------------------------------------
 * Classic single-flight pattern (Hoehrmann / golang.org/x/sync/singleflight):
 * N concurrent callers that need the SAME async computation share ONE
 * execution instead of stampeding the same expensive resource.
 *
 * Why it exists here: an unannounced schema break at 2:00 AM makes every
 * in-flight request miss the memory tiers simultaneously. Without this
 * helper, 50 concurrent drifted requests ⇒ 50 parallel LLM syntheses
 * (rate-limit thundering herd). With it: exactly 1 synthesis, 49 callers
 * await the same in-flight promise and inherit the composed plan. Safety
 * is unchanged — every caller still passes its OWN payload through the
 * 3-Gate Refusal Engine, so an inherited plan that does not fit is vetoed.
 *
 * Guarantees:
 *  - get→set happens inside one synchronous block (JS event loop ⇒ no race)
 *  - the map entry is removed on BOTH resolution and rejection (finally)
 *  - followers attached during flight receive the identical settled value,
 *    or the identical rejection (no duplicate synthesis on failure either)
 *  - a NEW caller after a settled flight re-executes fresh — nothing is
 *    memoized beyond the lifetime of the in-flight window (that is the
 *    fingerprint/hot-patch tiers' job, not this one)
 */

export interface SingleFlightResult<V> {
  value: V;
  /** true ⇒ this caller inherited an in-flight execution instead of running its own */
  shared: boolean;
}

export interface SingleFlightStats {
  /** executions currently in flight (map size) */
  active: number;
  /** cumulative callers that inherited an in-flight execution since boot */
  inheritedTotal: number;
  /** cumulative leader executions since boot */
  leadersTotal: number;
}

export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();
  private inheritedTotal = 0;
  private leadersTotal = 0;

  /**
   * Run `fn` for `key`, or attach to the execution already in flight.
   * The first caller becomes the leader (shared=false); every concurrent
   * caller that arrives while the leader is unsettled shares its outcome
   * (shared=true) without triggering a second execution.
   */
  run(key: K, fn: () => Promise<V>): Promise<SingleFlightResult<V>> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.inheritedTotal += 1;
      return existing.then(
        (value): SingleFlightResult<V> => ({ value, shared: true }),
        (err: unknown): never => {
          throw err; // followers re-throw the leader's original error as-is
        },
      );
    }

    this.leadersTotal += 1;
    const leader = fn().finally(() => {
      // cleanup on resolution AND rejection — the window must stay short
      this.inFlight.delete(key);
    });
    // Synchronous set immediately after invoking fn: the event loop cannot
    // interleave another run(key, …) between the get-miss above and this set.
    this.inFlight.set(key, leader);
    return leader.then((value): SingleFlightResult<V> => ({ value, shared: false }));
  }

  /** Live stats snapshot (metrics + demo HUD). */
  stats(): SingleFlightStats {
    return {
      active: this.inFlight.size,
      inheritedTotal: this.inheritedTotal,
      leadersTotal: this.leadersTotal,
    };
  }

  /** Operator/test reset. Does NOT cancel in-flight executions. */
  reset(): void {
    this.inFlight.clear();
    this.inheritedTotal = 0;
    this.leadersTotal = 0;
  }
}
