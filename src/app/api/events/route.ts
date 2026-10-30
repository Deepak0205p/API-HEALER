/** Recent hot-path events with full traces (feeds the live stream + inspector). */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? 40)));
  const eventId = searchParams.get('id');

  if (eventId) {
    const ev = await db.driftEvent.findUnique({
      where: { id: eventId },
      include: { contract: { select: { name: true, endpoint: true } } },
    });
    if (!ev) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ event: ev });
  }

  const events = await db.driftEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { contract: { select: { name: true, endpoint: true } } },
  });
  return NextResponse.json({ events });
}

export async function DELETE() {
  await db.driftEvent.deleteMany({});
  return NextResponse.json({ ok: true });
}
