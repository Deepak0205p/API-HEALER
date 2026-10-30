/**
 * API-HEALER · The Runtime Firewall Endpoint
 * -------------------------------------------
 * POST /api/heal  { contractId, payload, allowLlm? }
 *
 * This is the hot path every intercepted response flows through:
 * intercept → classify → resolve/compose → 3-gate refusal → dual dispatch.
 */
import { NextRequest, NextResponse } from 'next/server';
import { healRequest } from '@/lib/healer/engine';

export async function POST(req: NextRequest) {
  let body: { contractId?: string; payload?: unknown; allowLlm?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.contractId || typeof body.contractId !== 'string') {
    return NextResponse.json({ error: 'contractId is required' }, { status: 400 });
  }
  if (
    body.payload === null ||
    typeof body.payload !== 'object' ||
    Array.isArray(body.payload)
  ) {
    return NextResponse.json(
      { error: 'payload must be a JSON object' },
      { status: 400 },
    );
  }

  try {
    // Step 3 sensor: the SDK client reports WHERE the upstream is consumed
    // ("services/checkout.ts:42") via this header — stored on the event and
    // surfaced in the inspector + PR blast radius.
    const callsite = req.headers.get('x-api-healer-callsite');
    const result = await healRequest({
      contractId: body.contractId,
      payload: body.payload as Record<string, unknown>,
      allowLlm: body.allowLlm,
      callsite: callsite ? callsite.slice(0, 200) : null,
    });
    const httpStatus =
      result.status === 'REFUSED' || result.status === 'ROLLED_BACK' ? 409 : 200;
    return NextResponse.json(result, { status: httpStatus });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'engine fault' },
      { status: 500 },
    );
  }
}
