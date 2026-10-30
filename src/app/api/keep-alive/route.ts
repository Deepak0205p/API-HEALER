import { NextRequest, NextResponse } from 'next/server';
import {
  getKeepAliveState,
  executePing,
  updateKeepAliveConfig,
} from '@/lib/render-keep-alive';
import { recordAuditLog } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = getKeepAliveState();
  return NextResponse.json({
    ok: true,
    state,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (action === 'ping') {
      const pingResult = await executePing();
      void recordAuditLog({
        action: 'TRIGGER_KEEP_ALIVE_PING',
        category: 'SYSTEM_ACTION',
        target: `url:${pingResult.url}`,
        status: pingResult.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
        details: `Dispatched manual keep-alive anti-sleep ping to ${pingResult.url} (${pingResult.durationMs}ms, status: ${pingResult.statusCode ?? 'ERR'}).`,
        metadata: {
          url: pingResult.url,
          durationMs: pingResult.durationMs,
          statusCode: pingResult.statusCode,
          error: pingResult.error,
        },
      }).catch(() => undefined);

      return NextResponse.json({
        ok: pingResult.status === 'SUCCESS',
        ping: pingResult,
        state: getKeepAliveState(),
      });
    }

    const body = (await req.json().catch(() => ({}))) as {
      targetUrl?: string;
      enabled?: boolean;
    };

    const nextState = updateKeepAliveConfig({
      targetUrl: body.targetUrl,
      enabled: body.enabled,
    });

    void recordAuditLog({
      action: 'UPDATE_KEEP_ALIVE_CONFIG',
      category: 'CONFIG_CHANGE',
      target: 'service:render_anti_sleep',
      status: 'SUCCESS',
      details: `Updated Render anti-sleep configuration: enabled=${nextState.enabled}, target=${nextState.resolvedUrl}.`,
      metadata: {
        enabled: nextState.enabled,
        targetUrl: nextState.targetUrl,
        resolvedUrl: nextState.resolvedUrl,
        intervalMs: nextState.intervalMs,
      },
    }).catch(() => undefined);

    return NextResponse.json({
      ok: true,
      state: nextState,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Keep-alive configuration update failed' },
      { status: 500 },
    );
  }
}
