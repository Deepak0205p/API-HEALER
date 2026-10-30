/**
 * API-HEALER · Hybrid HTTP Failure Recovery Engine (http-resilience.ts)
 * ----------------------------------------------------------------------
 * Centralized HTTP resilience layer combining:
 *   1. Error Normalizer   — normalizeHttpErrorPayload() across Stripe, AWS, GCP,
 *                           GraphQL, JSON:API, Rails, FastAPI, RFC 7807, HTML/text
 *                           gateway pages, network/TLS/DNS/CORS faults, and hidden
 *                           error envelopes inside 200 OK responses.
 *   2. Error Classifier   — classifyHttpError(response, error, context) producing
 *                           family, severity, confidence (0..1), DSA structural
 *                           signature, resolutionTier, and recommendedStrategy.
 *   3. Fix Registry       — 13 reusable, generic recovery handlers indexed by
 *                           strategy name.
 *   4. Strategy Resolver  — decideHandler(errorClass, signature, context) enforcing
 *                           priority scoring (deterministic -> signature -> semantic
 *                           -> safe degradation) and strict idempotency guards.
 *   5. Retry / Backoff    — computeBackoffDelay() & executeWithBackoff() honoring
 *                           Retry-After (seconds & HTTP-date), exponential backoff
 *                           with full jitter, and circuit-breaker short-circuiting.
 *   6. Telemetry Store    — structured in-memory ring buffer + runtime counters for
 *                           every classified and recovered HTTP failure.
 */
import { randomUUID } from 'crypto';
import {
  type HttpErrorFamily,
  type HttpErrorSeverity,
  type FixStrategyName,
  type VendorErrorFormat,
  type ResolutionTier,
  type NormalizedHttpError,
  type HttpErrorClassification,
  type ResilienceContext,
  type CustomErrorRule,
  registerCustomErrorRule,
  getCustomErrorRules,
  clearCustomErrorRules,
  getHeader,
  parseRetryAfterHeader,
  repairMalformedJson,
  inspectSuccessBodyForHiddenError,
  normalizeHttpErrorPayload,
  computeErrorSignature,
  classifyHttpError,
} from './http-classifier';

export {
  type HttpErrorFamily,
  type HttpErrorSeverity,
  type FixStrategyName,
  type VendorErrorFormat,
  type ResolutionTier,
  type NormalizedHttpError,
  type HttpErrorClassification,
  type ResilienceContext,
  type CustomErrorRule,
  registerCustomErrorRule,
  getCustomErrorRules,
  clearCustomErrorRules,
  getHeader,
  parseRetryAfterHeader,
  repairMalformedJson,
  inspectSuccessBodyForHiddenError,
  normalizeHttpErrorPayload,
  computeErrorSignature,
  classifyHttpError,
};

export interface FixHandlerDescriptor {
  name: FixStrategyName;
  description: string;
  mutatesRequest: boolean;
  requiresIdempotency: boolean;
  canRetry: boolean;
  apply: (ctx: {
    classification: HttpErrorClassification;
    context: ResilienceContext;
  }) => {
    action: FixStrategyName;
    shouldRetry: boolean;
    useFallback: boolean;
    failClosed: boolean;
    notes: string;
  };
}

export interface ResilienceTelemetryEntry {
  id: string;
  correlationId: string;
  timestamp: number;
  service: string;
  endpoint: string;
  method: string;
  statusCode: number;
  family: HttpErrorFamily;
  severity: HttpErrorSeverity;
  normalizedReason: string;
  vendor: VendorErrorFormat;
  fixApplied: FixStrategyName;
  resolutionTier: ResolutionTier;
  fallbackUsed: boolean;
  confidence: number;
  retryAttempts: number;
  signature: string;
  outcome: 'RECOVERED' | 'FALLBACK' | 'DEGRADED' | 'REJECTED';
}

// ─── Global Registries (process-safe singletons) ─────────────────────────────

export type AuthRefreshFn = (context: {
  url: string;
  status: number;
  contractId?: string;
}) => Promise<string | null> | string | null;

export type ConflictResolverFn = (
  sentBody: Record<string, unknown>,
  conflictBody: unknown,
) => Record<string, unknown> | null;

interface ResilienceGlobalState {
  telemetry: ResilienceTelemetryEntry[];
  endpointFallbacks: Map<string, string>;
  authRefreshers: Map<string, AuthRefreshFn>;
  defaultAuthRefresher: AuthRefreshFn | null;
  conflictResolvers: Map<string, ConflictResolverFn>;
}

const MAX_TELEMETRY_ENTRIES = 250;

const globalForResilience = globalThis as unknown as {
  __apiHealerResilience?: ResilienceGlobalState;
};

function resilienceState(): ResilienceGlobalState {
  if (!globalForResilience.__apiHealerResilience) {
    globalForResilience.__apiHealerResilience = {
      telemetry: [],
      endpointFallbacks: new Map(),
      authRefreshers: new Map(),
      defaultAuthRefresher: null,
      conflictResolvers: new Map(),
    };
  }
  return globalForResilience.__apiHealerResilience;
}

export function registerEndpointFallback(fromUrlOrPattern: string, toUrl: string): void {
  resilienceState().endpointFallbacks.set(fromUrlOrPattern, toUrl);
}

export function lookupEndpointFallback(
  url: string,
  localMap?: Record<string, string>,
): string | null {
  if (localMap) {
    if (localMap[url]) return localMap[url];
    for (const [pattern, target] of Object.entries(localMap)) {
      if (url.endsWith(pattern) || url.includes(pattern)) {
        return url.replace(pattern, target);
      }
    }
  }
  const map = resilienceState().endpointFallbacks;
  if (map.has(url)) return map.get(url)!;
  for (const [pattern, target] of map.entries()) {
    if (url.endsWith(pattern) || url.includes(pattern)) {
      return url.replace(pattern, target);
    }
  }
  return null;
}

export function registerAuthRefreshHandler(
  handler: AuthRefreshFn | null,
  contractId?: string,
): void {
  const s = resilienceState();
  if (contractId) {
    if (handler) s.authRefreshers.set(contractId, handler);
    else s.authRefreshers.delete(contractId);
  } else {
    s.defaultAuthRefresher = handler;
  }
}

export function getAuthRefreshHandler(
  contractId?: string,
  localFn?: AuthRefreshFn,
): AuthRefreshFn | null {
  if (localFn) return localFn;
  const s = resilienceState();
  if (contractId && s.authRefreshers.has(contractId)) {
    return s.authRefreshers.get(contractId)!;
  }
  return s.defaultAuthRefresher;
}

export function registerConflictResolver(
  contractId: string,
  resolver: ConflictResolverFn | null,
): void {
  const s = resilienceState();
  if (resolver) s.conflictResolvers.set(contractId, resolver);
  else s.conflictResolvers.delete(contractId);
}

export function getConflictResolver(
  contractId?: string,
  localFn?: ConflictResolverFn,
): ConflictResolverFn | null {
  if (localFn) return localFn;
  if (contractId) return resilienceState().conflictResolvers.get(contractId) ?? null;
  return null;
}

export function resetResilienceRegistries(): void {
  const s = resilienceState();
  s.telemetry = [];
  clearCustomErrorRules();
  s.endpointFallbacks.clear();
  s.authRefreshers.clear();
  s.defaultAuthRefresher = null;
  s.conflictResolvers.clear();
}

// ─── Central Fix Registry (13 Reusable Handlers) ─────────────────────────────

export const FIX_REGISTRY: Record<FixStrategyName, FixHandlerDescriptor> = {
  auth_refresh: {
    name: 'auth_refresh',
    description: 'Refresh expired/stale authentication token and retry request once',
    mutatesRequest: true,
    requiresIdempotency: false,
    canRetry: true,
    apply: ({ context }) => ({
      action: 'auth_refresh',
      shouldRetry: Boolean(context.hasAuthRefresh && (context.attempt ?? 0) < 1),
      useFallback: false,
      failClosed: !context.hasAuthRefresh,
      notes: context.hasAuthRefresh
        ? 'Refreshing credentials via registered token provider and retrying once'
        : 'No auth refresh handler registered; returning structured re-auth signal',
    }),
  },

  retry_with_backoff: {
    name: 'retry_with_backoff',
    description: 'Exponential backoff retry for transient server or network errors on safe requests',
    mutatesRequest: false,
    requiresIdempotency: true,
    canRetry: true,
    apply: ({ context }) => {
      const safeToRetry = context.isRead !== false || Boolean(context.hasIdempotencyKey);
      const underCap = (context.attempt ?? 0) < (context.maxRetries ?? 2);
      return {
        action: 'retry_with_backoff',
        shouldRetry: safeToRetry && underCap,
        useFallback: Boolean(context.hasLkg && context.isRead !== false),
        failClosed: !safeToRetry,
        notes: safeToRetry
          ? 'Transient fault on idempotent operation; eligible for exponential backoff retry'
          : 'Non-idempotent mutation; retry suppressed to prevent duplicate execution',
      };
    },
  },

  jittered_retry: {
    name: 'jittered_retry',
    description: 'Full-jitter exponential backoff retry to prevent thundering herd on timeouts',
    mutatesRequest: false,
    requiresIdempotency: true,
    canRetry: true,
    apply: ({ context }) => {
      const safeToRetry = context.isRead !== false || Boolean(context.hasIdempotencyKey);
      const underCap = (context.attempt ?? 0) < (context.maxRetries ?? 2);
      return {
        action: 'jittered_retry',
        shouldRetry: safeToRetry && underCap,
        useFallback: Boolean(context.hasLkg && context.isRead !== false),
        failClosed: !safeToRetry,
        notes: 'Applying full jitter backoff before retry',
      };
    },
  },

  circuit_breaker: {
    name: 'circuit_breaker',
    description: 'Trip/enforce per-contract circuit breaker to protect degraded upstream',
    mutatesRequest: false,
    requiresIdempotency: false,
    canRetry: false,
    apply: ({ context }) => ({
      action: 'circuit_breaker',
      shouldRetry: false,
      useFallback: Boolean(context.hasLkg && context.isRead !== false),
      failClosed: context.isRead === false,
      notes: 'Circuit breaker engaged; mutations fail-closed with 503 degraded envelope',
    }),
  },

  schema_normalization: {
    name: 'schema_normalization',
    description: 'Validate and normalize 200 OK response against contract via zero-eval JSON DSL',
    mutatesRequest: false,
    requiresIdempotency: false,
    canRetry: false,
    apply: () => ({
      action: 'schema_normalization',
      shouldRetry: false,
      useFallback: false,
      failClosed: false,
      notes: 'Routing 200 OK payload through Track B schema firewall and 3-gate validator',
    }),
  },

  fallback_stale_payload: {
    name: 'fallback_stale_payload',
    description: 'Serve verified Last-Known-Good (LKG) payload on read failures',
    mutatesRequest: false,
    requiresIdempotency: false,
    canRetry: false,
    apply: ({ context }) => ({
      action: 'fallback_stale_payload',
      shouldRetry: false,
      useFallback: Boolean(context.hasLkg && context.isRead !== false),
      failClosed: false,
      notes: 'Serving Last-Known-Good cached payload with x-api-healer: fallback-stale',
    }),
  },

  payload_repair: {
    name: 'payload_repair',
    description: 'Adapt outbound 400/422 request body via deterministic COERCE/RENAME/MOVE DSL',
    mutatesRequest: true,
    requiresIdempotency: false,
    canRetry: true,
    apply: ({ classification, context }) => ({
      action: 'payload_repair',
      shouldRetry:
        classification.normalized.payloadSafeToRepair && (context.attempt ?? 0) < 1,
      useFallback: false,
      failClosed: !classification.normalized.payloadSafeToRepair,
      notes: '400/422 means upstream did not execute request; single adapted retry is safe',
    }),
  },

  idempotency_retry: {
    name: 'idempotency_retry',
    description: 'Resolve 409 conflict or retry mutation safely with Idempotency-Key / conflictResolver',
    mutatesRequest: true,
    requiresIdempotency: true,
    canRetry: true,
    apply: ({ context }) => {
      const canResolve =
        Boolean(context.hasConflictResolver || context.hasIdempotencyKey) &&
        (context.attempt ?? 0) < 1;
      return {
        action: 'idempotency_retry',
        shouldRetry: canResolve,
        useFallback: false,
        failClosed: !canResolve,
        notes: canResolve
          ? 'Resolving conflict / retrying with idempotency guarantee'
          : 'No deterministic conflict resolver available; returning conflict details to caller',
      };
    },
  },

  rate_limit_wait: {
    name: 'rate_limit_wait',
    description: 'Respect Retry-After header, update circuit breaker cooldown, and queue/backoff safely',
    mutatesRequest: false,
    requiresIdempotency: true,
    canRetry: true,
    apply: ({ classification, context }) => {
      const retryAfter = classification.normalized.retryAfter ?? 0;
      const canWaitInline =
        retryAfter > 0 &&
        retryAfter <= 3 &&
        (context.isRead !== false || Boolean(context.hasIdempotencyKey)) &&
        (context.attempt ?? 0) < (context.maxRetries ?? 1);
      return {
        action: 'rate_limit_wait',
        shouldRetry: canWaitInline,
        useFallback: Boolean(context.hasLkg && context.isRead !== false),
        failClosed: context.isRead === false && !canWaitInline,
        notes: `Rate limited (Retry-After: ${retryAfter || 'unspecified'}s)`,
      };
    },
  },

  endpoint_remap: {
    name: 'endpoint_remap',
    description: 'Route 404/410 request to registered fallback/migrated endpoint URL',
    mutatesRequest: true,
    requiresIdempotency: false,
    canRetry: true,
    apply: ({ context }) => ({
      action: 'endpoint_remap',
      shouldRetry: Boolean(context.hasEndpointFallback && (context.attempt ?? 0) < 1),
      useFallback: Boolean(!context.hasEndpointFallback && context.hasLkg && context.isRead !== false),
      failClosed: false,
      notes: context.hasEndpointFallback
        ? 'Remapping request to alternate endpoint route'
        : 'No alternate endpoint registered',
    }),
  },

  method_correction: {
    name: 'method_correction',
    description: 'Inspect Allow header on 405 and retry only if target method is safe & idempotent',
    mutatesRequest: true,
    requiresIdempotency: true,
    canRetry: true,
    apply: ({ context }) => {
      const allowHeader = getHeader(context.headers, 'allow') ?? '';
      const allowed = allowHeader
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean);
      const safeTarget = allowed.find((m) => m === 'GET' || m === 'HEAD');
      const canCorrect =
        Boolean(safeTarget) &&
        context.allowMethodCorrection !== false &&
        (context.attempt ?? 0) < 1;
      return {
        action: 'method_correction',
        shouldRetry: canCorrect,
        useFallback: false,
        failClosed: !canCorrect,
        notes: canCorrect
          ? `Retrying 405 with safe allowed method ${safeTarget}`
          : 'No safe idempotent method advertised in Allow header; failing cleanly',
      };
    },
  },

  protected_invalid_payload_rejection: {
    name: 'protected_invalid_payload_rejection',
    description: 'Reject unrepairable or anomalous payload without mutating sensitive data',
    mutatesRequest: false,
    requiresIdempotency: false,
    canRetry: false,
    apply: ({ context }) => ({
      action: 'protected_invalid_payload_rejection',
      shouldRetry: false,
      useFallback: Boolean(context.hasLkg && context.isRead !== false),
      failClosed: true,
      notes: 'Unsafe or unrepairable payload rejected by policy',
    }),
  },

  safe_default_response: {
    name: 'safe_default_response',
    description: 'Return structured degraded envelope or caller-supplied safe default without crashing',
    mutatesRequest: false,
    requiresIdempotency: false,
    canRetry: false,
    apply: ({ context }) => ({
      action: 'safe_default_response',
      shouldRetry: false,
      useFallback: Boolean(context.safeDefault || (context.hasLkg && context.isRead !== false)),
      failClosed: context.isRead === false,
      notes: 'Graceful degradation applied',
    }),
  },
};

export function getFixHandler(strategy: FixStrategyName): FixHandlerDescriptor {
  return FIX_REGISTRY[strategy] ?? FIX_REGISTRY.safe_default_response;
}

// ─── Strategy Resolver Engine ────────────────────────────────────────────────

export interface ResolvedStrategyDecision {
  strategy: FixStrategyName;
  handler: FixHandlerDescriptor;
  tier: ResolutionTier;
  confidence: number;
  shouldRetry: boolean;
  useFallback: boolean;
  failClosed: boolean;
  rationale: string;
}

/**
 * Hybrid resolution decision engine:
 *   1. Low confidence (<0.65) forces safe degradation (no blind mutation/retry).
 *   2. Context-aware adaptation (e.g., if `fallback_stale_payload` is recommended
 *      but no LKG exists and retries are permitted on a read, escalates to
 *      `retry_with_backoff` / `jittered_retry`).
 *   3. Enforces idempotency on mutations.
 */
export function decideHandler(
  errorClass: HttpErrorClassification,
  _signature: string,
  context: ResilienceContext = {},
): ResolvedStrategyDecision {
  let strategy = errorClass.recommendedStrategy;
  let tier = errorClass.resolutionTier;
  const confidence = errorClass.confidence;

  // Low-confidence safety gate: never mutate requests or retry blindly
  if (confidence < 0.65) {
    strategy =
      context.isRead !== false && context.hasLkg
        ? 'fallback_stale_payload'
        : 'safe_default_response';
    tier = 'safe_degradation';
  } else {
    // Context refinement for reads/mutations
    if (strategy === 'fallback_stale_payload' && !context.hasLkg) {
      if (
        context.isRead !== false &&
        (context.maxRetries ?? 0) > 0 &&
        (errorClass.family === 'server' ||
          errorClass.family === 'timeout' ||
          errorClass.family === 'network')
      ) {
        strategy = errorClass.family === 'timeout' ? 'jittered_retry' : 'retry_with_backoff';
      } else {
        strategy = 'safe_default_response';
      }
    }

    if (strategy === 'auth_refresh' && !context.hasAuthRefresh) {
      strategy = 'safe_default_response';
    }

    if (strategy === 'endpoint_remap' && !context.hasEndpointFallback) {
      strategy =
        context.isRead !== false && context.hasLkg
          ? 'fallback_stale_payload'
          : 'safe_default_response';
    }

    if (
      strategy === 'idempotency_retry' &&
      !context.hasConflictResolver &&
      !context.hasIdempotencyKey
    ) {
      strategy = 'safe_default_response';
    }
  }

  const handler = getFixHandler(strategy);
  const applied = handler.apply({ classification: errorClass, context });

  return {
    strategy,
    handler,
    tier,
    confidence,
    shouldRetry: applied.shouldRetry,
    useFallback: applied.useFallback,
    failClosed: applied.failClosed,
    rationale: applied.notes,
  };
}

// ─── Exponential Backoff & Jitter Engine ─────────────────────────────────────

/**
 * Calculates wait time in ms using exponential backoff + full jitter,
 * honoring `Retry-After` (in seconds) as a strict lower bound when present.
 */
export function computeBackoffDelay(
  attempt: number,
  options?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryAfterSec?: number | null;
    jitter?: boolean;
    randomFn?: () => number;
  },
): number {
  const base = options?.baseDelayMs ?? 150;
  const max = options?.maxDelayMs ?? 10_000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  const rand = options?.randomFn ? options.randomFn() : Math.random();
  const jittered =
    options?.jitter === false ? exp : Math.round(exp * (0.5 + 0.5 * Math.min(1, Math.max(0, rand))));

  if (
    options?.retryAfterSec !== undefined &&
    options?.retryAfterSec !== null &&
    Number.isFinite(options.retryAfterSec) &&
    options.retryAfterSec > 0
  ) {
    return Math.min(max, Math.max(jittered, options.retryAfterSec * 1000));
  }

  return Math.min(max, jittered);
}

// ─── Telemetry Recording & Querying ──────────────────────────────────────────

export function recordResilienceTelemetry(
  entry: Omit<ResilienceTelemetryEntry, 'id' | 'correlationId' | 'timestamp'> & {
    correlationId?: string;
    timestamp?: number;
  },
): ResilienceTelemetryEntry {
  const full: ResilienceTelemetryEntry = {
    id: `rt_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    correlationId: entry.correlationId ?? `corr_${randomUUID().slice(0, 8)}`,
    timestamp: entry.timestamp ?? Date.now(),
    ...entry,
  };
  const s = resilienceState();
  s.telemetry.unshift(full);
  if (s.telemetry.length > MAX_TELEMETRY_ENTRIES) {
    s.telemetry.length = MAX_TELEMETRY_ENTRIES;
  }
  return full;
}

export function getResilienceTelemetry(limit = 50): ResilienceTelemetryEntry[] {
  return resilienceState().telemetry.slice(0, limit);
}

export function resetResilienceTelemetry(): void {
  resilienceState().telemetry = [];
}

// ─── Resilient Client Fetch Wrapper (for UI / Internal API Calls) ────────────

export interface ResilientClientFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  service?: string;
  onUnauthorized?: () => Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Drop-in `fetch` wrapper for client/server API calls that automatically:
 *   • Applies an AbortController timeout (default 12s)
 *   • Retries transient 502/503/504/429 and network errors on GET/HEAD with
 *     jittered backoff
 *   • Supports automatic 401 token refresh via `onUnauthorized`
 *   • Accepts either `(url, options)` or `(url, init, extraOptions)`
 */
export async function resilientClientFetch(
  url: string,
  initOrOptions?: ResilientClientFetchOptions,
  extraOptions?: Partial<ResilientClientFetchOptions>,
): Promise<Response> {
  const merged: ResilientClientFetchOptions = {
    ...(initOrOptions ?? {}),
    ...(extraOptions ?? {}),
  };
  const method = (merged.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const maxRetries = merged.maxRetries ?? (isRead ? 2 : 0);
  const timeoutMs = merged.timeoutMs ?? 12_000;
  const baseDelayMs = merged.baseDelayMs ?? 120;
  const fetchFn = merged.fetchImpl ?? fetch;

  let currentHeaders = new Headers(merged.headers);
  let authRefreshed = false;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        ...merged,
        headers: currentHeaders,
        signal: merged.signal ?? controller.signal,
      });
      clearTimeout(timeoutId);

      // Handle 401 Unauthorized via onUnauthorized token refresh callback (once)
      if (res.status === 401 && !authRefreshed && typeof merged.onUnauthorized === 'function') {
        authRefreshed = true;
        const freshToken = await merged.onUnauthorized();
        if (freshToken) {
          currentHeaders = new Headers(currentHeaders);
          currentHeaders.set(
            'Authorization',
            freshToken.startsWith('Bearer ') ? freshToken : `Bearer ${freshToken}`,
          );
          continue;
        }
      }

      if (
        !res.ok &&
        (isRead || merged.maxRetries !== undefined) &&
        attempt < maxRetries &&
        (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504)
      ) {
        const retryAfterSec = parseRetryAfterHeader(res.headers.get('retry-after'));
        const delay = computeBackoffDelay(attempt, {
          baseDelayMs,
          maxDelayMs: 2_000,
          retryAfterSec,
        });
        attempt += 1;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      if ((isRead || merged.maxRetries !== undefined) && attempt < maxRetries) {
        const delay = computeBackoffDelay(attempt, { baseDelayMs, maxDelayMs: 1_500 });
        attempt += 1;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

