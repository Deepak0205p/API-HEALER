/** SQLite fingerprint store — the 0.8ms re-heal memory (Loop 2, step 2). */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const rows = await db.fingerprint.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { contract: { select: { name: true } } },
  });
  return NextResponse.json({ fingerprints: rows });
}

/** Manually revoke a fingerprint (operator kill-switch for a hot plan). */
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await db.fingerprint.update({ where: { id }, data: { status: 'REVOKED', resolvedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
