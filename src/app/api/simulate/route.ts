import { NextRequest, NextResponse } from 'next/server';
import { healRequest } from '@/lib/healer/engine';
import { resetMemoryTier } from '@/lib/healer/memory';
import { db } from '@/lib/db';

export async function GET() {
  return NextResponse.json({ scenarios: [] });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | {
        allowLlm?: boolean;
        contractId?: string;
        payload?: Record<string, unknown>;
      }
    | null;
  if (!body || !body.contractId || !body.payload) {
    return NextResponse.json(
      { error: 'contractId and payload are required' },
      { status: 400 },
    );
  }

  const result = await healRequest({
    contractId: body.contractId,
    payload: body.payload,
    allowLlm: body.allowLlm !== false,
  });

  return NextResponse.json({
    result,
  });
}

export async function DELETE() {
  await db.driftEvent.deleteMany({});
  await db.fingerprint.deleteMany({});
  await db.pullRequest.deleteMany({});
  await db.jobRun.deleteMany({});
  resetMemoryTier();
  return NextResponse.json({ ok: true });
}
