import { NextRequest, NextResponse } from 'next/server';
import { analyzeAndHealSilentCrashTraps } from '@/lib/healer/silent-crash-detector';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const payload = body.payload;
    const expectedContract = body.expectedContract ?? null;
    const rawText = body.rawText ?? (typeof payload === 'string' ? payload : undefined);

    const analysis = analyzeAndHealSilentCrashTraps(payload, expectedContract, rawText);
    return NextResponse.json(analysis);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
