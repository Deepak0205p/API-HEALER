/**
 * Next.js instrumentation hook — boots API-Healer's async machinery exactly
 * once per server process: job workers (canary / PR / TTL / metrics)
 * and the silent background self-ping service to prevent web service sleep.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  try {
    const { bootWorkers } = await import('@/lib/jobs/workers');
    bootWorkers();
    console.log('[api-healer] background workers booted (canary · pr · ttl · metrics)');

    // Pure backend background self-ping: keeps the service awake on Render/Cloud without any frontend UI
    const { startKeepAliveTimer } = await import('@/lib/render-keep-alive');
    startKeepAliveTimer();
    console.log('[api-healer] Silent background keep-alive ping active (4m cadence)');
  } catch (e) {
    console.error('[api-healer] instrumentation boot issue:', e);
  }
}
