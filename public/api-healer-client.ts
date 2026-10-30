/**
 * ─────────────────────────────────────────────────────────────────────────────
 * API-HEALER · Universal HTTP Resilience & Schema Drift Auto-Patcher SDK
 * ─────────────────────────────────────────────────────────────────────────────
 * Zero dependencies. Copy this single file into any TypeScript/JavaScript
 * project (Node ≥18, Bun, Deno, Next.js, Express, Browser) to automatically
 * detect, classify, and self-heal BOTH:
 *
 *   TRACK A · Multi-Status HTTP & Transport Failures:
 *     • 400 / 422 Validation     → Outbound payload field rename / type coercion + 1 retry
 *     • 401 / 403 Auth Expiry    → Automatic token refresh via authRefresh hook + 1 retry
 *     • 404 / 410 Route Fallback → Automatic endpoint remapping via endpointFallbacks + 1 retry
 *     • 405 Method Not Allowed   → Safe idempotent method correction via Allow header (GET/HEAD)
 *     • 409 Conflict             → Optimistic concurrency merge via conflictResolver + 1 retry
 *     • 429 Too Many Requests    → Honors Retry-After (seconds & HTTP-date) + jittered wait
 *     • 500 / 502 / 503 / 504    → Exponential backoff + full jitter + circuit breaker + LKG fallback
 *     • Network / Timeout / DNS / TLS / CORS → Bounded retry on safe reads, fail-closed on TLS/writes
 *
 *   TRACK B · Silent 200 OK Failures & Schema Drift:
 *     • Malformed 200 OK JSON (BOM, XSSI prefix `)]}'`, markdown fences, trailing commas)
 *     • Partial-success 200 OK envelopes (`{ data: {...}, errors: [...] }`)
 *     • Disguised/hidden vendor errors inside 200 OK (`{ ok: false, error: ... }`, GraphQL, AWS, GCP, Stripe)
 *     • Schema drift (RENAME / MOVE / TYPE / MISSING / 4.5σ SPIKE) via the API-HEALER firewall
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type HttpErrorFamily =
  | 'auth'
  | 'validation'
  | 'rate_limit'
  | 'not_found'
  | 'conflict'
  | 'timeout'
  | 'network'
  | 'server'
  | 'schema_drift'
  | 'unknown';

export type FixStrategyName =
  | 'auth_refresh'
  | 'retry_with_backoff'
  | 'jittered_retry'
  | 'circuit_breaker'
  | 'schema_normalization'
  | 'fallback_stale_payload'
  | 'payload_repair'
  | 'idempotency_retry'
  | 'rate_limit_wait'
  | 'endpoint_remap'
  | 'method_correction'
  | 'protected_invalid_payload_rejection'
  | 'safe_default_response';

export type VendorErrorFormat =
  | 'stripe'
  | 'aws'
  | 'gcp'
  | 'graphql'
  | 'jsonapi'
  | 'rails'
  | 'fastapi'
  | 'rfc7807'
  | 'custom'
  | 'standard';

export interface NormalizedHttpError {
  code: string;
  status: number;
  message: string;
  details: Record<string, unknown>;
  retryAfter: number | null;
  retryable: boolean;
  authRequired: boolean;
  payloadSafeToRepair: boolean;
  vendor: VendorErrorFormat;
  confidence: number;
  hiddenError: boolean;
  partialSuccess: boolean;
  extractedData?: Record<string, unknown> | null;
}

export interface HttpErrorClassification {
  statusCode: number;
  family: HttpErrorFamily;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  signature: string;
  recommendedStrategy: FixStrategyName;
  resolutionTier: 'deterministic_rule' | 'signature_match' | 'semantic_inference' | 'safe_degradation';
  normalized: NormalizedHttpError;
}

export type ClientAuthRefreshFn = (ctx: {
  url: string;
  status: number;
  contract: string;
}) => Promise<string | null | undefined> | string | null | undefined;

export type ClientConflictResolverFn = (
  sentBody: Record<string, unknown>,
  conflictBody: unknown,
) => Record<string, unknown> | null;

export interface HealerClientConfig {
  /** Base URL of your API-HEALER server, e.g. "http://localhost:3000" */
  server: string;
  /** Optional default timeout for upstream and heal calls (ms). Default 8000. */
  timeoutMs?: number;
  /** Extra headers sent to the firewall (e.g. auth) */
  headers?: Record<string, string>;
  /** Optional global auth refresh callback for 401 / expired-token 403 recovery */
  authRefresh?: ClientAuthRefreshFn;
  /** Optional global endpoint fallback map for 404 / 410 recovery */
  endpointFallbacks?: Record<string, string>;
  /** Optional global conflict resolver for 409 responses */
  conflictResolver?: ClientConflictResolverFn;
  /** Default max retries for transient 429/502/503/504/network failures on safe reads (default 2) */
  maxRetries?: number;
}

let config: HealerClientConfig | null = null;

/** In-memory Last-Known-Good (LKG) cache & Circuit Breaker Registry for the SDK */
const clientLkgCache = new Map<string, Record<string, unknown>>();
const clientBreakerRegistry = new Map<
  string,
  { failures: number; openedAt: number | null; cooldownMs: number; reason: string | null }
>();
const clientEndpointRemapCache = new Map<string, string>();

/** Call once at app bootstrap. */
export function configureHealer(cfg: HealerClientConfig): void {
  config = cfg;
}

export interface HealOutcome {
  status: string;
  drift: string;
  timeMs: number;
  message: string;
}

export class HealerRefusalError extends Error {
  readonly outcome: HealOutcome;
  /** The untouched raw upstream body — safe to inspect, never served by accident. */
  readonly rawPayload: unknown;
  constructor(outcome: HealOutcome, rawPayload: unknown) {
    super(`API-HEALER ${outcome.status}: ${outcome.message}`);
    this.name = 'HealerRefusalError';
    this.outcome = outcome;
    this.rawPayload = rawPayload;
  }
}

export interface HealOptions {
  /** The contract ID from the API-HEALER dashboard for this upstream. */
  contract: string;
  /** Allow the LLM composer tier for novel/ambiguous drifts. Default true. */
  allowLlm?: boolean;
  /** Throw HealerRefusalError on REFUSED / ROLLED_BACK instead of returning the body. Default false. */
  throwOnRefusal?: boolean;
  /** Per-call token refresh callback for 401/403 recovery */
  authRefresh?: ClientAuthRefreshFn;
  /** Per-call endpoint fallback map for 404/410 route migrations */
  endpointFallbacks?: Record<string, string>;
  /** Per-call conflict resolver for 409 Conflict responses */
  conflictResolver?: ClientConflictResolverFn;
  /** Override max retries for transient 429/5xx/network errors on safe reads */
  maxRetries?: number;
  /** Safe fallback payload if upstream fails and no LKG is cached yet */
  safeDefault?: Record<string, unknown>;
}

// ─── Retry-After & Backoff Helpers ───────────────────────────────────────────

export function parseRetryAfterHeader(
  headerValue: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs) : null;
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, Math.ceil((parsedDate - nowMs) / 1000));
  }
  return null;
}

export function computeBackoffDelay(
  attempt: number,
  retryAfterSec?: number | null,
  baseDelayMs = 150,
  maxDelayMs = 8000,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt)));
  const jittered = Math.round(exp * (0.5 + 0.5 * Math.random()));
  if (retryAfterSec && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(maxDelayMs, Math.max(jittered, retryAfterSec * 1000));
  }
  return Math.min(maxDelayMs, jittered);
}

// ─── Safe Malformed JSON Repair & Hidden Error Inspection ────────────────────

export function repairMalformedJson(rawText: string): {
  repaired: Record<string, unknown> | null;
  safe: boolean;
} {
  if (typeof rawText !== 'string' || !rawText.trim()) return { repaired: null, safe: false };
  let cleaned = rawText.replace(/^\uFEFF/, '').trim();
  if (cleaned.startsWith(")]}'")) cleaned = cleaned.replace(/^\)\]\}',?\s*/, '');
  else if (/^while\s*\(\s*1\s*\)\s*;/.test(cleaned)) cleaned = cleaned.replace(/^while\s*\(\s*1\s*\)\s*;\s*/, '');
  const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) cleaned = fence[1].trim();
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { repaired: parsed as Record<string, unknown>, safe: true };
    }
    return { repaired: null, safe: false };
  } catch {
    return { repaired: null, safe: false };
  }
}

export function normalizeHttpErrorPayload(
  rawError: unknown,
  headers?: Headers | Record<string, string> | null,
  statusCode = 0,
): NormalizedHttpError {
  const retryAfterHeader =
    headers && typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : headers && typeof headers === 'object'
        ? ((headers as Record<string, string>)['retry-after'] ??
          (headers as Record<string, string>)['Retry-After'] ??
          null)
        : null;
  const retryAfter = parseRetryAfterHeader(retryAfterHeader);

  if (rawError instanceof Error) {
    const errAny = rawError as Error & { code?: string };
    const sysCode = String(errAny.code ?? rawError.name ?? 'NETWORK_ERROR');
    const full = `${sysCode} ${rawError.message}`;
    const isTimeout = /AbortError|TimeoutError|ETIMEDOUT|timeout|aborted/i.test(full);
    const isTls = /CERT_|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED|SSL/i.test(full);
    return {
      code: isTimeout ? 'REQUEST_TIMEOUT' : sysCode.toUpperCase(),
      status: statusCode || (isTimeout ? 504 : 0),
      message: rawError.message || 'Network failure',
      details: { name: rawError.name, code: sysCode },
      retryAfter,
      retryable: !isTls,
      authRequired: false,
      payloadSafeToRepair: false,
      vendor: 'standard',
      confidence: 0.95,
      hiddenError: false,
      partialSuccess: false,
    };
  }

  const obj =
    rawError && typeof rawError === 'object' && !Array.isArray(rawError)
      ? (rawError as Record<string, unknown>)
      : {};

  // Partial success check (`{ data: {...}, errors: [...] }`)
  if (
    obj.data &&
    typeof obj.data === 'object' &&
    !Array.isArray(obj.data) &&
    Object.keys(obj.data as Record<string, unknown>).length > 0 &&
    (Array.isArray(obj.errors) || Array.isArray(obj.warnings))
  ) {
    return {
      code: 'PARTIAL_SUCCESS',
      status: statusCode || 200,
      message: 'Partial payload returned with non-fatal errors',
      details: obj,
      retryAfter,
      retryable: false,
      authRequired: false,
      payloadSafeToRepair: true,
      vendor: 'graphql',
      confidence: 0.92,
      hiddenError: false,
      partialSuccess: true,
      extractedData: obj.data as Record<string, unknown>,
    };
  }

  const nestedErr =
    obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)
      ? (obj.error as Record<string, unknown>)
      : null;

  const vendor: VendorErrorFormat =
    nestedErr && typeof nestedErr.status === 'string' && Array.isArray(nestedErr.details)
      ? 'gcp'
      : nestedErr && (typeof nestedErr.type === 'string' || typeof nestedErr.param === 'string')
        ? 'stripe'
        : typeof obj.__type === 'string' || (obj.Error && typeof obj.Error === 'object')
          ? 'aws'
          : Array.isArray(obj.detail)
            ? 'fastapi'
            : Array.isArray(obj.errors)
              ? 'graphql'
              : obj.errors && typeof obj.errors === 'object'
                ? 'rails'
                : typeof obj.type === 'string' && typeof obj.title === 'string'
                  ? 'rfc7807'
                  : 'standard';

  const code = String(
    nestedErr?.code ??
      nestedErr?.status ??
      obj.code ??
      obj.__type ??
      `HTTP_${statusCode || 500}`,
  );
  const message = String(
    nestedErr?.message ??
      obj.message ??
      obj.detail ??
      obj.title ??
      (typeof obj.error === 'string' ? obj.error : 'Upstream HTTP error'),
  );
  const inferredStatus =
    statusCode >= 400
      ? statusCode
      : typeof nestedErr?.status === 'number'
        ? (nestedErr.status as number)
        : typeof obj.statusCode === 'number'
          ? (obj.statusCode as number)
          : obj.ok === false || obj.success === false
            ? 500
            : statusCode;

  return {
    code,
    status: inferredStatus,
    message,
    details: obj,
    retryAfter,
    retryable: [408, 429, 500, 502, 503, 504].includes(inferredStatus),
    authRequired: inferredStatus === 401 || /token|expired|unauthenticated/i.test(`${code} ${message}`),
    payloadSafeToRepair: inferredStatus === 400 || inferredStatus === 422,
    vendor,
    confidence: 0.9,
    hiddenError: statusCode >= 200 && statusCode < 300 && (inferredStatus >= 400 || obj.ok === false || obj.success === false),
    partialSuccess: false,
  };
}

export function classifyHttpError(
  response: { status: number; headers?: Headers | Record<string, string> | null } | null,
  error: unknown,
): HttpErrorClassification {
  const status = response?.status ?? 0;
  const normalized = normalizeHttpErrorPayload(error, response?.headers, status);
  const effStatus = normalized.status || status;

  let family: HttpErrorFamily = 'unknown';
  let recommendedStrategy: FixStrategyName = 'safe_default_response';
  let severity: HttpErrorClassification['severity'] = 'medium';

  if (effStatus === 401 || effStatus === 403) {
    family = 'auth';
    recommendedStrategy = normalized.authRequired ? 'auth_refresh' : 'safe_default_response';
    severity = 'high';
  } else if (effStatus === 400 || effStatus === 422) {
    family = 'validation';
    recommendedStrategy = 'payload_repair';
  } else if (effStatus === 404 || effStatus === 410) {
    family = 'not_found';
    recommendedStrategy = 'endpoint_remap';
  } else if (effStatus === 405) {
    family = 'validation';
    recommendedStrategy = 'method_correction';
  } else if (effStatus === 409) {
    family = 'conflict';
    recommendedStrategy = 'idempotency_retry';
  } else if (effStatus === 429) {
    family = 'rate_limit';
    recommendedStrategy = 'rate_limit_wait';
    severity = 'high';
  } else if (effStatus === 504 || normalized.code === 'REQUEST_TIMEOUT') {
    family = 'timeout';
    recommendedStrategy = 'jittered_retry';
    severity = 'high';
  } else if (effStatus >= 500) {
    family = 'server';
    recommendedStrategy = 'retry_with_backoff';
    severity = 'high';
  } else if (effStatus === 0) {
    family = 'network';
    recommendedStrategy = normalized.retryable ? 'retry_with_backoff' : 'safe_default_response';
    severity = 'high';
  }

  return {
    statusCode: effStatus,
    family,
    severity,
    confidence: normalized.confidence,
    signature: `${family}:${effStatus}:${normalized.vendor}:${normalized.code}`,
    recommendedStrategy,
    resolutionTier: normalized.confidence >= 0.9 ? 'deterministic_rule' : 'signature_match',
    normalized,
  };
}

let originalGlobalFetch: typeof globalThis.fetch | null = null;

/**
 * 1-Click Auto-Interceptor:
 * Patches globalThis.fetch so matching endpoints are automatically healed across
 * all HTTP status classes and 200 OK schema drifts with zero callsite changes.
 */
export function enableAutoHeal(opts: {
  server?: string;
  contract: string;
  matchUrls?: (string | RegExp)[];
  allowLlm?: boolean;
  authRefresh?: ClientAuthRefreshFn;
  endpointFallbacks?: Record<string, string>;
  conflictResolver?: ClientConflictResolverFn;
}): () => void {
  if (opts.server) {
    configureHealer({
      server: opts.server,
      authRefresh: opts.authRefresh,
      endpointFallbacks: opts.endpointFallbacks,
      conflictResolver: opts.conflictResolver,
    });
  }
  if (typeof globalThis.fetch !== 'function') return () => {};
  if (!originalGlobalFetch) {
    originalGlobalFetch = globalThis.fetch.bind(globalThis);
  }
  const baseFetch = originalGlobalFetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (urlStr.includes('/api/heal') || urlStr.includes('/api/resilience')) {
      return baseFetch(input, init);
    }

    const shouldIntercept =
      !opts.matchUrls ||
      opts.matchUrls.length === 0 ||
      opts.matchUrls.some((m) => (typeof m === 'string' ? urlStr.includes(m) : m.test(urlStr)));

    if (!shouldIntercept) {
      return baseFetch(input, init);
    }

    return healerFetch(urlStr, init, {
      contract: opts.contract,
      allowLlm: opts.allowLlm,
      authRefresh: opts.authRefresh,
      endpointFallbacks: opts.endpointFallbacks,
      conflictResolver: opts.conflictResolver,
    });
  };

  return () => {
    if (originalGlobalFetch) {
      globalThis.fetch = originalGlobalFetch;
    }
  };
}

/**
 * Fetch any upstream through the Universal HTTP Resilience & Schema Firewall.
 * Drop-in replacement for fetch(): handles 400, 401, 403, 404, 405, 409, 410,
 * 422, 429, 500, 502, 503, 504, network/timeout faults, and 200 OK drift.
 */
export async function healerFetch(
  url: string,
  init: RequestInit = {},
  opts: HealOptions,
): Promise<Response> {
  const baseFetch = originalGlobalFetch ?? fetch;
  const method = (init.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const maxRetries = opts.maxRetries ?? config?.maxRetries ?? (isRead ? 2 : 0);
  const timeoutMs = config?.timeoutMs ?? 8000;

  // Apply learned route remap if this URL was previously migrated on 404/410
  let targetUrl = clientEndpointRemapCache.get(url) ?? url;

  // Check circuit breaker before hitting upstream
  const breaker = clientBreakerRegistry.get(opts.contract);
  if (breaker?.openedAt && Date.now() - breaker.openedAt < breaker.cooldownMs) {
    const lkg = clientLkgCache.get(opts.contract) ?? opts.safeDefault;
    if (isRead && lkg) {
      return new Response(JSON.stringify(lkg), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-api-healer': 'fallback-stale',
          'x-api-healer-status': 'FALLBACK_STALE',
        },
      });
    }
  }

  let raw: Response;
  let attempt = 0;
  while (true) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      raw = await baseFetch(targetUrl, {
        ...init,
        signal: init.signal ?? ctrl.signal,
      });
      clearTimeout(timer);

      if (
        !raw.ok &&
        isRead &&
        attempt < maxRetries &&
        (raw.status === 429 || raw.status === 500 || raw.status === 502 || raw.status === 503 || raw.status === 504)
      ) {
        const retryAfterSec = parseRetryAfterHeader(raw.headers.get('retry-after'));
        const delay = computeBackoffDelay(attempt, retryAfterSec);
        attempt += 1;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    } catch (transportErr) {
      clearTimeout(timer);
      const errClass = classifyHttpError(null, transportErr);
      if (isRead && errClass.normalized.retryable && attempt < maxRetries) {
        const delay = computeBackoffDelay(attempt);
        attempt += 1;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const lkg = clientLkgCache.get(opts.contract) ?? opts.safeDefault;
      if (isRead && lkg) {
        return new Response(JSON.stringify(lkg), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-api-healer': 'fallback-stale',
            'x-api-healer-status': 'FALLBACK_STALE',
            'x-api-healer-family': errClass.family,
          },
        });
      }
      return new Response(
        JSON.stringify({
          ok: false,
          degraded: true,
          code: `API_HEALER_${errClass.normalized.code}`,
          reason: errClass.normalized.message,
          family: errClass.family,
        }),
        {
          status: errClass.family === 'timeout' ? 504 : 503,
          headers: {
            'content-type': 'application/json',
            'x-api-healer-status': 'DEGRADED',
          },
        },
      );
    }
  }

  // ── 401 / 403 Auth Refresh Recovery ─────────────────────────────────────
  if (raw.status === 401 || raw.status === 403) {
    const refreshFn = opts.authRefresh ?? config?.authRefresh;
    if (refreshFn) {
      const freshToken = await refreshFn({ url: targetUrl, status: raw.status, contract: opts.contract });
      if (freshToken) {
        const retryHeaders = new Headers(init.headers);
        retryHeaders.set(
          'authorization',
          freshToken.startsWith('Bearer ') ? freshToken : `Bearer ${freshToken}`,
        );
        const retryRes = await baseFetch(targetUrl, { ...init, headers: retryHeaders });
        if (retryRes.ok) {
          const headers = new Headers(retryRes.headers);
          headers.set('x-api-healer-status', 'AUTH_REFRESHED');
          return new Response(retryRes.body, { status: retryRes.status, headers });
        }
      }
    }
  }

  // ── 404 / 410 Endpoint Remap Recovery ───────────────────────────────────
  if (raw.status === 404 || raw.status === 410) {
    const fallbackMap = { ...(config?.endpointFallbacks ?? {}), ...(opts.endpointFallbacks ?? {}) };
    const remapped = fallbackMap[targetUrl];
    if (remapped && remapped !== targetUrl) {
      clientEndpointRemapCache.set(url, remapped);
      targetUrl = remapped;
      const retryRes = await baseFetch(targetUrl, init);
      const headers = new Headers(retryRes.headers);
      headers.set('x-api-healer-status', 'ENDPOINT_REMAPPED');
      headers.set('x-api-healer-remapped-to', targetUrl);
      return new Response(retryRes.body, { status: retryRes.status, headers });
    }
  }

  // ── 405 Safe Method Correction (GET / HEAD only) ────────────────────────
  if (raw.status === 405) {
    const allow = (raw.headers.get('allow') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase());
    const safeMethod = allow.find((m) => m === 'GET' || m === 'HEAD');
    if (safeMethod && safeMethod !== method) {
      const retryRes = await baseFetch(targetUrl, { ...init, method: safeMethod, body: undefined });
      const headers = new Headers(retryRes.headers);
      headers.set('x-api-healer-status', 'METHOD_CORRECTED');
      return new Response(retryRes.body, { status: retryRes.status, headers });
    }
  }

  // ── 409 Optimistic Concurrency Conflict Resolution ──────────────────────
  if (raw.status === 409 && typeof init.body === 'string') {
    const resolver = opts.conflictResolver ?? config?.conflictResolver;
    if (resolver) {
      try {
        const sent = JSON.parse(init.body) as Record<string, unknown>;
        const conflictPayload = await raw.clone().json().catch(() => null);
        const resolved = resolver(sent, conflictPayload);
        if (resolved) {
          const retryRes = await baseFetch(targetUrl, {
            ...init,
            body: JSON.stringify(resolved),
          });
          const headers = new Headers(retryRes.headers);
          headers.set('x-api-healer-status', 'CONFLICT_RESOLVED');
          return new Response(retryRes.body, { status: retryRes.status, headers });
        }
      } catch {
        // fall through
      }
    }
  }

  // ── 429 / 500 / 502 / 503 / 504 Breaker + Stale LKG / Degraded Envelope ─
  if (raw.status === 429 || raw.status >= 500) {
    const retryAfterSec = parseRetryAfterHeader(raw.headers.get('retry-after'));
    const prev = clientBreakerRegistry.get(opts.contract) ?? {
      failures: 0,
      openedAt: null,
      cooldownMs: 30_000,
      reason: null,
    };
    const failures = prev.failures + 1;
    clientBreakerRegistry.set(opts.contract, {
      failures,
      openedAt: failures >= 3 || raw.status === 429 ? Date.now() : prev.openedAt,
      cooldownMs: retryAfterSec ? Math.max(30_000, retryAfterSec * 1000) : 30_000,
      reason: `HTTP ${raw.status}`,
    });

    const lkg = clientLkgCache.get(opts.contract) ?? opts.safeDefault;
    if (isRead && lkg) {
      return new Response(JSON.stringify(lkg), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-api-healer': 'fallback-stale',
          'x-api-healer-status': 'FALLBACK_STALE',
        },
      });
    }
  }

  const contentType = raw.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return raw;

  let rawBody: unknown;
  try {
    rawBody = await raw.clone().json();
  } catch {
    const rawText = await raw.clone().text().catch(() => '');
    const repaired = repairMalformedJson(rawText);
    if (repaired.safe && repaired.repaired) {
      rawBody = repaired.repaired;
    } else {
      const lkg = clientLkgCache.get(opts.contract) ?? opts.safeDefault;
      if (isRead && lkg) {
        return new Response(JSON.stringify(lkg), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-api-healer-status': 'FALLBACK_STALE',
          },
        });
      }
      return raw;
    }
  }

  // Inspect 200 OK for partial-success `{ data, errors }` or disguised error `{ ok: false, error: ... }`
  const norm = normalizeHttpErrorPayload(rawBody, raw.headers, raw.status);
  if (norm.hiddenError) {
    const lkg = clientLkgCache.get(opts.contract) ?? opts.safeDefault;
    if (isRead && lkg) {
      return new Response(JSON.stringify(lkg), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-api-healer-status': 'FALLBACK_STALE',
          'x-api-healer-hidden-status': String(norm.status),
        },
      });
    }
  }

  const targetPayload = norm.partialSuccess && norm.extractedData ? norm.extractedData : rawBody;

  const healed = await healPayload(opts.contract, targetPayload, {
    allowLlm: opts.allowLlm,
    throwOnRefusal: opts.throwOnRefusal,
  });

  if (
    healed.meta.status === 'PASSTHROUGH' ||
    healed.meta.status === 'HEALED_COLD' ||
    healed.meta.status === 'HEALED_CACHED'
  ) {
    clientLkgCache.set(opts.contract, healed.body);
  }

  return new Response(JSON.stringify(healed.body), {
    status: raw.status,
    headers: {
      'content-type': 'application/json',
      'x-api-healer-status': attempt > 0 ? 'RETRIED_TRANSIENT' : healed.meta.status,
      'x-api-healer-drift': healed.meta.drift,
      'x-api-healer-time': String(healed.meta.timeMs),
      ...(norm.partialSuccess ? { 'x-api-healer-partial': 'unwrapped' } : {}),
    },
  });
}

/**
 * Heal a single payload against a contract without any upstream fetch —
 * useful for webhooks, queue consumers, or payloads you already hold.
 */
export async function healPayload(
  contract: string,
  payload: unknown,
  opts: { allowLlm?: boolean; throwOnRefusal?: boolean } = {},
): Promise<{ body: Record<string, unknown>; meta: HealOutcome }> {
  const cfg = config;
  if (!cfg) throw new Error('API-HEALER not configured — call configureHealer() first.');

  // ── Blast-radius sensor (Step 3): report WHERE this upstream is consumed.
  let callsite: string | null = null;
  try {
    const stack = new Error('api-healer-callsite').stack ?? '';
    const NOISE = ['node:internal', 'node_modules', 'api-healer-client', 'healPayload', 'healerFetch', 'internal/process'];
    for (const raw of stack.split('\n').slice(1)) {
      const frame = raw.trim();
      if (!frame.startsWith('at ')) continue;
      if (NOISE.some((n) => frame.includes(n))) continue;
      const m =
        frame.match(/(?:\((.+?):(\d+):\d+\)$)|^(?:at )?(.+?):(\d+):\d+$/) ||
        frame.match(/^(?:.*?@)?(.+?):(\d+):\d+$/);
      const file = m?.[1] ?? m?.[3] ?? null;
      const line = m?.[2] ?? m?.[4] ?? null;
      if (!file) continue;
      let f = file.startsWith('file://') ? file.slice(7) : file;
      f = f.replace(/^\/home\/[^/]+\//, '').replace(/^\/Users\/[^/]+\//, '');
      callsite = line ? `${f}:${line}` : f;
      break;
    }
  } catch {
    /* best-effort only */
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 5000);
  let res: Response;
  try {
    res = await fetch(`${cfg.server.replace(/\/$/, '')}/api/heal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.headers ?? {}),
        ...(callsite ? { 'x-api-healer-callsite': callsite } : {}),
      },
      body: JSON.stringify({ contractId: contract, payload, allowLlm: opts.allowLlm ?? true }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = (await res.json()) as Record<string, unknown> & {
    error?: string;
    status?: string;
    message?: string;
    servedPayload?: Record<string, unknown> | null;
    rawPayload?: Record<string, unknown>;
    timing?: { totalMs?: number };
    classification?: { driftType?: string };
  };
  if (data.error) throw new Error(`API-HEALER: ${data.error}`);

  const meta: HealOutcome = {
    status: data.status ?? 'ERROR',
    drift: data.classification?.driftType ?? 'NONE',
    timeMs: data.timing?.totalMs ?? -1,
    message: data.message ?? '',
  };

  const refused = meta.status === 'REFUSED' || meta.status === 'ROLLED_BACK';
  if (refused && opts.throwOnRefusal) {
    throw new HealerRefusalError(meta, data.rawPayload ?? payload);
  }

  return {
    body: (data.servedPayload ?? data.rawPayload ?? (payload as Record<string, unknown>)) as Record<string, unknown>,
    meta,
  };
}
