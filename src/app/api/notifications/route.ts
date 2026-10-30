import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? 60)));
    const rows = await db.notification.findMany({ take: limit });
    return NextResponse.json({ notifications: rows });
  } catch (error) {
    console.error('[API Error] GET /api/notifications:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred while loading notifications.' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      id?: string;
      category?: string;
      severity?: string;
      title?: string;
      description?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    } | null;

    if (!body?.title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const row = await db.notification.create({
      data: {
        id: body.id,
        category: body.category ?? 'SYSTEM',
        severity: body.severity ?? 'INFO',
        title: body.title.slice(0, 140),
        description: (body.description ?? '').slice(0, 500),
        source: body.source ?? 'runtime',
        read: false,
        metadataJson: JSON.stringify(body.metadata ?? {}),
      },
    });

    return NextResponse.json({ ok: true, notification: row });
  } catch (error) {
    console.error('[API Error] POST /api/notifications:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred while saving notification.' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      id?: string;
      markAllRead?: boolean;
    } | null;

    if (body?.markAllRead) {
      await db.notification.markAllRead();
      return NextResponse.json({ ok: true });
    }
    if (body?.id) {
      await db.notification.markRead(body.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'id or markAllRead required' }, { status: 400 });
  } catch (error) {
    console.error('[API Error] PATCH /api/notifications:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred while updating notifications.' },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    await db.notification.deleteMany();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[API Error] DELETE /api/notifications:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred while clearing notifications.' },
      { status: 500 },
    );
  }
}
