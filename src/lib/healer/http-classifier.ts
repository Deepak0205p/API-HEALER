/**
 * API-HEALER · Universal HTTP Error Classifier & Payload Normalizer (http-classifier.ts)
 * --------------------------------------------------------------------------------------
 * Foundational classification and normalization engine for the universal HTTP failure
 * recovery system:
 *   1. normalizeHttpErrorPayload(rawError, headers?, statusCode?)
 *      Normalizes Stripe, AWS, GCP, GraphQL, JSON:API, Rails, FastAPI/Pydantic,
 *      RFC 7807 Problem Details, gateway HTML/text pages, native Error/DOMException
 *      faults (timeout, DNS, TLS, connection reset, CORS), and disguised 200 OK
 *      error or partial-success envelopes into a single canonical NormalizedHttpError.
 *   2. classifyHttpError(response, error, context)
 *      Classifies any HTTP response failure, network exception, or disguised 200 OK
 *      error into an HttpErrorClassification with family, severity, confidence (0..1),
 *      DSA-style structural signature, resolutionTier, and recommendedStrategy.
 */
import { createHash } from 'crypto';

// ─── Taxonomy & Core Types ───────────────────────────────────────────────────

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

export type HttpErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

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

export type ResolutionTier =
  | 'deterministic_rule'
  | 'signature_match'
  | 'semantic_inference'
  | 'safe_degradation';

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
  /** True when the HTTP status was 2xx (or absent) but the body embeds an error */
  hiddenError: boolean;
  /** True when a 200/207 response contains both valid `data` and non-fatal `errors`/`warnings` */
  partialSuccess: boolean;
  extractedData?: Record<string, unknown> | null;
}

export interface HttpErrorClassification {
  statusCode: number;
  family: HttpErrorFamily;
  severity: HttpErrorSeverity;
  confidence: number;
  signature: string;
  recommendedStrategy: FixStrategyName;
  resolutionTier: ResolutionTier;
  normalized: NormalizedHttpError;
}

export interface ResilienceContext {
  url?: string;
  method?: string;
  contractId?: string;
  service?: string;
  isRead?: boolean;
  hasIdempotencyKey?: boolean;
  hasLkg?: boolean;
  hasAuthRefresh?: boolean;
  hasEndpointFallback?: boolean;
  hasConflictResolver?: boolean;
  allowMethodCorrection?: boolean;
  attempt?: number;
  maxRetries?: number;
  headers?: Headers | Record<string, string> | null;
  sentBody?: Record<string, unknown> | null;
  safeDefault?: Record<string, unknown> | null;
}

export interface CustomErrorRule {
  id: string;
  match: (normalized: NormalizedHttpError, statusCode: number, rawError: unknown) => boolean;
  family: HttpErrorFamily;
  severity: HttpErrorSeverity;
  strategy: FixStrategyName;
  confidence: number;
}

// ─── Custom Error Rule Registry (process-safe singleton) ─────────────────────

interface ClassifierGlobalState {
  customRules: CustomErrorRule[];
}

const globalForClassifier = globalThis as unknown as {
  __apiHealerClassifier?: ClassifierGlobalState;
};

function classifierState(): ClassifierGlobalState {
  if (!globalForClassifier.__apiHealerClassifier) {
    globalForClassifier.__apiHealerClassifier = {
      customRules: [],
    };
  }
  return globalForClassifier.__apiHealerClassifier;
}

export function registerCustomErrorRule(rule: CustomErrorRule): void {
  const s = classifierState();
  const idx = s.customRules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) s.customRules[idx] = rule;
  else s.customRules.push(rule);
}

export function getCustomErrorRules(): CustomErrorRule[] {
  return classifierState().customRules;
}

export function clearCustomErrorRules(): void {
  classifierState().customRules = [];
}

// ─── Header & Retry-After Helpers ────────────────────────────────────────────

export function getHeader(
  headers: Headers | Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? (headers as Headers).get(lower);
  }
  const rec = headers as Record<string, string>;
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Parses `Retry-After` from either integer/float seconds ("60") OR RFC 7231
 * HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT"), returning seconds >= 0.
 */
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
    const diffSec = Math.ceil((parsedDate - nowMs) / 1000);
    return Math.max(0, diffSec);
  }

  return null;
}

// ─── Safe Malformed JSON Repair ──────────────────────────────────────────────

/**
 * Repairs non-destructive transport wrappers around otherwise valid JSON:
 *   • UTF-8 BOM prefix
 *   • Google/Angular XSSI guard prefix `)]}',\n` or `while(1);`
 *   • Markdown ```json ... ``` wrapper fences
 *   • Trailing comma immediately before `}` or `]`
 * Never invents keys or values. Returns `{ repaired: null, safe: false }` if
 * the text is genuinely truncated or corrupt.
 */
export function repairMalformedJson(rawText: string): {
  repaired: Record<string, unknown> | null;
  safe: boolean;
  reason: string;
} {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { repaired: null, safe: false, reason: 'empty body' };
  }

  let cleaned = rawText.replace(/^\uFEFF/, '').trim();
  const adaptations: string[] = [];

  // 1. XSSI prefix `)]}',` or `while(1);`
  if (cleaned.startsWith(")]}'")) {
    cleaned = cleaned.replace(/^\)\]\}',?\s*/, '');
    adaptations.push('stripped XSSI prefix');
  } else if (/^while\s*\(\s*1\s*\)\s*;/.test(cleaned)) {
    cleaned = cleaned.replace(/^while\s*\(\s*1\s*\)\s*;\s*/, '');
    adaptations.push('stripped while(1) prefix');
  }

  // 2. Markdown code fence ```json ... ```
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
    adaptations.push('unwrapped markdown fence');
  }

  // 3. Trailing commas before } or ]
  const withoutTrailingCommas = cleaned.replace(/,\s*([}\]])/g, '$1');
  if (withoutTrailingCommas !== cleaned) {
    cleaned = withoutTrailingCommas;
    adaptations.push('removed trailing comma');
  }

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        repaired: parsed as Record<string, unknown>,
        safe: true,
        reason: adaptations.length > 0 ? adaptations.join(', ') : 'valid JSON',
      };
    }
    return { repaired: null, safe: false, reason: 'parsed value is not a JSON object' };
  } catch {
    return { repaired: null, safe: false, reason: 'unrecoverable malformed JSON' };
  }
}

// ─── Hidden Error & Partial Payload Detection ────────────────────────────────

const HIDDEN_STATUS_MAP: Record<string, number> = {
  UNAUTHENTICATED: 401,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  EXPIRED_TOKEN: 401,
  INVALID_TOKEN: 401,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  ACCESS_DENIED: 403,
  PERMISSION_DENIED: 403,
  INSUFFICIENT_SCOPE: 403,
  NOT_FOUND: 404,
  RESOURCE_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  OPTIMISTIC_LOCK_ERROR: 409,
  GONE: 410,
  BAD_USER_INPUT: 422,
  VALIDATION_ERROR: 422,
  INVALID_ARGUMENT: 400,
  INVALID_REQUEST_ERROR: 400,
  PARAMETER_UNKNOWN: 400,
  PARAMETER_MISSING: 400,
  BAD_REQUEST: 400,
  RATE_LIMITED: 429,
  RATE_LIMIT_EXCEEDED: 429,
  RESOURCE_EXHAUSTED: 429,
  THROTTLED: 429,
  THROTTLING: 429,
  TOO_MANY_REQUESTS: 429,
  PROVISIONED_THROUGHPUT_EXCEEDED: 429,
  INTERNAL_SERVER_ERROR: 500,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_UNAVAILABLE: 503,
  OVERLOADED: 503,
  GATEWAY_TIMEOUT: 504,
  DEADLINE_EXCEEDED: 504,
  TIMED_OUT: 504,
};

function inferStatusFromCodeOrMessage(code: string, message: string): number | null {
  const upper = code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (HIDDEN_STATUS_MAP[upper]) return HIDDEN_STATUS_MAP[upper];
  for (const [key, st] of Object.entries(HIDDEN_STATUS_MAP)) {
    if (upper.includes(key)) return st;
  }

  const msg = message.toLowerCase();
  if (/\b(?:jwt expired|token expired|invalid token|unauthenticated|login required)\b/.test(msg)) {
    return 401;
  }
  if (/\b(?:permission denied|insufficient scope|access denied|forbidden)\b/.test(msg)) {
    return 403;
  }
  if (/\b(?:rate limit|too many requests|quota exceeded|throttl)\b/.test(msg)) {
    return 429;
  }
  if (/\b(?:timed out|deadline exceeded|gateway timeout|etimedout)\b/.test(msg)) {
    return 504;
  }
  if (/\b(?:service unavailable|temporarily unavailable|overloaded|maintenance)\b/.test(msg)) {
    return 503;
  }
  if (/\b(?:conflict|already exists|optimistic lock|version mismatch)\b/.test(msg)) {
    return 409;
  }
  if (/\b(?:not found|does not exist|no such resource)\b/.test(msg)) {
    return 404;
  }
  if (/\b(?:unknown parameter|missing required|invalid_request_error)\b/.test(msg)) {
    return 400;
  }
  if (/\b(?:validation failed|must be a number|must be a string|invalid parameter|did you mean)\b/.test(msg)) {
    return 422;
  }
  return null;
}

/**
 * Inspects a 200 OK JSON object to detect whether it is actually a disguised
 * upstream error or a partial-success envelope (`{ data: {...}, errors: [...] }`).
 */
export function inspectSuccessBodyForHiddenError(body: unknown): {
  isHiddenError: boolean;
  isPartialSuccess: boolean;
  inferredStatus: number;
  extractedData: Record<string, unknown> | null;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      isHiddenError: false,
      isPartialSuccess: false,
      inferredStatus: 200,
      extractedData: null,
    };
  }

  const obj = body as Record<string, unknown>;

  // Check for Partial Success: `{ data: { ...non-empty object }, errors/warnings: [...] }`
  if (
    obj.data &&
    typeof obj.data === 'object' &&
    !Array.isArray(obj.data) &&
    Object.keys(obj.data as Record<string, unknown>).length > 0 &&
    (Array.isArray(obj.errors) || Array.isArray(obj.warnings) || obj.partial === true)
  ) {
    return {
      isHiddenError: false,
      isPartialSuccess: true,
      inferredStatus: 200,
      extractedData: obj.data as Record<string, unknown>,
    };
  }

  // Explicit failure boolean flags: `{ ok: false }`, `{ success: false }`
  const explicitFalseFlag = obj.ok === false || obj.success === false;

  // Explicit error status strings: `{ status: 'error' | 'fail' | 'failed' }`
  const statusStr = typeof obj.status === 'string' ? obj.status.toLowerCase() : '';
  const explicitErrorStatus =
    statusStr === 'error' || statusStr === 'fail' || statusStr === 'failed' || statusStr === 'err';

  // GraphQL errors with null/missing data: `{ errors: [{ message, extensions }] }`
  const isGraphqlFailure =
    Array.isArray(obj.errors) &&
    obj.errors.length > 0 &&
    (obj.data === null || obj.data === undefined);

  // Embedded numeric HTTP status code inside body: `{ statusCode: 401 }` or `{ error: { status: 429 } }`
  const nestedError =
    obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)
      ? (obj.error as Record<string, unknown>)
      : null;

  const embeddedNumericStatus =
    typeof obj.statusCode === 'number' && obj.statusCode >= 400
      ? obj.statusCode
      : typeof obj.httpStatus === 'number' && obj.httpStatus >= 400
        ? obj.httpStatus
        : typeof obj.status === 'number' && obj.status >= 400
          ? obj.status
          : typeof nestedError?.status === 'number' && nestedError.status >= 400
            ? (nestedError.status as number)
            : typeof nestedError?.code === 'number' && nestedError.code >= 400 && nestedError.code < 600
              ? (nestedError.code as number)
              : null;

  // AWS / Vendor top-level `{ Error: { Code, Message } }` or `{ __type: "...Exception" }`
  const hasVendorException =
    (obj.Error && typeof obj.Error === 'object') ||
    (typeof obj.__type === 'string' && /Exception|Error/i.test(obj.__type)) ||
    (nestedError !== null &&
      (typeof nestedError.code === 'string' ||
        typeof nestedError.message === 'string' ||
        typeof nestedError.type === 'string'));

  if (
    !explicitFalseFlag &&
    !explicitErrorStatus &&
    !isGraphqlFailure &&
    embeddedNumericStatus === null &&
    !hasVendorException
  ) {
    return {
      isHiddenError: false,
      isPartialSuccess: false,
      inferredStatus: 200,
      extractedData: null,
    };
  }

  const codeCandidate = String(
    nestedError?.code ??
      nestedError?.status ??
      nestedError?.type ??
      obj.errorCode ??
      obj.error_code ??
      obj.code ??
      obj.__type ??
      (isGraphqlFailure
        ? ((obj.errors as Record<string, any>[])[0]?.extensions?.code ?? 'GRAPHQL_ERROR')
        : ''),
  );
  const msgCandidate = String(
    nestedError?.message ??
      obj.error_message ??
      obj.errorMessage ??
      obj.message ??
      obj.reason ??
      (typeof obj.error === 'string' ? obj.error : '') ??
      (isGraphqlFailure ? ((obj.errors as Record<string, any>[])[0]?.message ?? '') : ''),
  );

  const inferred =
    embeddedNumericStatus ??
    inferStatusFromCodeOrMessage(codeCandidate, msgCandidate) ??
    500;

  return {
    isHiddenError: true,
    isPartialSuccess: false,
    inferredStatus: inferred,
    extractedData: null,
  };
}

// ─── Error Payload Normalizer ────────────────────────────────────────────────

/**
 * Normalizes any raw HTTP error payload, Error instance, vendor envelope, or
 * response metadata into a single canonical shape (`NormalizedHttpError`).
 */
export function normalizeHttpErrorPayload(
  rawError: unknown,
  headers?: Headers | Record<string, string> | null,
  statusCode = 0,
): NormalizedHttpError {
  // Support single-argument calls where rawError wraps `{ response: { status, headers, data/body } }`
  // or `{ status, headers, body }` (e.g., AxiosError / FetchError / custom HTTP client wrappers)
  let effectiveHeaders = headers;
  let effectiveStatusCode = statusCode;
  let targetError = rawError;

  if (targetError && typeof targetError === 'object') {
    const rec = targetError as Record<string, unknown>;
    const nestedResp =
      rec.response && typeof rec.response === 'object' && !Array.isArray(rec.response)
        ? (rec.response as Record<string, unknown>)
        : null;

    if (!effectiveHeaders) {
      if (nestedResp?.headers && typeof nestedResp.headers === 'object') {
        effectiveHeaders = nestedResp.headers as Headers | Record<string, string>;
      } else if (rec.headers && typeof rec.headers === 'object') {
        effectiveHeaders = rec.headers as Headers | Record<string, string>;
      }
    }

    if (!effectiveStatusCode) {
      if (typeof nestedResp?.status === 'number') {
        effectiveStatusCode = nestedResp.status;
      } else if (typeof rec.status === 'number' && rec.status >= 100 && rec.status < 600 && ('body' in rec || 'response' in rec)) {
        effectiveStatusCode = rec.status;
      }
    }

    if (nestedResp && ('data' in nestedResp || 'body' in nestedResp)) {
      targetError = nestedResp.data ?? nestedResp.body;
    } else if (!(targetError instanceof Error) && 'body' in rec && rec.body !== undefined && ('status' in rec || 'headers' in rec)) {
      targetError = rec.body;
    }
  }

  rawError = targetError;
  statusCode = effectiveStatusCode;
  const headerRetryAfter = parseRetryAfterHeader(getHeader(effectiveHeaders, 'retry-after'));

  // 1. Native Error / Network / Timeout / TLS / CORS exception
  if (rawError instanceof Error) {
    const errAny = rawError as Error & {
      code?: string;
      status?: number;
      statusCode?: number;
      cause?: { code?: string; errno?: number; syscall?: string; message?: string };
    };
    const sysCode = String(
      errAny.code ?? errAny.cause?.code ?? errAny.name ?? 'NETWORK_ERROR',
    );
    const fullMsg = `${rawError.name}: ${rawError.message}${errAny.cause?.message ? ` (${errAny.cause.message})` : ''}`;
    const errStatus = statusCode || errAny.status || errAny.statusCode || 0;
    const isTimeout =
      rawError.name === 'AbortError' ||
      rawError.name === 'TimeoutError' ||
      /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout|timed out|aborted/i.test(
        `${sysCode} ${fullMsg}`,
      );
    const isDnsOrTls = /ENOTFOUND|EAI_AGAIN|ERR_TLS|CERT_|SSL|TLS/i.test(`${sysCode} ${fullMsg}`);
    const isCors = /CORS|Cross-Origin|Failed to fetch|NetworkError/i.test(fullMsg);

    return {
      code: isTimeout
        ? 'REQUEST_TIMEOUT'
        : isDnsOrTls
          ? sysCode.toUpperCase()
          : isCors
            ? 'CORS_OR_NETWORK_ERROR'
            : sysCode.toUpperCase(),
      status: errStatus || (isTimeout ? 504 : 0),
      message: rawError.message || 'Network transport failure',
      details: {
        name: rawError.name,
        sysCode,
        syscall: errAny.cause?.syscall ?? null,
      },
      retryAfter: headerRetryAfter,
      retryable: !/CERT_|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|SSL_ERROR/i.test(
        `${sysCode} ${fullMsg}`,
      ), // TLS cert errors are not transient
      authRequired: errStatus === 401,
      payloadSafeToRepair: false,
      vendor: 'standard',
      confidence: 0.95,
      hiddenError: false,
      partialSuccess: false,
    };
  }

  // 2. If rawError is a string, try parsing as JSON or inspecting gateway HTML/text
  let parsedBody: unknown = rawError;
  if (typeof rawError === 'string') {
    const trimmed = rawError.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsedBody = JSON.parse(trimmed);
      } catch {
        const rep = repairMalformedJson(trimmed);
        if (rep.safe && rep.repaired) {
          parsedBody = rep.repaired;
        }
      }
    }
    if (typeof parsedBody === 'string') {
      const inferredStatus =
        statusCode ||
        (/504\s+Gateway\s+Time-?out/i.test(trimmed)
          ? 504
          : /502\s+Bad\s+Gateway/i.test(trimmed)
            ? 502
            : /503\s+Service\s+Temporarily\s+Unavailable/i.test(trimmed)
              ? 503
              : /429\s+Too\s+Many\s+Requests/i.test(trimmed)
                ? 429
                : 0);
      return {
        code: inferredStatus ? `HTTP_${inferredStatus}` : 'TEXT_ERROR_PAYLOAD',
        status: inferredStatus,
        message: trimmed.slice(0, 300),
        details: { rawText: trimmed.slice(0, 300) },
        retryAfter: headerRetryAfter,
        retryable: [408, 429, 500, 502, 503, 504].includes(inferredStatus),
        authRequired: inferredStatus === 401,
        payloadSafeToRepair: inferredStatus === 400 || inferredStatus === 422,
        vendor: 'standard',
        confidence: inferredStatus ? 0.9 : 0.65,
        hiddenError: statusCode >= 200 && statusCode < 300 && inferredStatus >= 400,
        partialSuccess: false,
      };
    }
  }

  // 3. Array of errors at root: `[{ code, message, field }]`
  if (Array.isArray(parsedBody)) {
    const first =
      parsedBody[0] && typeof parsedBody[0] === 'object'
        ? (parsedBody[0] as Record<string, unknown>)
        : {};
    const code = String(first.code ?? first.type ?? `HTTP_${statusCode || 400}`);
    const message = String(first.message ?? first.detail ?? first.msg ?? 'Multiple errors returned');
    const effStatus = statusCode || inferStatusFromCodeOrMessage(code, message) || 400;
    return {
      code,
      status: effStatus,
      message,
      details: { errors: parsedBody },
      retryAfter: headerRetryAfter,
      retryable: [429, 500, 502, 503, 504].includes(effStatus),
      authRequired: effStatus === 401,
      payloadSafeToRepair: effStatus === 400 || effStatus === 422,
      vendor: 'custom',
      confidence: 0.85,
      hiddenError: statusCode >= 200 && statusCode < 300,
      partialSuccess: false,
    };
  }

  // 4. Plain object inspection across vendor formats
  if (parsedBody && typeof parsedBody === 'object') {
    const obj = parsedBody as Record<string, unknown>;
    const hiddenCheck = inspectSuccessBodyForHiddenError(obj);
    const is2xx = statusCode >= 200 && statusCode < 300;

    // Extract body-level retryAfter if present
    const bodyRetryRaw =
      obj.retry_after ??
      obj.retryAfter ??
      (obj.error && typeof obj.error === 'object'
        ? (obj.error as Record<string, unknown>).retry_after ??
          (obj.error as Record<string, unknown>).retryAfter
        : undefined);
    const bodyRetryMs =
      obj.retryAfterMs ??
      obj.retry_after_ms ??
      (obj.error && typeof obj.error === 'object'
        ? (obj.error as Record<string, unknown>).retryAfterMs
        : undefined);
    const bodyRetrySec =
      typeof bodyRetryRaw === 'number'
        ? Math.ceil(bodyRetryRaw)
        : typeof bodyRetryRaw === 'string'
          ? parseRetryAfterHeader(bodyRetryRaw)
          : typeof bodyRetryMs === 'number'
            ? Math.ceil(bodyRetryMs / 1000)
            : null;
    const retryAfter = headerRetryAfter ?? bodyRetrySec;

    // 4a. Stripe / GCP `{ error: { type, code, param, message, status, details } }`
    if (obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)) {
      const errObj = obj.error as Record<string, unknown>;
      const isGcp =
        typeof errObj.status === 'string' &&
        (typeof errObj.code === 'number' || Array.isArray(errObj.details));
      const vendor: VendorErrorFormat = isGcp
        ? 'gcp'
        : typeof errObj.type === 'string' || typeof errObj.param === 'string'
          ? 'stripe'
          : 'custom';
      const code = String(
        errObj.status ?? errObj.code ?? errObj.type ?? `HTTP_${statusCode || 400}`,
      );
      const message = String(errObj.message ?? errObj.detail ?? 'Upstream error');
      const effStatus =
        !is2xx && statusCode > 0
          ? statusCode
          : typeof errObj.code === 'number' && errObj.code >= 400 && errObj.code < 600
            ? errObj.code
            : inferStatusFromCodeOrMessage(code, message) ?? (statusCode || 500);

      return {
        code,
        status: effStatus,
        message,
        details: errObj,
        retryAfter,
        retryable: [408, 429, 500, 502, 503, 504].includes(effStatus),
        authRequired: effStatus === 401 || /token|auth|expired/i.test(`${code} ${message}`),
        payloadSafeToRepair:
          (effStatus === 400 || effStatus === 422) &&
          (typeof errObj.param === 'string' || typeof errObj.fields === 'object'),
        vendor,
        confidence: 0.94,
        hiddenError: is2xx && effStatus >= 400,
        partialSuccess: false,
      };
    }

    // 4b. AWS `{ Error: { Code, Message } }` or `{ __type: "...Exception", message: "..." }`
    if (
      (obj.Error && typeof obj.Error === 'object') ||
      (typeof obj.__type === 'string' && /Exception|Error/i.test(obj.__type))
    ) {
      const awsErr =
        obj.Error && typeof obj.Error === 'object'
          ? (obj.Error as Record<string, unknown>)
          : obj;
      const code = String(awsErr.Code ?? obj.__type ?? 'AWS_ERROR').replace(/^.*#/, '');
      const message = String(awsErr.Message ?? awsErr.message ?? code);
      const effStatus =
        !is2xx && statusCode > 0
          ? statusCode
          : inferStatusFromCodeOrMessage(code, message) ?? (statusCode || 500);

      return {
        code,
        status: effStatus,
        message,
        details: awsErr,
        retryAfter,
        retryable:
          [429, 500, 502, 503, 504].includes(effStatus) ||
          /Throttling|ProvisionedThroughput|ServiceUnavailable|InternalError/i.test(code),
        authRequired:
          effStatus === 401 || /ExpiredToken|InvalidClientTokenId|AccessDenied/i.test(code),
        payloadSafeToRepair: effStatus === 400 || effStatus === 422,
        vendor: 'aws',
        confidence: 0.93,
        hiddenError: is2xx && effStatus >= 400,
        partialSuccess: false,
      };
    }

    // 4c. GraphQL `{ errors: [{ message, extensions: { code } }], data?: ... }`
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const first = (obj.errors[0] ?? {}) as Record<string, unknown>;
      const ext =
        first.extensions && typeof first.extensions === 'object'
          ? (first.extensions as Record<string, unknown>)
          : null;
      const source =
        first.source && typeof first.source === 'object'
          ? (first.source as Record<string, unknown>)
          : null;

      // Distinguish JSON:API (`source.pointer` or `detail`) vs GraphQL (`extensions` or `locations` or `data` key)
      const isJsonApi = Boolean(source?.pointer || first.detail || first.status);
      const vendor: VendorErrorFormat = isJsonApi ? 'jsonapi' : 'graphql';
      const code = String(
        ext?.code ?? first.code ?? first.title ?? `HTTP_${statusCode || 400}`,
      );
      const message = String(first.message ?? first.detail ?? first.title ?? 'Errors array');
      const effStatus =
        !is2xx && statusCode > 0
          ? statusCode
          : typeof first.status === 'string' && /^\d{3}$/.test(first.status)
            ? Number(first.status)
            : typeof first.status === 'number'
              ? first.status
              : inferStatusFromCodeOrMessage(code, message) ?? (statusCode || 400);

      return {
        code,
        status: effStatus,
        message,
        details: { errors: obj.errors },
        retryAfter,
        retryable: [429, 500, 502, 503, 504].includes(effStatus),
        authRequired: effStatus === 401 || /UNAUTHENTICATED|TOKEN_EXPIRED/i.test(code),
        payloadSafeToRepair:
          (effStatus === 400 || effStatus === 422) &&
          Boolean(source?.pointer || first.field || first.param),
        vendor,
        confidence: 0.91,
        hiddenError: is2xx && !hiddenCheck.isPartialSuccess,
        partialSuccess: hiddenCheck.isPartialSuccess,
        extractedData: hiddenCheck.extractedData,
      };
    }

    // 4d. Rails `{ errors: { field: ["..."] } }`
    if (obj.errors && typeof obj.errors === 'object' && !Array.isArray(obj.errors)) {
      const errs = obj.errors as Record<string, unknown>;
      const firstKey = Object.keys(errs)[0] ?? 'field';
      const firstVal = errs[firstKey];
      const message = `${firstKey}: ${Array.isArray(firstVal) ? firstVal.join(', ') : String(firstVal)}`;
      const effStatus = !is2xx && statusCode > 0 ? statusCode : 422;
      return {
        code: 'VALIDATION_FAILED',
        status: effStatus,
        message,
        details: { errors: errs },
        retryAfter,
        retryable: false,
        authRequired: false,
        payloadSafeToRepair: true,
        vendor: 'rails',
        confidence: 0.92,
        hiddenError: is2xx,
        partialSuccess: false,
      };
    }

    // 4e. FastAPI / Pydantic `{ detail: [{ loc: ["body", "amount"], msg: "...", type: "..." }] }`
    if (Array.isArray(obj.detail)) {
      const first = (obj.detail[0] ?? {}) as Record<string, unknown>;
      const loc = Array.isArray(first.loc) ? first.loc.join('.') : 'body';
      const msg = String(first.msg ?? 'Validation error');
      const effStatus = !is2xx && statusCode > 0 ? statusCode : 422;
      return {
        code: String(first.type ?? 'FASTAPI_VALIDATION_ERROR'),
        status: effStatus,
        message: `${loc}: ${msg}`,
        details: { detail: obj.detail },
        retryAfter,
        retryable: false,
        authRequired: false,
        payloadSafeToRepair: true,
        vendor: 'fastapi',
        confidence: 0.93,
        hiddenError: is2xx,
        partialSuccess: false,
      };
    }

    // 4f. RFC 7807 Problem Details `{ type, title, status, detail, invalid_params }`
    if (
      typeof obj.title === 'string' &&
      (typeof obj.type === 'string' || typeof obj.detail === 'string' || Array.isArray(obj.invalid_params))
    ) {
      const effStatus =
        typeof obj.status === 'number'
          ? obj.status
          : !is2xx && statusCode > 0
            ? statusCode
            : 400;
      return {
        code: String(obj.type ?? obj.title),
        status: effStatus,
        message: String(obj.detail ?? obj.title),
        details: obj,
        retryAfter,
        retryable: [429, 500, 502, 503, 504].includes(effStatus),
        authRequired: effStatus === 401,
        payloadSafeToRepair:
          (effStatus === 400 || effStatus === 422) && Array.isArray(obj.invalid_params),
        vendor: 'rfc7807',
        confidence: 0.9,
        hiddenError: is2xx && effStatus >= 400,
        partialSuccess: false,
      };
    }

    // 4g. Generic / custom object (`{ code, message, field, statusCode, ok: false, ... }`)
    const nestedData =
      obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
        ? (obj.data as Record<string, unknown>)
        : null;
    const code = String(
      obj.code ??
        obj.errorCode ??
        obj.error_code ??
        nestedData?.error_code ??
        nestedData?.code ??
        (typeof obj.error === 'string' ? obj.error : '') ??
        `HTTP_${statusCode || 500}`,
    );
    const message = String(
      obj.message ??
        obj.detail ??
        obj.reason ??
        obj.error_message ??
        obj.errorMessage ??
        nestedData?.error_message ??
        (typeof obj.error === 'string' ? obj.error : '') ??
        `HTTP ${statusCode || 'error'}`,
    );
    const effStatus =
      hiddenCheck.isHiddenError
        ? hiddenCheck.inferredStatus
        : !is2xx && statusCode > 0
          ? statusCode
          : inferStatusFromCodeOrMessage(code, message) ?? statusCode;

    return {
      code,
      status: effStatus,
      message,
      details: obj,
      retryAfter,
      retryable: [408, 429, 500, 502, 503, 504].includes(effStatus),
      authRequired:
        effStatus === 401 ||
        /\b(?:jwt expired|token expired|invalid token|unauthenticated)\b/i.test(
          `${code} ${message}`,
        ),
      payloadSafeToRepair:
        (effStatus === 400 || effStatus === 422) &&
        (typeof obj.field === 'string' ||
          /\b(?:did you mean|use .* instead of|must be a (?:number|string|boolean|integer))\b/i.test(
            message,
          )),
      vendor: hiddenCheck.isHiddenError ? 'custom' : 'standard',
      confidence: effStatus > 0 ? 0.88 : 0.65,
      hiddenError: hiddenCheck.isHiddenError,
      partialSuccess: hiddenCheck.isPartialSuccess,
      extractedData: hiddenCheck.extractedData,
    };
  }

  return {
    code: `HTTP_${statusCode || 'UNKNOWN'}`,
    status: statusCode,
    message: `HTTP status ${statusCode || 'unknown'}`,
    details: {},
    retryAfter: headerRetryAfter,
    retryable: [408, 429, 500, 502, 503, 504].includes(statusCode),
    authRequired: statusCode === 401,
    payloadSafeToRepair: false,
    vendor: 'standard',
    confidence: statusCode > 0 ? 0.85 : 0.5,
    hiddenError: false,
    partialSuccess: false,
  };
}

// ─── DSA-Style Structural Signature Hashing ──────────────────────────────────

function extractKeySkeleton(val: unknown, depth = 0): string {
  if (depth > 3 || val === null || val === undefined) return typeof val;
  if (Array.isArray(val)) {
    return val.length > 0 ? `[${extractKeySkeleton(val[0], depth + 1)}]` : '[]';
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${extractKeySkeleton((val as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
  }
  return typeof val;
}

export function computeErrorSignature(params: {
  family: HttpErrorFamily;
  statusCode: number;
  vendor: VendorErrorFormat;
  code: string;
  rawError: unknown;
}): string {
  const skeleton = extractKeySkeleton(params.rawError);
  const canonical = JSON.stringify({
    family: params.family,
    status: params.statusCode,
    vendor: params.vendor,
    code: params.code.toUpperCase(),
    skeleton,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Central Error Classification Engine ─────────────────────────────────────

/**
 * Classifies any HTTP response failure, network exception, or disguised 200 OK
 * error into a structured `HttpErrorClassification` with hybrid priority scoring.
 */
export function classifyHttpError(
  response?: { status?: number; headers?: Headers | Record<string, string> | null } | null,
  error?: unknown,
  context?: ResilienceContext,
): HttpErrorClassification {
  const rawStatus = response?.status ?? 0;
  const headers = response?.headers ?? context?.headers ?? null;
  const normalized = normalizeHttpErrorPayload(error, headers, rawStatus);
  const effectiveStatus = normalized.status || rawStatus;

  // 0. Check custom registered rules first (Signature/Rule match)
  for (const rule of classifierState().customRules) {
    if (rule.match(normalized, effectiveStatus, error)) {
      const signature = computeErrorSignature({
        family: rule.family,
        statusCode: effectiveStatus,
        vendor: normalized.vendor,
        code: normalized.code,
        rawError: error,
      });
      return {
        statusCode: effectiveStatus,
        family: rule.family,
        severity: rule.severity,
        confidence: rule.confidence,
        signature,
        recommendedStrategy: rule.strategy,
        resolutionTier: 'signature_match',
        normalized,
      };
    }
  }

  let family: HttpErrorFamily = 'unknown';
  let severity: HttpErrorSeverity = 'medium';
  let recommendedStrategy: FixStrategyName = 'safe_default_response';
  let confidence = normalized.confidence;
  let resolutionTier: ResolutionTier = 'deterministic_rule';

  // 1. Network & Timeout Exceptions (statusCode === 0 or explicit timeout Error)
  if (
    error instanceof Error ||
    effectiveStatus === 0 ||
    normalized.code === 'REQUEST_TIMEOUT' ||
    normalized.code === 'ETIMEDOUT'
  ) {
    const isTimeout =
      normalized.code === 'REQUEST_TIMEOUT' ||
      normalized.code === 'ETIMEDOUT' ||
      effectiveStatus === 408 ||
      /timeout|timed out|AbortError/i.test(`${normalized.code} ${normalized.message}`);

    if (isTimeout) {
      family = 'timeout';
      severity = 'high';
      recommendedStrategy =
        context?.isRead !== false
          ? context?.hasLkg
            ? 'fallback_stale_payload'
            : 'jittered_retry'
          : context?.hasIdempotencyKey
            ? 'idempotency_retry'
            : 'safe_default_response';
      confidence = 0.95;
      resolutionTier = 'deterministic_rule';
    } else if (rawStatus === 0) {
      family = 'network';
      severity = 'high';
      recommendedStrategy =
        context?.isRead !== false
          ? context?.hasLkg
            ? 'fallback_stale_payload'
            : 'retry_with_backoff'
          : context?.hasIdempotencyKey
            ? 'idempotency_retry'
            : 'circuit_breaker';
      confidence = 0.94;
      resolutionTier = 'deterministic_rule';
    }
  }

  // 2. Status-Code & Hidden-Error Classification
  if (family === 'unknown') {
    if (normalized.hiddenError) {
      resolutionTier = normalized.vendor !== 'standard' ? 'signature_match' : 'semantic_inference';
      confidence = Math.min(confidence, 0.86);
    }

    switch (effectiveStatus) {
      case 200:
      case 201:
      case 207: {
        family = 'schema_drift';
        severity = 'medium';
        recommendedStrategy = 'schema_normalization';
        confidence = normalized.partialSuccess ? 0.9 : 0.88;
        resolutionTier = normalized.partialSuccess ? 'signature_match' : 'deterministic_rule';
        break;
      }
      case 400:
      case 422: {
        family = 'validation';
        severity = 'medium';
        recommendedStrategy = normalized.payloadSafeToRepair
          ? 'payload_repair'
          : 'protected_invalid_payload_rejection';
        confidence = normalized.payloadSafeToRepair ? 0.94 : 0.85;
        break;
      }
      case 401: {
        family = 'auth';
        severity = 'high';
        recommendedStrategy = 'auth_refresh';
        confidence = 0.96;
        break;
      }
      case 403: {
        family = 'auth';
        const isStaleToken = /\b(?:expired|stale|refresh|invalid_token)\b/i.test(
          `${normalized.code} ${normalized.message}`,
        );
        severity = isStaleToken ? 'medium' : 'high';
        recommendedStrategy = isStaleToken ? 'auth_refresh' : 'safe_default_response';
        confidence = isStaleToken ? 0.84 : 0.92;
        if (isStaleToken) resolutionTier = 'semantic_inference';
        break;
      }
      case 404:
      case 410: {
        family = 'not_found';
        severity = effectiveStatus === 410 ? 'high' : 'low';
        recommendedStrategy = context?.hasEndpointFallback
          ? 'endpoint_remap'
          : context?.isRead !== false && context?.hasLkg
            ? 'fallback_stale_payload'
            : 'safe_default_response';
        confidence = context?.hasEndpointFallback ? 0.93 : 0.88;
        break;
      }
      case 405: {
        family = 'validation';
        severity = 'medium';
        recommendedStrategy = 'method_correction';
        confidence = 0.91;
        break;
      }
      case 409: {
        family = 'conflict';
        severity = 'medium';
        recommendedStrategy = 'idempotency_retry';
        confidence = 0.9;
        break;
      }
      case 429: {
        family = 'rate_limit';
        severity = 'high';
        recommendedStrategy =
          context?.isRead !== false && context?.hasLkg
            ? 'fallback_stale_payload'
            : 'rate_limit_wait';
        confidence = 0.97;
        break;
      }
      case 408:
      case 504: {
        family = 'timeout';
        severity = 'high';
        recommendedStrategy =
          context?.isRead !== false && context?.hasLkg
            ? 'fallback_stale_payload'
            : context?.isRead !== false
              ? 'jittered_retry'
              : 'circuit_breaker';
        confidence = 0.95;
        break;
      }
      case 500:
      case 502:
      case 503: {
        family = 'server';
        severity = effectiveStatus === 503 ? 'critical' : 'high';
        recommendedStrategy =
          context?.isRead !== false && context?.hasLkg
            ? 'fallback_stale_payload'
            : context?.isRead !== false
              ? 'retry_with_backoff'
              : 'circuit_breaker';
        confidence = 0.95;
        break;
      }
      default: {
        if (effectiveStatus >= 500) {
          family = 'server';
          severity = 'high';
          recommendedStrategy =
            context?.isRead !== false && context?.hasLkg
              ? 'fallback_stale_payload'
              : 'circuit_breaker';
          confidence = 0.85;
        } else if (effectiveStatus >= 400) {
          family = 'validation';
          severity = 'medium';
          recommendedStrategy = 'safe_default_response';
          confidence = 0.7;
          resolutionTier = 'safe_degradation';
        } else {
          family = 'unknown';
          severity = 'medium';
          recommendedStrategy = 'safe_default_response';
          confidence = 0.5;
          resolutionTier = 'safe_degradation';
        }
      }
    }
  }

  const signature = computeErrorSignature({
    family,
    statusCode: effectiveStatus,
    vendor: normalized.vendor,
    code: normalized.code,
    rawError: error,
  });

  return {
    statusCode: effectiveStatus,
    family,
    severity,
    confidence,
    signature,
    recommendedStrategy,
    resolutionTier,
    normalized,
  };
}
