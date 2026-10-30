import { NextRequest, NextResponse } from 'next/server';
import { generateAiCodeFix, type AiFixRequest } from '@/lib/ai/code-fixer';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<AiFixRequest>;

    if (!body.errorType && typeof body.statusCode !== 'number') {
      return NextResponse.json(
        { error: 'Invalid payload: errorType or statusCode required' },
        { status: 400 },
      );
    }

    const fixRequest: AiFixRequest = {
      errorType: body.errorType || `HTTP_${body.statusCode || 500}`,
      statusCode: typeof body.statusCode === 'number' ? body.statusCode : 500,
      rawPayload: body.rawPayload ?? {},
      crashSignature: body.crashSignature,
      context: body.context,
      language: body.language || 'typescript',
      forceFallback: Boolean(body.forceFallback),
    };

    const result = await generateAiCodeFix(fixRequest);
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
