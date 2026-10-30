/**
 * API-HEALER · healerFetch() — Hybrid Dual-Mode HTTP Resilience Interceptor
 * ---------------------------------------------------------------------------
 * A fetch-compatible wrapper implementing the Universal API Resilience Proxy
 * contract across two coordinated execution tracks:
 *
 *   TRACK A · LOUD & TRANSPORT HTTP FAILURES
 *     • 429 / 500 / 502 / 503 / 504 — overload & server fault family:
 *       - trips per-contract circuit breaker (honoring Retry-After seconds or
 *         HTTP-date as a cooldown lower bound)
 *       - optional bounded backoff + jitter retry on idempotent reads
 *       - reads (GET/HEAD): serves cached Last-Known-Good payload (<0.1ms hot
 *         tier, durable DB mirror) with `x-api-healer: fallback-stale`
 *       - mutations (POST/PUT/PATCH/DELETE): NEVER blindly retried without an
 *         idempotency guarantee — returns a 503 degraded transaction envelope
 *         and queues an engineer ALERT job
 *     • Network / Timeout / DNS / TLS / Socket Hang Up exceptions:
 *       - caught and classified via classifyHttpError()
 *       - bounded jittered retry when configured on safe reads
 *       - falls back to LKG on reads or returns a clean 503 degraded envelope
 *     • 400 / 422 — outbound validation failures:
 *       - adapts trivial type drift / field renames in request JSON via the
 *         zero-eval JSON DSL (outbound.ts) and retries EXACTLY ONCE
 *     • 401 / 403 — authentication & token expiration:
 *       - invokes registered/provided authRefresh hook, injects fresh Bearer
 *         token, and retries once (`AUTH_REFRESHED`)
 *     • 404 / 410 — missing or migrated routes:
 *       - checks endpoint fallback registry and routes to migrated URL once
 *         (`ENDPOINT_REMAPPED`), or serves LKG if `fallbackOnNotFound` is set
 *     • 405 — method not allowed:
 *       - inspects `Allow` header and retries once ONLY if target method is
 *         safe & idempotent (`GET`/`HEAD`) (`METHOD_CORRECTED`)
 *     • 409 — conflict / optimistic concurrency:
 *       - applies registered `conflictResolver` on request body and retries
 *         once (`CONFLICT_RESOLVED`)
 *
 *   TRACK B · SILENT FAILURES (200 OK with schema drift, malformed JSON,
 *             partial payloads, or disguised upstream error wrappers)
 *     • Repairs safe transport wrappers (BOM, XSSI, trailing comma) or serves
 *       LKG when 200 OK body is truncated/unparseable JSON
 *     • Unwraps partial-success `{ data, errors }` envelopes when appropriate
 *     • Detects disguised errors inside 200 OK (`{ ok: false, error: ... }`)
 *     • Runs the dual-loop engine: Zod validate → classify → compose → 3-gate
 *       refusal → heal or fail-safe rollback. Healthy traffic returns the
 *       ORIGINAL upstream Response untouched (<0.3ms overhead).
 */
import { performance } from 'perf_hooks';
import { healRequest } from './engine';
import { captureCallsite } from './callsite';
import { checkBreaker, recordFailure } from './breaker';
import { getDurableLastKnownGood } from './memory';
import { recordDriftEventInBackground } from './audit';
import { bumpRuntimeCounter } from './counters';
import { enqueueJob } from '@/lib/jobs/queue';
import {
  deriveOutboundPlan,
  applyOutboundPlan,
  getOutboundPlan,
  putOutboundPlan,
} from './outbound';
import {
  classifyHttpError,
  decideHandler,
  computeBackoffDelay,
  parseRetryAfterHeader,
  repairMalformedJson,
  inspectSuccessBodyForHiddenError,
  getAuthRefreshHandler,
  lookupEndpointFallback,
  getConflictResolver,
  recordResilienceTelemetry,
  type AuthRefreshFn,
  type ConflictResolverFn,
  type HttpErrorClassification,
} from './http-resilience';
import type { HealResult } from './types';

export interface HealerFetchOptions {
  /** The protected contract to enforce on this exchange */
  contractId: string;
  /** Allow the LLM composer tier for novel drift (default true) */
  allowLlm?: boolean;
  /**
   * Override the read/mutation classification for Track A. By default the
   * HTTP method decides: GET/HEAD/OPTIONS = read, everything else = mutation.
   */
  read?: boolean;
  /** Optional token refresh callback for 401 / stale-token 403 recovery */
  authRefresh?: AuthRefreshFn;
  /** Optional map of migrated endpoints for 404 / 410 recovery */
  endpointFallbacks?: Record<string, string>;
  /** Optional deterministic conflict resolver for 409 responses */
  conflictResolver?: ConflictResolverFn;
  /** Allow safe idempotent method correction on 405 (default true) */
  allowMethodCorrection?: boolean;
  /** Serve LKG / safeDefault on 404/410 read failures when no route remap exists */
  fallbackOnNotFound?: boolean;
  /** Optional bounded retry count for transient network/timeout/5xx on safe requests (default 0) */
  maxRetries?: number;
  /** Base backoff delay in ms when maxRetries > 0 (default 50ms) */
  baseDelayMs?: number;
  /** Safe fallback payload if no LKG is cached */
  safeDefault?: Record<string, unknown>;
  /** Explicit idempotency key for safe mutation retries */
  idempotencyKey?: string;
  /** Logical upstream service name for telemetry */
  service?: string;
}

export type HealerResponse = Response & {
  __healer?: HealResult;
  __classification?: HttpErrorClassification;
};

/** Status families Track A claims. */
const OVERLOAD_STATUSES = new Set([429, 500, 502, 503, 504]);
const VALIDATION_STATUSES = new Set([400, 422]);
const AUTH_STATUSES = new Set([401, 403]);
const NOT_FOUND_STATUSES = new Set([404, 410]);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isMutation(init: RequestInit | undefined, options: HealerFetchOptions | undefined): boolean {
  if (options?.read === true) return false;
  if (options?.read === false) return true;
  const method = (init?.method ?? 'GET').toUpperCase();
  return !READ_METHODS.has(method);
}

function hasIdempotencyHeader(init: RequestInit | undefined, options: HealerFetchOptions | undefined): boolean {
  if (options?.idempotencyKey) return true;
  if (!init?.headers) return false;
  const h = new Headers(init.headers);
  return Boolean(h.get('idempotency-key') || h.get('x-idempotency-key'));
}

function attach(
  res: Response,
  healer: HealResult,
  classification?: HttpErrorClassification,
): HealerResponse {
  const hr = res as HealerResponse;
  hr.__healer = healer;
  if (classification) hr.__classification = classification;
  return hr;
}

function trackAResult(
  contractId: string,
  status: HealResult['status'],
  message: string,
  totalMs: number,
  servedPayload: Record<string, unknown> | null,
  signature = '',
  confidence = 0,
): HealResult {
  return {
    status,
    contractId,
    contractName: '',
    endpoint: '',
    servedPayload,
    rawPayload: {},
    plan: null,
    classification: null,
    gates: null,
    signature,
    timing: { classifyMs: 0, composeMs: 0, gatesMs: 0, totalMs },
    composer: 'none',
    confidence,
    canaryPassed: null,
    jobsQueued: [],
    message,
  };
}

/** Persist a Track A intervention as a DriftEvent (background, non-blocking). */
function auditTrackA(
  contractId: string,
  status: HealResult['status'],
  detail: Record<string, unknown>,
  result: HealResult,
): void {
  recordDriftEventInBackground(
    {
      contractId,
      signature: result.signature || '',
      driftType: `TRACK_A_${status}`,
      callsite: captureCallsite(),
      classificationJson: JSON.stringify(detail),
      rawPayloadJson: JSON.stringify(detail.sentBody ?? {}),
      status,
      composer: 'none',
      confidence: result.confidence,
      totalMs: result.timing.totalMs,
    },
    { ...result },
  );
}

function parseJsonBodySent(init?: RequestInit): Record<string, unknown> | null {
  if (typeof init?.body !== 'string') return null;
  try {
    const parsed = JSON.parse(init.body) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not a JSON object
  }
  return null;
}

async function safeReadErrorPayload(res: Response): Promise<unknown> {
  try {
    const text = await res.clone().text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

// ─── TRACK A · overload & server fault lane (429 / 500 / 502 / 503 / 504) ────

async function trackAOverload(
  upstream: Response,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
  mutation: boolean,
): Promise<HealerResponse> {
  const { contractId } = options;
  const t0 = performance.now();
  const method = (init?.method ?? 'GET').toUpperCase();
  const errorPayload = await safeReadErrorPayload(upstream);

  const lkg = !mutation ? ((await getDurableLastKnownGood(contractId)) ?? options.safeDefault ?? null) : null;
  const idempotent = !mutation || hasIdempotencyHeader(init, options);

  const errClass = classifyHttpError(upstream, errorPayload, {
    url,
    method,
    contractId,
    service: options.service,
    isRead: !mutation,
    hasIdempotencyKey: idempotent,
    hasLkg: Boolean(lkg),
    maxRetries: options.maxRetries ?? 0,
  });

  const retryAfterHeader = upstream.headers.get('retry-after');
  const retryAfterSec =
    parseRetryAfterHeader(retryAfterHeader) ?? errClass.normalized.retryAfter;
  const cooldownHint =
    retryAfterSec !== null && Number.isFinite(retryAfterSec)
      ? retryAfterSec * 1000
      : undefined;

  // Optional bounded retry with backoff + jitter when explicitly configured on safe/idempotent calls
  const maxRetries = options.maxRetries ?? 0;
  if (maxRetries > 0 && idempotent) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delayMs = computeBackoffDelay(attempt, {
        baseDelayMs: options.baseDelayMs ?? 40,
        maxDelayMs: 2_000,
        retryAfterSec,
      });
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set('x-api-healer-retry-attempt', String(attempt + 1));
        const retryRes = await fetch(url, { ...init, headers: retryHeaders });
        if (!OVERLOAD_STATUSES.has(retryRes.status)) {
          bumpRuntimeCounter('retriedTransient');
          const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
          const result = trackAResult(
            contractId,
            'RETRIED_TRANSIENT',
            `upstream ${upstream.status} recovered on retry #${attempt + 1} (status ${retryRes.status})`,
            totalMs,
            null,
            errClass.signature,
            errClass.confidence,
          );
          recordResilienceTelemetry({
            service: options.service ?? 'upstream',
            endpoint: url,
            method,
            statusCode: upstream.status,
            family: errClass.family,
            severity: errClass.severity,
            normalizedReason: errClass.normalized.message,
            vendor: errClass.normalized.vendor,
            fixApplied: errClass.family === 'timeout' ? 'jittered_retry' : 'retry_with_backoff',
            resolutionTier: errClass.resolutionTier,
            fallbackUsed: false,
            confidence: errClass.confidence,
            retryAttempts: attempt + 1,
            signature: errClass.signature,
            outcome: 'RECOVERED',
          });
          const headers = new Headers(retryRes.headers);
          headers.set('x-api-healer-status', 'RETRIED_TRANSIENT');
          headers.set('x-api-healer-retry-attempts', String(attempt + 1));
          const wrapped = new Response(retryRes.body, {
            status: retryRes.status,
            statusText: retryRes.statusText,
            headers,
          });
          return attach(wrapped, result, errClass);
        }
      } catch {
        // continue retry loop or fall through to breaker + fallback
      }
    }
  }

  recordFailure(
    contractId,
    `upstream ${upstream.status}${retryAfterHeader ? ` (Retry-After ${retryAfterHeader}s)` : ''} on ${url}`,
    cooldownHint,
  );

  const breaker = checkBreaker(contractId);

  // Mutations: NEVER blindly retry — a double-charge is worse than a delay.
  if (mutation) {
    bumpRuntimeCounter('degraded');
    const envelope = {
      ok: false,
      degraded: true,
      code: 'API_HEALER_UPSTREAM_UNAVAILABLE',
      reason: `upstream ${upstream.status} — circuit breaker engaged (state ${breaker.state}); mutation NOT retried to guarantee idempotency`,
      upstreamStatus: upstream.status,
      family: errClass.family,
      signature: errClass.signature.slice(0, 16),
      retryable: true,
      retryAfter: retryAfterSec,
      action: 'RETRY_LATER',
      transactionId: null,
      healer: 'api-healer',
    };
    const alertJob = await enqueueJob('ALERT', {
      contractId,
      kind: 'DEGRADED_MUTATION',
      upstreamStatus: upstream.status,
      url,
      breakerState: breaker.state,
      message: `Mutation to ${url} degraded: upstream ${upstream.status}, breaker ${breaker.state}. No retry fired (idempotency preserved).`,
    });
    const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    const result = trackAResult(
      contractId,
      'DEGRADED',
      `upstream ${upstream.status} — mutation NOT retried (double-charge impossible by construction); degraded envelope returned, developer alert queued`,
      totalMs,
      envelope,
      errClass.signature,
      errClass.confidence,
    );
    result.jobsQueued = alertJob.id ? [alertJob.id] : [];
    auditTrackA(contractId, 'DEGRADED', { track: 'A', upstreamStatus: upstream.status, url }, result);
    recordResilienceTelemetry({
      service: options.service ?? 'upstream',
      endpoint: url,
      method,
      statusCode: upstream.status,
      family: errClass.family,
      severity: errClass.severity,
      normalizedReason: errClass.normalized.message,
      vendor: errClass.normalized.vendor,
      fixApplied: 'circuit_breaker',
      resolutionTier: errClass.resolutionTier,
      fallbackUsed: false,
      confidence: errClass.confidence,
      retryAttempts: maxRetries,
      signature: errClass.signature,
      outcome: 'DEGRADED',
    });
    const res = new Response(JSON.stringify(envelope), {
      status: 503,
      statusText: 'Service Unavailable (api-healer degraded)',
      headers: {
        'content-type': 'application/json',
        'x-api-healer': 'degraded',
        'x-api-healer-status': 'DEGRADED',
        'x-api-healer-upstream-status': String(upstream.status),
        'x-api-healer-family': errClass.family,
      },
    });
    return attach(res, result, errClass);
  }

  // Reads: serve the cached Last-Known-Good with the stale-fallback marker.
  const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
  if (lkg) {
    bumpRuntimeCounter('fallbackStale');
    const result = trackAResult(
      contractId,
      'FALLBACK_STALE',
      `upstream ${upstream.status} — serving cached last-known-good read payload (stale); breaker ${breaker.state}`,
      totalMs,
      lkg,
      errClass.signature,
      errClass.confidence,
    );
    auditTrackA(contractId, 'FALLBACK_STALE', { track: 'A', upstreamStatus: upstream.status, url }, result);
    recordResilienceTelemetry({
      service: options.service ?? 'upstream',
      endpoint: url,
      method,
      statusCode: upstream.status,
      family: errClass.family,
      severity: errClass.severity,
      normalizedReason: errClass.normalized.message,
      vendor: errClass.normalized.vendor,
      fixApplied: 'fallback_stale_payload',
      resolutionTier: errClass.resolutionTier,
      fallbackUsed: true,
      confidence: errClass.confidence,
      retryAttempts: maxRetries,
      signature: errClass.signature,
      outcome: 'FALLBACK',
    });
    const res = new Response(JSON.stringify(lkg), {
      status: 200,
      statusText: 'OK (api-healer stale fallback)',
      headers: {
        'content-type': 'application/json',
        'x-api-healer': 'fallback-stale',
        'x-api-healer-status': 'FALLBACK_STALE',
        'x-api-healer-upstream-status': String(upstream.status),
        'x-api-healer-family': errClass.family,
      },
    });
    return attach(res, result, errClass);
  }

  // No baseline exists — pass the real failure through honestly.
  const result = trackAResult(
    contractId,
    'PASSTHROUGH',
    `upstream ${upstream.status} on a read with no cached baseline — failure passed through honestly`,
    totalMs,
    null,
    errClass.signature,
    errClass.confidence,
  );
  recordResilienceTelemetry({
    service: options.service ?? 'upstream',
    endpoint: url,
    method,
    statusCode: upstream.status,
    family: errClass.family,
    severity: errClass.severity,
    normalizedReason: errClass.normalized.message,
    vendor: errClass.normalized.vendor,
    fixApplied: 'safe_default_response',
    resolutionTier: 'safe_degradation',
    fallbackUsed: false,
    confidence: errClass.confidence,
    retryAttempts: maxRetries,
    signature: errClass.signature,
    outcome: 'DEGRADED',
  });
  return attach(upstream, result, errClass);
}

// ─── TRACK A · network / timeout / DNS / TLS transport failure lane ──────────

async function trackATransportFailure(
  transportError: unknown,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
  mutation: boolean,
): Promise<HealerResponse> {
  const { contractId } = options;
  const t0 = performance.now();
  const method = (init?.method ?? 'GET').toUpperCase();
  const idempotent = !mutation || hasIdempotencyHeader(init, options);
  const maxRetries = options.maxRetries ?? 0;

  // Retry if configured and safe
  if (maxRetries > 0 && idempotent) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const delayMs = computeBackoffDelay(attempt, {
        baseDelayMs: options.baseDelayMs ?? 40,
        maxDelayMs: 1_500,
      });
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set('x-api-healer-retry-attempt', String(attempt + 1));
        const retryRes = await fetch(url, { ...init, headers: retryHeaders });
        if (retryRes.ok) {
          bumpRuntimeCounter('retriedTransient');
          const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
          const errClass = classifyHttpError(null, transportError, { url, method, contractId });
          const result = trackAResult(
            contractId,
            'RETRIED_TRANSIENT',
            `transport error (${errClass.normalized.code}) recovered on retry #${attempt + 1}`,
            totalMs,
            null,
            errClass.signature,
            errClass.confidence,
          );
          recordResilienceTelemetry({
            service: options.service ?? 'upstream',
            endpoint: url,
            method,
            statusCode: 0,
            family: errClass.family,
            severity: errClass.severity,
            normalizedReason: errClass.normalized.message,
            vendor: 'standard',
            fixApplied: errClass.family === 'timeout' ? 'jittered_retry' : 'retry_with_backoff',
            resolutionTier: 'deterministic_rule',
            fallbackUsed: false,
            confidence: errClass.confidence,
            retryAttempts: attempt + 1,
            signature: errClass.signature,
            outcome: 'RECOVERED',
          });
          const headers = new Headers(retryRes.headers);
          headers.set('x-api-healer-status', 'RETRIED_TRANSIENT');
          headers.set('x-api-healer-retry-attempts', String(attempt + 1));
          const wrapped = new Response(retryRes.body, {
            status: retryRes.status,
            statusText: retryRes.statusText,
            headers,
          });
          return attach(wrapped, result, errClass);
        }
      } catch (nextErr) {
        transportError = nextErr;
      }
    }
  }

  const lkg = !mutation ? ((await getDurableLastKnownGood(contractId)) ?? options.safeDefault ?? null) : null;
  const errClass = classifyHttpError(null, transportError, {
    url,
    method,
    contractId,
    service: options.service,
    isRead: !mutation,
    hasLkg: Boolean(lkg),
    hasIdempotencyKey: idempotent,
  });

  recordFailure(
    contractId,
    `transport ${errClass.family} (${errClass.normalized.code}): ${errClass.normalized.message}`,
  );
  const breaker = checkBreaker(contractId);
  const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;

  if (!mutation && lkg) {
    bumpRuntimeCounter('fallbackStale');
    const result = trackAResult(
      contractId,
      'FALLBACK_STALE',
      `transport ${errClass.family} (${errClass.normalized.code}) — serving cached last-known-good read payload; breaker ${breaker.state}`,
      totalMs,
      lkg,
      errClass.signature,
      errClass.confidence,
    );
    auditTrackA(
      contractId,
      'FALLBACK_STALE',
      { track: 'A', transportError: errClass.normalized.code, url },
      result,
    );
    recordResilienceTelemetry({
      service: options.service ?? 'upstream',
      endpoint: url,
      method,
      statusCode: errClass.statusCode,
      family: errClass.family,
      severity: errClass.severity,
      normalizedReason: errClass.normalized.message,
      vendor: 'standard',
      fixApplied: 'fallback_stale_payload',
      resolutionTier: errClass.resolutionTier,
      fallbackUsed: true,
      confidence: errClass.confidence,
      retryAttempts: maxRetries,
      signature: errClass.signature,
      outcome: 'FALLBACK',
    });
    const res = new Response(JSON.stringify(lkg), {
      status: 200,
      statusText: 'OK (api-healer stale fallback)',
      headers: {
        'content-type': 'application/json',
        'x-api-healer': 'fallback-stale',
        'x-api-healer-status': 'FALLBACK_STALE',
        'x-api-healer-upstream-status': errClass.normalized.code,
        'x-api-healer-family': errClass.family,
      },
    });
    return attach(res, result, errClass);
  }

  bumpRuntimeCounter('degraded');
  const envelope = {
    ok: false,
    degraded: true,
    code: `API_HEALER_${errClass.normalized.code}`,
    reason: `transport ${errClass.family} (${errClass.normalized.message}) — circuit breaker ${breaker.state}`,
    upstreamStatus: errClass.statusCode,
    family: errClass.family,
    retryable: errClass.normalized.retryable,
    action: 'RETRY_LATER',
    transactionId: null,
    healer: 'api-healer',
  };
  const result = trackAResult(
    contractId,
    'DEGRADED',
    `transport ${errClass.family} (${errClass.normalized.code}) — safe degraded envelope returned`,
    totalMs,
    envelope,
    errClass.signature,
    errClass.confidence,
  );
  auditTrackA(
    contractId,
    'DEGRADED',
    { track: 'A', transportError: errClass.normalized.code, url },
    result,
  );
  recordResilienceTelemetry({
    service: options.service ?? 'upstream',
    endpoint: url,
    method,
    statusCode: errClass.statusCode,
    family: errClass.family,
    severity: errClass.severity,
    normalizedReason: errClass.normalized.message,
    vendor: 'standard',
    fixApplied: 'safe_default_response',
    resolutionTier: errClass.resolutionTier,
    fallbackUsed: false,
    confidence: errClass.confidence,
    retryAttempts: maxRetries,
    signature: errClass.signature,
    outcome: 'DEGRADED',
  });
  const res = new Response(JSON.stringify(envelope), {
    status: errClass.family === 'timeout' ? 504 : 503,
    statusText: 'Service Unavailable (api-healer transport degraded)',
    headers: {
      'content-type': 'application/json',
      'x-api-healer': 'degraded',
      'x-api-healer-status': 'DEGRADED',
      'x-api-healer-upstream-status': errClass.normalized.code,
      'x-api-healer-family': errClass.family,
    },
  });
  return attach(res, result, errClass);
}

// ─── TRACK A · outbound validation lane (400 / 422) ──────────────────────────

async function trackAValidation(
  upstream: Response,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
): Promise<HealerResponse> {
  const { contractId } = options;
  const sentBody = parseJsonBodySent(init);
  if (!sentBody) return upstream as HealerResponse;

  let errorBody: unknown = null;
  try {
    errorBody = await upstream.clone().json();
  } catch {
    return upstream as HealerResponse;
  }

  const adapted = deriveOutboundPlan(errorBody, sentBody);
  if (!adapted) return upstream as HealerResponse;

  const cached = getOutboundPlan(adapted.cacheKey);
  const plan = cached ?? adapted.plan;
  const adaptedBody = applyOutboundPlan(sentBody, plan);
  if (!adaptedBody) return upstream as HealerResponse;
  if (!cached) putOutboundPlan(adapted.cacheKey, plan);

  const t0 = performance.now();
  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('content-type', 'application/json');
  retryHeaders.set('x-api-healer-request', 'adapted');
  const retry = await fetch(url, {
    ...init,
    headers: retryHeaders,
    body: JSON.stringify(adaptedBody),
  });

  bumpRuntimeCounter('outboundAdapted');
  const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
  const opsSummary = plan.ops.map((o) => JSON.stringify(o)).join(', ');
  const errClass = classifyHttpError(upstream, errorBody, {
    url,
    method: init?.method ?? 'POST',
    contractId,
    sentBody,
  });

  const result = trackAResult(
    contractId,
    'OUTBOUND_ADAPTED',
    `upstream 4xx rejected our request — adapted via DSL [${opsSummary}] and retried once; retry status ${retry.status}`,
    totalMs,
    adaptedBody,
    errClass.signature,
    plan.confidence,
  );
  auditTrackA(
    contractId,
    'OUTBOUND_ADAPTED',
    { track: 'A', upstreamStatus: upstream.status, url, plan, retryStatus: retry.status },
    result,
  );
  recordResilienceTelemetry({
    service: options.service ?? 'upstream',
    endpoint: url,
    method: (init?.method ?? 'POST').toUpperCase(),
    statusCode: upstream.status,
    family: 'validation',
    severity: 'medium',
    normalizedReason: errClass.normalized.message,
    vendor: errClass.normalized.vendor,
    fixApplied: 'payload_repair',
    resolutionTier: 'deterministic_rule',
    fallbackUsed: false,
    confidence: plan.confidence,
    retryAttempts: 1,
    signature: errClass.signature,
    outcome: retry.ok ? 'RECOVERED' : 'DEGRADED',
  });

  const headers = new Headers(retry.headers);
  headers.set('x-api-healer-status', 'OUTBOUND_ADAPTED');
  headers.set('x-api-healer-request-ops', String(plan.ops.length));
  const res = new Response(retry.body, {
    status: retry.status,
    statusText: retry.statusText,
    headers,
  });
  return attach(res, result, errClass);
}

// ─── TRACK A · auth refresh lane (401 / 403) ─────────────────────────────────

async function trackAAuth(
  upstream: Response,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
): Promise<HealerResponse> {
  const { contractId } = options;
  const t0 = performance.now();
  const errorBody = await safeReadErrorPayload(upstream);
  const refreshFn = getAuthRefreshHandler(contractId, options.authRefresh);

  const errClass = classifyHttpError(upstream, errorBody, {
    url,
    method: init?.method ?? 'GET',
    contractId,
    hasAuthRefresh: Boolean(refreshFn),
  });

  const decision = decideHandler(errClass, errClass.signature, {
    url,
    contractId,
    hasAuthRefresh: Boolean(refreshFn),
    attempt: 0,
  });

  if (decision.strategy === 'auth_refresh' && decision.shouldRetry && refreshFn) {
    try {
      const freshToken = await refreshFn({
        url,
        status: upstream.status,
        contractId,
      });
      if (freshToken && typeof freshToken === 'string') {
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set(
          'authorization',
          freshToken.startsWith('Bearer ') ? freshToken : `Bearer ${freshToken}`,
        );
        retryHeaders.set('x-api-healer-auth', 'refreshed');
        const retry = await fetch(url, { ...init, headers: retryHeaders });
        bumpRuntimeCounter('authRefreshed');
        const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
        const result = trackAResult(
          contractId,
          'AUTH_REFRESHED',
          `upstream ${upstream.status} token expired — refreshed credentials and retried once (status ${retry.status})`,
          totalMs,
          null,
          errClass.signature,
          errClass.confidence,
        );
        auditTrackA(
          contractId,
          'AUTH_REFRESHED',
          { track: 'A', upstreamStatus: upstream.status, url, retryStatus: retry.status },
          result,
        );
        recordResilienceTelemetry({
          service: options.service ?? 'upstream',
          endpoint: url,
          method: (init?.method ?? 'GET').toUpperCase(),
          statusCode: upstream.status,
          family: 'auth',
          severity: errClass.severity,
          normalizedReason: errClass.normalized.message,
          vendor: errClass.normalized.vendor,
          fixApplied: 'auth_refresh',
          resolutionTier: errClass.resolutionTier,
          fallbackUsed: false,
          confidence: errClass.confidence,
          retryAttempts: 1,
          signature: errClass.signature,
          outcome: retry.ok ? 'RECOVERED' : 'REJECTED',
        });

        const headers = new Headers(retry.headers);
        headers.set('x-api-healer-status', 'AUTH_REFRESHED');
        const res = new Response(retry.body, {
          status: retry.status,
          statusText: retry.statusText,
          headers,
        });
        return attach(res, result, errClass);
      }
    } catch {
      // Refresh failed — fall through to clean pass-through
    }
  }

  recordResilienceTelemetry({
    service: options.service ?? 'upstream',
    endpoint: url,
    method: (init?.method ?? 'GET').toUpperCase(),
    statusCode: upstream.status,
    family: 'auth',
    severity: errClass.severity,
    normalizedReason: errClass.normalized.message,
    vendor: errClass.normalized.vendor,
    fixApplied: 'safe_default_response',
    resolutionTier: 'safe_degradation',
    fallbackUsed: false,
    confidence: errClass.confidence,
    retryAttempts: 0,
    signature: errClass.signature,
    outcome: 'REJECTED',
  });
  return upstream as HealerResponse;
}

// ─── TRACK A · route remap & missing resource lane (404 / 410) ───────────────

async function trackANotFound(
  upstream: Response,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
  mutation: boolean,
): Promise<HealerResponse> {
  const { contractId } = options;
  const t0 = performance.now();
  const targetUrl = lookupEndpointFallback(url, options.endpointFallbacks);
  const errorBody = await safeReadErrorPayload(upstream);

  const errClass = classifyHttpError(upstream, errorBody, {
    url,
    method: init?.method ?? 'GET',
    contractId,
    hasEndpointFallback: Boolean(targetUrl),
    isRead: !mutation,
  });

  if (targetUrl && targetUrl !== url) {
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-api-healer-remapped-from', url);
    const retry = await fetch(targetUrl, { ...init, headers: retryHeaders });
    bumpRuntimeCounter('endpointRemapped');
    const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    const result = trackAResult(
      contractId,
      'ENDPOINT_REMAPPED',
      `upstream ${upstream.status} on ${url} — remapped to ${targetUrl} (status ${retry.status})`,
      totalMs,
      null,
      errClass.signature,
      errClass.confidence,
    );
    auditTrackA(
      contractId,
      'ENDPOINT_REMAPPED',
      { track: 'A', upstreamStatus: upstream.status, fromUrl: url, toUrl: targetUrl, retryStatus: retry.status },
      result,
    );
    recordResilienceTelemetry({
      service: options.service ?? 'upstream',
      endpoint: url,
      method: (init?.method ?? 'GET').toUpperCase(),
      statusCode: upstream.status,
      family: 'not_found',
      severity: errClass.severity,
      normalizedReason: errClass.normalized.message,
      vendor: errClass.normalized.vendor,
      fixApplied: 'endpoint_remap',
      resolutionTier: 'deterministic_rule',
      fallbackUsed: false,
      confidence: errClass.confidence,
      retryAttempts: 1,
      signature: errClass.signature,
      outcome: retry.ok ? 'RECOVERED' : 'DEGRADED',
    });

    const headers = new Headers(retry.headers);
    headers.set('x-api-healer-status', 'ENDPOINT_REMAPPED');
    headers.set('x-api-healer-remapped-to', targetUrl);
    const res = new Response(retry.body, {
      status: retry.status,
      statusText: retry.statusText,
      headers,
    });
    return attach(res, result, errClass);
  }

  if (options.fallbackOnNotFound && !mutation) {
    const lkg = (await getDurableLastKnownGood(contractId)) ?? options.safeDefault ?? null;
    if (lkg) {
      bumpRuntimeCounter('fallbackStale');
      const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
      const result = trackAResult(
        contractId,
        'FALLBACK_STALE',
        `upstream ${upstream.status} — serving fallback payload for missing route`,
        totalMs,
        lkg,
        errClass.signature,
        errClass.confidence,
      );
      const res = new Response(JSON.stringify(lkg), {
        status: 200,
        statusText: 'OK (api-healer not-found fallback)',
        headers: {
          'content-type': 'application/json',
          'x-api-healer': 'fallback-stale',
          'x-api-healer-status': 'FALLBACK_STALE',
          'x-api-healer-upstream-status': String(upstream.status),
        },
      });
      return attach(res, result, errClass);
    }
  }

  return upstream as HealerResponse;
}

// ─── TRACK A · method correction lane (405 Method Not Allowed) ───────────────

async function trackAMethodNotAllowed(
  upstream: Response,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
): Promise<HealerResponse> {
  if (options.allowMethodCorrection === false) return upstream as HealerResponse;

  const allowHeader = upstream.headers.get('allow') ?? '';
  const allowed = allowHeader
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);

  // Safety rule: ONLY auto-correct to a safe idempotent read method (GET / HEAD)
  const safeMethod = allowed.find((m) => m === 'GET' || m === 'HEAD');
  if (!safeMethod) return upstream as HealerResponse;

  const t0 = performance.now();
  const errorBody = await safeReadErrorPayload(upstream);
  const errClass = classifyHttpError(upstream, errorBody, {
    url,
    method: init?.method ?? 'POST',
    contractId: options.contractId,
    headers: upstream.headers,
  });

  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('x-api-healer-method-corrected', safeMethod);
  const retryInit: RequestInit = {
    ...init,
    method: safeMethod,
    body: undefined, // GET/HEAD cannot carry a body
    headers: retryHeaders,
  };
  const retry = await fetch(url, retryInit);
  bumpRuntimeCounter('methodCorrected');
  const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;

  const result = trackAResult(
    options.contractId,
    'METHOD_CORRECTED',
    `upstream 405 Method Not Allowed (Allow: ${allowHeader}) — corrected to safe method ${safeMethod} and retried once (status ${retry.status})`,
    totalMs,
    null,
    errClass.signature,
    errClass.confidence,
  );
  auditTrackA(
    options.contractId,
    'METHOD_CORRECTED',
    { track: 'A', upstreamStatus: 405, correctedMethod: safeMethod, url, retryStatus: retry.status },
    result,
  );
  recordResilienceTelemetry({
    service: options.service ?? 'upstream',
    endpoint: url,
    method: (init?.method ?? 'POST').toUpperCase(),
    statusCode: 405,
    family: 'validation',
    severity: 'medium',
    normalizedReason: errClass.normalized.message,
    vendor: errClass.normalized.vendor,
    fixApplied: 'method_correction',
    resolutionTier: 'deterministic_rule',
    fallbackUsed: false,
    confidence: errClass.confidence,
    retryAttempts: 1,
    signature: errClass.signature,
    outcome: retry.ok ? 'RECOVERED' : 'DEGRADED',
  });

  const headers = new Headers(retry.headers);
  headers.set('x-api-healer-status', 'METHOD_CORRECTED');
  headers.set('x-api-healer-corrected-method', safeMethod);
  const res = new Response(retry.body, {
    status: retry.status,
    statusText: retry.statusText,
    headers,
  });
  return attach(res, result, errClass);
}

// ─── TRACK A · conflict resolution lane (409 Conflict) ───────────────────────

async function trackAConflict(
  upstream: Response,
  url: string,
  init: RequestInit | undefined,
  options: HealerFetchOptions,
): Promise<HealerResponse> {
  const { contractId } = options;
  const sentBody = parseJsonBodySent(init);
  const resolver = getConflictResolver(contractId, options.conflictResolver);
  if (!sentBody || !resolver) return upstream as HealerResponse;

  const conflictBody = await safeReadErrorPayload(upstream);
  const resolvedBody = resolver(sentBody, conflictBody);
  if (!resolvedBody) return upstream as HealerResponse;

  const t0 = performance.now();
  const errClass = classifyHttpError(upstream, conflictBody, {
    url,
    method: init?.method ?? 'POST',
    contractId,
    hasConflictResolver: true,
  });

  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('content-type', 'application/json');
  retryHeaders.set('x-api-healer-conflict', 'resolved');
  const retry = await fetch(url, {
    ...init,
    headers: retryHeaders,
    body: JSON.stringify(resolvedBody),
  });

  bumpRuntimeCounter('conflictResolved');
  const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
  const result = trackAResult(
    contractId,
    'CONFLICT_RESOLVED',
    `upstream 409 Conflict resolved via deterministic conflictResolver and retried once (status ${retry.status})`,
    totalMs,
    resolvedBody,
    errClass.signature,
    errClass.confidence,
  );
  auditTrackA(
    contractId,
    'CONFLICT_RESOLVED',
    { track: 'A', upstreamStatus: 409, url, retryStatus: retry.status },
    result,
  );
  recordResilienceTelemetry({
    service: options.service ?? 'upstream',
    endpoint: url,
    method: (init?.method ?? 'POST').toUpperCase(),
    statusCode: 409,
    family: 'conflict',
    severity: 'medium',
    normalizedReason: errClass.normalized.message,
    vendor: errClass.normalized.vendor,
    fixApplied: 'idempotency_retry',
    resolutionTier: 'deterministic_rule',
    fallbackUsed: false,
    confidence: errClass.confidence,
    retryAttempts: 1,
    signature: errClass.signature,
    outcome: retry.ok ? 'RECOVERED' : 'DEGRADED',
  });

  const headers = new Headers(retry.headers);
  headers.set('x-api-healer-status', 'CONFLICT_RESOLVED');
  const res = new Response(retry.body, {
    status: retry.status,
    statusText: retry.statusText,
    headers,
  });
  return attach(res, result, errClass);
}

// ─── main entrypoint ─────────────────────────────────────────────────────────

export async function healerFetch(
  url: string,
  init?: RequestInit,
  options?: HealerFetchOptions,
): Promise<HealerResponse> {
  const mutation = isMutation(init, options);

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (transportErr) {
    if (!options?.contractId) throw transportErr;
    return trackATransportFailure(transportErr, url, init, options, mutation);
  }

  if (!options?.contractId) return upstream as HealerResponse;

  // ── TRACK A · loud HTTP status failures ───────────────────────────────
  if (OVERLOAD_STATUSES.has(upstream.status)) {
    return trackAOverload(upstream, url, init, options, mutation);
  }
  if (VALIDATION_STATUSES.has(upstream.status)) {
    return trackAValidation(upstream, url, init, options);
  }
  if (AUTH_STATUSES.has(upstream.status)) {
    return trackAAuth(upstream, url, init, options);
  }
  if (NOT_FOUND_STATUSES.has(upstream.status)) {
    return trackANotFound(upstream, url, init, options, mutation);
  }
  if (upstream.status === 405) {
    return trackAMethodNotAllowed(upstream, url, init, options);
  }
  if (upstream.status === 409) {
    return trackAConflict(upstream, url, init, options);
  }

  // ── TRACK B · silent failures (200 OK with schema drift / malformed / hidden error) ──
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return upstream as HealerResponse;

  let body: unknown;
  let repairedSyntax = false;
  try {
    body = await upstream.clone().json();
  } catch {
    // Malformed JSON in a 200 OK response claimed as application/json
    const rawText = await upstream.clone().text().catch(() => '');
    const repaired = repairMalformedJson(rawText);
    if (repaired.safe && repaired.repaired) {
      body = repaired.repaired;
      repairedSyntax = true;
    } else {
      // Unrecoverable malformed JSON on a protected contract: serve LKG if available on read
      if (!mutation) {
        const lkg = (await getDurableLastKnownGood(options.contractId)) ?? options.safeDefault ?? null;
        if (lkg) {
          bumpRuntimeCounter('fallbackStale');
          const res = new Response(JSON.stringify(lkg), {
            status: 200,
            statusText: 'OK (api-healer malformed-json fallback)',
            headers: {
              'content-type': 'application/json',
              'x-api-healer': 'fallback-stale',
              'x-api-healer-status': 'FALLBACK_STALE',
              'x-api-healer-reason': 'malformed-json-body',
            },
          });
          return attach(
            res,
            trackAResult(
              options.contractId,
              'FALLBACK_STALE',
              'upstream returned 200 OK with corrupted JSON body — served cached last-known-good payload',
              0.5,
              lkg,
            ),
          );
        }
      }
      return upstream as HealerResponse;
    }
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return upstream as HealerResponse;
  }

  // Inspect for Partial Success (`{ data: {...}, errors: [...] }`) or Hidden Upstream Error
  const hiddenCheck = inspectSuccessBodyForHiddenError(body);
  let targetPayload = body as Record<string, unknown>;
  let unwrappedPartial = false;

  if (hiddenCheck.isPartialSuccess && hiddenCheck.extractedData) {
    targetPayload = hiddenCheck.extractedData;
    unwrappedPartial = true;
  }

  const result = await healRequest({
    contractId: options.contractId,
    payload: targetPayload,
    allowLlm: options.allowLlm,
    callsite: captureCallsite(),
  });

  // If `200 OK` was actually a disguised upstream error (`{ ok: false, error: ... }`)
  // and `healRequest` refused it, route through hidden error recovery!
  if (result.status === 'REFUSED' && hiddenCheck.isHiddenError) {
    const errClass = classifyHttpError(
      { status: 200, headers: upstream.headers },
      body,
      {
        url,
        method: init?.method ?? 'GET',
        contractId: options.contractId,
        isRead: !mutation,
        hasLkg: Boolean(result.servedPayload),
      },
    );
    recordResilienceTelemetry({
      service: options.service ?? 'upstream',
      endpoint: url,
      method: (init?.method ?? 'GET').toUpperCase(),
      statusCode: errClass.statusCode,
      family: errClass.family,
      severity: errClass.severity,
      normalizedReason: errClass.normalized.message,
      vendor: errClass.normalized.vendor,
      fixApplied: result.servedPayload && !mutation ? 'fallback_stale_payload' : 'protected_invalid_payload_rejection',
      resolutionTier: errClass.resolutionTier,
      fallbackUsed: Boolean(result.servedPayload && !mutation),
      confidence: errClass.confidence,
      retryAttempts: 0,
      signature: errClass.signature,
      outcome: result.servedPayload && !mutation ? 'FALLBACK' : 'REJECTED',
    });

    if (!mutation) {
      const lkg = result.servedPayload ?? (await getDurableLastKnownGood(options.contractId)) ?? options.safeDefault ?? null;
      if (lkg) {
        bumpRuntimeCounter('fallbackStale');
        const fallbackResult = trackAResult(
          options.contractId,
          'FALLBACK_STALE',
          `hidden upstream ${errClass.statusCode} (${errClass.normalized.code}) inside 200 OK — serving cached last-known-good payload`,
          result.timing.totalMs,
          lkg,
          errClass.signature,
          errClass.confidence,
        );
        const res = new Response(JSON.stringify(lkg), {
          status: 200,
          statusText: 'OK (api-healer hidden-error stale fallback)',
          headers: {
            'content-type': 'application/json',
            'x-api-healer': 'fallback-stale',
            'x-api-healer-status': 'FALLBACK_STALE',
            'x-api-healer-hidden-status': String(errClass.statusCode),
            'x-api-healer-family': errClass.family,
          },
        });
        return attach(res, fallbackResult, errClass);
      }
    }
  }

  // ── HOT PATH · passthrough short-circuit ─────────────────────────────
  // Healthy traffic with pristine JSON: return the original upstream Response
  // object untouched (body stream intact, zero reconstruction).
  if (result.status === 'PASSTHROUGH' && !repairedSyntax && !unwrappedPartial) {
    return attach(upstream, result);
  }

  // Drifted / syntax-repaired / refused / rolled back: reconstruct with telemetry headers.
  const payload = result.servedPayload ?? targetPayload;
  const headers = new Headers(upstream.headers);
  headers.set('x-api-healer-status', result.status);
  headers.set('x-api-healer-signature', result.signature.slice(0, 16));
  headers.set('x-api-healer-time-ms', result.timing.totalMs.toFixed(2));
  if (repairedSyntax) {
    headers.set('x-api-healer-syntax-repaired', 'true');
  }
  if (unwrappedPartial || hiddenCheck.isPartialSuccess) {
    headers.set('x-api-healer-partial', 'unwrapped');
  }

  const healed = new Response(JSON.stringify(payload), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  }) as HealerResponse;
  healed.__healer = result;
  return healed;
}
