/**
 * API-HEALER · AST Blast-Radius Locator API (Step 3 · the map maker)
 * -------------------------------------------------------------------
 * POST /api/scan  { contractId, root? }
 *
 * Scans a consumer codebase with the TypeScript compiler AST and pinpoints
 * every file:line that fetches the protected endpoint (or references the
 * contract id) — the exact blast radius for the automated remediation PR.
 *
 * Security posture: code files only (never .env/keys), snippets ≤200 chars,
 * bounded file count/size, dot-directories and build outputs skipped.
 * Default root is the tool's own workspace; override with HEALER_REPO_ROOT.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { scanBlastRadius } from '@/lib/healer/blast-radius';
import { resolve } from 'path';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { contractId?: string; endpoint?: string; root?: string }
    | null;
  if (!body?.contractId && !body?.endpoint) {
    return NextResponse.json({ error: 'contractId (or endpoint) is required' }, { status: 400 });
  }

  let endpoint = body.endpoint ?? '';
  if (body.contractId) {
    const contract = await db.contract.findUnique({
      where: { id: body.contractId },
      select: { endpoint: true },
    });
    if (!contract) return NextResponse.json({ error: 'contract not found' }, { status: 404 });
    endpoint = contract.endpoint;
  }

  const root = body.root ?? process.env.HEALER_REPO_ROOT ?? process.cwd();
  try {
    const report = await scanBlastRadius({
      root: resolve(root),
      endpoint,
      contractId: body.contractId ?? null,
    });
    return NextResponse.json({ endpoint, report });
  } catch (e) {
    return NextResponse.json({ error: `scan failed: ${(e as Error).message}` }, { status: 500 });
  }
}
