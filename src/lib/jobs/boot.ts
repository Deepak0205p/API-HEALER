/**
 * Lazy, idempotent worker arming. Guarantees job handlers exist before any
 * enqueue — independent of Next.js instrumentation cold starts.
 */
let arming: Promise<void> | null = null;

export function ensureWorkersBooted(): Promise<void> {
  if (!arming) {
    arming = import('./workers')
      .then(({ bootWorkers }) => bootWorkers())
      .catch((e) => {
        console.error('[jobs] ensureWorkersBooted failed', e);
        arming = null; // allow retry on next enqueue
      }) as Promise<void>;
  }
  return arming;
}
