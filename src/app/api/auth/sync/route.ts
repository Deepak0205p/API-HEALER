import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthToken } from '@/lib/firebase-admin';
import { getOrCreateUser } from '@/db/users';

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const { uid, email } = await verifyAuthToken(authHeader);
    const user = await getOrCreateUser(uid, email);
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    console.error('[API Error] /api/auth/sync:', error);
    const message = error instanceof Error ? error.message : 'Authentication sync failed';
    const status = message.includes('Unauthorized') || message.includes('Authorization') ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
