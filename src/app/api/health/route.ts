import { NextResponse } from 'next/server';
import { getKeepAliveState } from '@/lib/render-keep-alive';

export const dynamic = 'force-dynamic';

export async function GET() {
  const keepAlive = getKeepAliveState();
  const uptimeSeconds = Math.floor(process.uptime());

  return NextResponse.json(
    {
      status: 'ok',
      service: 'api-healer',
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
      platform: {
        host: process.env.RENDER_EXTERNAL_URL ? 'render.com' : 'web-service',
        renderExternalUrl: process.env.RENDER_EXTERNAL_URL || null,
        node: process.version,
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      keepAlive: {
        antiSleepCadence: '4 minutes',
        enabled: keepAlive.enabled,
        targetUrl: keepAlive.resolvedUrl,
        totalPings: keepAlive.totalPings,
        successfulPings: keepAlive.successfulPings,
        lastPingAt: keepAlive.lastPingAt,
        lastPingStatus: keepAlive.lastPingStatus,
        lastPingLatencyMs: keepAlive.lastPingLatencyMs,
      },
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Service-Health': 'healthy',
        'X-Render-AntiSleep': 'active',
      },
    },
  );
}

export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: {
      'X-Service-Health': 'healthy',
    },
  });
}
