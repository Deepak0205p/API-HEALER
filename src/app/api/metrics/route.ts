/** Core telemetry: MTTD / MTTM / MTTI, repair rate, cache hits, PR + job stats. */
import { NextResponse } from 'next/server';
import { computeMetrics } from '@/lib/healer/metrics';
import { listHotPatches, remainingTtlMs } from '@/lib/healer/memory';

export async function GET() {
  const metrics = await computeMetrics();
  const hot = listHotPatches().map((h) => ({
    signature: h.signature,
    contractId: h.contractId,
    opsSummary: h.plan.ops.length,
    hits: h.hits,
    ttlRemainingMs: remainingTtlMs(h),
    composer: h.plan.composer,
    confidence: h.plan.confidence,
  }));
  return NextResponse.json({ metrics, hotPatches: hot });
}
