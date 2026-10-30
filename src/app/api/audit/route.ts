import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog, fetchRecentAuditLogs, type NewAuditLogInput } from '@/lib/audit';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limitCount = Math.min(200, Math.max(1, Number(searchParams.get('limit') ?? 100)));
    const logs = await fetchRecentAuditLogs(limitCount);
    return NextResponse.json({ ok: true, logs, count: logs.length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to fetch audit logs' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as NewAuditLogInput;
    if (!body.action || !body.category || !body.details) {
      return NextResponse.json(
        { error: 'action, category, and details are required fields' },
        { status: 400 },
      );
    }

    const created = await recordAuditLog({
      action: body.action,
      category: body.category,
      details: body.details,
      target: body.target,
      status: body.status || 'SUCCESS',
      performedByUid: body.performedByUid || 'system-api',
      performedByEmail: body.performedByEmail || 'system@api-healer.internal',
      metadata: body.metadata || {},
    });

    return NextResponse.json({ ok: true, log: created });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to write audit log to Firestore' },
      { status: 500 },
    );
  }
}
