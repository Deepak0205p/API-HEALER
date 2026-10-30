/**
 * API-HEALER · Universal HTTP Error Resilience & Auto-Patcher Endpoint
 * ---------------------------------------------------------------------
 * GET  /api/resilience — Returns the registered FIX_REGISTRY strategies,
 *                        active circuit breakers, runtime counters, and
 *                        recent resilience telemetry entries.
 * POST /api/resilience — Classifies, normalizes, and resolves a recovery
 *                        strategy for any HTTP status, vendor payload, or
 *                        transport fault in <0.1ms using L1 Hot-Cache.
 */
import { performance } from 'perf_hooks';
import { NextRequest, NextResponse } from 'next/server';
import {
  FIX_REGISTRY,
  classifyHttpError,
  decideHandler,
  computeBackoffDelay,
  getResilienceTelemetry,
  type ResilienceContext,
  type HttpErrorClassification,
} from '@/lib/healer/http-resilience';
import { listBreakers } from '@/lib/healer/breaker';
import { runtimeCounters } from '@/lib/healer/counters';

// ─── L1 Hot-Path Decision Cache (<0.05ms warm lookup) ────────────────────────

interface CachedResilienceDecision {
  classification: HttpErrorClassification;
  decision: {
    action: string;
    strategy: string;
    tier: string;
    confidence: number;
    shouldRetry: boolean;
    useFallback: boolean;
    failClosed: boolean;
    notes: string;
    rationale: string;
    recommendedDelayMs: number;
  };
  backoffMs: number;
}

const L1_RESILIENCE_CACHE = new Map<string, CachedResilienceDecision>();
const MAX_L1_RESILIENCE_CACHE = 256;

export async function GET(req: NextRequest) {
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitParam) ? Math.min(250, Math.max(1, limitParam)) : 50;

  const strategies = Object.values(FIX_REGISTRY).map((h) => ({
    name: h.name,
    description: h.description,
    mutatesRequest: h.mutatesRequest,
    requiresIdempotency: h.requiresIdempotency,
    canRetry: h.canRetry,
  }));

  return NextResponse.json({
    strategies,
    breakers: listBreakers(),
    counters: runtimeCounters(),
    telemetry: getResilienceTelemetry(limit),
  });
}

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  let body: {
    statusCode?: number;
    status?: number;
    headers?: Record<string, string>;
    errorPayload?: unknown;
    error?: unknown;
    context?: ResilienceContext;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Support both `statusCode` / `status` and `errorPayload` / `error` seamlessly
  const statusCode =
    typeof body.statusCode === 'number'
      ? body.statusCode
      : typeof body.status === 'number'
        ? body.status
        : 0;
  const headers = body.headers ?? {};
  const errorPayload = body.errorPayload ?? body.error ?? null;
  const context: ResilienceContext = body.context ?? {};

  const cacheKey = `${statusCode}:${JSON.stringify(headers)}:${JSON.stringify(errorPayload)}:${context.method ?? 'GET'}:${Boolean(context.isRead)}:${Boolean(context.hasLkg)}:${Boolean(context.hasAuthRefresh)}`;

  const cached = L1_RESILIENCE_CACHE.get(cacheKey);
  if (cached) {
    const runtimeMs = Math.round((performance.now() - t0) * 1000) / 1000;
    return NextResponse.json({
      ...cached,
      runtimeMs,
      cacheHit: true,
    });
  }

  const classification = classifyHttpError(
    statusCode > 0 ? { status: statusCode, headers } : null,
    errorPayload,
    context,
  );
  const decision = decideHandler(classification, classification.signature, context);
  const recommendedDelayMs = decision.shouldRetry
    ? computeBackoffDelay(context.attempt ?? 0, {
        retryAfterSec: classification.normalized.retryAfter,
      })
    : 0;

  const responsePayload: CachedResilienceDecision = {
    classification,
    decision: {
      action: decision.strategy,
      strategy: decision.strategy,
      tier: decision.tier,
      confidence: decision.confidence,
      shouldRetry: decision.shouldRetry,
      useFallback: decision.useFallback,
      failClosed: decision.failClosed,
      notes: decision.rationale,
      rationale: decision.rationale,
      recommendedDelayMs,
    },
    backoffMs: recommendedDelayMs,
  };

  if (L1_RESILIENCE_CACHE.size >= MAX_L1_RESILIENCE_CACHE) {
    const oldest = L1_RESILIENCE_CACHE.keys().next().value;
    if (oldest) L1_RESILIENCE_CACHE.delete(oldest);
  }
  L1_RESILIENCE_CACHE.set(cacheKey, responsePayload);

  const runtimeMs = Math.round((performance.now() - t0) * 1000) / 1000;

  return NextResponse.json({
    ...responsePayload,
    runtimeMs,
    cacheHit: false,
  });
}
