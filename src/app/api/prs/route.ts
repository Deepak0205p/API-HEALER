/** Cold-path artifacts: canary-proven GitHub PRs (GITHUB or DRY_RUN mode). */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (id) {
    const pr = await db.pullRequest.findUnique({
      where: { id },
      include: { contract: { select: { name: true, endpoint: true } } },
    });
    if (!pr) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ pr });
  }
  const prs = await db.pullRequest.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { contract: { select: { name: true } } },
  });
  return NextResponse.json({ prs });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { id?: string; status?: string } | null;
  if (!body?.id || !body.status) {
    return NextResponse.json({ error: 'id and status required' }, { status: 400 });
  }
  await db.pullRequest.update({ where: { id: body.id }, data: { status: body.status } });
  return NextResponse.json({ ok: true });
}
