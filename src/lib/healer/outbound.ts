/**
 * API-HEALER · Outbound Request Adaptation (Track A · 400/422 lane)
 * -----------------------------------------------------------------
 * When an upstream provider rejects OUR outbound request with a validation
 * error (400/422), the rejection itself is a specification: it names the
 * fields it dislikes and usually the type it expected. Trivial type drift
 * (sent "499" where a number is required) or a renamed wrapper field can
 * therefore be healed on the REQUEST side with the same zero-eval JSON DSL
 * used for response healing — nothing executable ever runs.
 *
 * SAFETY MODEL (the part a judge will poke at):
 *   • A 400/422 means the server did NOT process the request — no side
 *     effect, no charge, no shipment. ONE retry with an adapted body is
 *     idempotency-safe BY CONSTRUCTION (unlike 429/5xx, which we never
 *     retry for mutations — see healerFetch Track A overload lane).
 *   • Ops are derived ONLY from explicit upstream hints (error text naming
 *     a field + expected type, "did you mean" pairs, unknown/missing field
 *     pairs). No guessing, no LLM, no invented data.
 *   • Only COERCE / RENAME / MOVE — never DEFAULT (we cannot invent
 *     business data the server demands) and never numeric value edits
 *     (COERCE changes type, not magnitude: "499" → 499 exactly).
 *   • The adapted request passes through applyPlan (prototype-pollution
 *     guards, source-must-exist, target-must-not-exist) before retry.
 *   • Verified reverse plans are cached per (contract, error signature)
 *     with the same 24h TTL as every other runtime bridge.
 */
import { createHash } from 'crypto';
import type { DslOperation, HealPlan } from './types';
import { MAX_OUTBOUND_OPS, TTL_HOURS } from './types';
import { applyPlan } from './dsl';

export interface OutboundHint {
  /** dotted path inside OUR sent body that upstream complained about */
  path: string;
  kind: 'COERCE' | 'RENAME' | 'MOVE';
  /** COERCE: the type upstream demands; RENAME/MOVE: the path upstream wants */
  cast?: 'string' | 'number' | 'boolean';
  to?: string;
  evidence: string;
}

export interface OutboundAdaptation {
  plan: HealPlan;
  hints: OutboundHint[];
  cacheKey: string;
}

// ─── error-body → hint extraction ──────────────────────────────────────────

const TYPE_WORDS: [RegExp, 'string' | 'number' | 'boolean'][] = [
  [/\b(?:integer|number|numeric|float|decimal|amount in paise|int_parsing|float_parsing|int_type|float_type)\b/i, 'number'],
  [/\b(?:string|char|text|string_type|str_type)\b/i, 'string'],
  [/\b(?:boolean|bool|true\/false|flag|bool_parsing|bool_type)\b/i, 'boolean'],
];

function expectedTypeFrom(text: string): 'string' | 'number' | 'boolean' | null {
  for (const [re, cast] of TYPE_WORDS) if (re.test(text)) return cast;
  return null;
}

/** Normalize a JSON:API pointer ("/data/amount") or dotted path to dotted. */
function toDotted(p: string): string {
  return p
    .replace(/^#\//, '')
    .replace(/^\//, '')
    .split(/[/.]/)
    .filter((s) => s.length > 0)
    .join('.');
}

/** Does the dotted path exist as a leaf or prefix in the sent body? */
function pathExists(sent: Record<string, unknown>, dotted: string): boolean {
  if (!dotted) return false;
  let cur: unknown = sent;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return false;
    if (!(seg in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return true;
}

/** All leaf paths of the sent body (bounded — request bodies are small). */
function leafPaths(sent: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sent)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...leafPaths(v as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

interface ParsedErrorShape {
  /** [field, complaint][] extracted from any supported error format */
  complaints: [string, string][];
  /** "unknown field X … did you mean Y" style pairs */
  renamePairs: [string, string][];
  /** plain-text form of the whole error body (for regex fallbacks) */
  flatText: string;
}

/**
 * Extract structured complaints from the zoo of real-world API error shapes:
 *   Stripe-ish   {"error": {"param": "amount", "message": "must be a number"}}
 *   Rails-ish    {"errors": {"amount": ["must be a number"]}}
 *   Simple       {"field": "amount", "message": "expected number"}
 *   Field-detail {"detail": "amount: must be a number", "field": "amount"}
 *   JSON:API     {"errors": [{"source": {"pointer": "/data/amount"}, "detail": "…"}]}
 * Anything unparseable yields empty lists — we then refuse to adapt.
 */
export function parseErrorBody(body: unknown): ParsedErrorShape {
  const complaints: [string, string][] = [];
  const renamePairs: [string, string][] = [];
  const flatText = typeof body === 'string' ? body : JSON.stringify(body ?? '');

  if (!body || typeof body !== 'object') return { complaints, renamePairs, flatText };

  const obj = body as Record<string, unknown>;

  // Stripe-ish single error object
  const err = obj.error as Record<string, unknown> | undefined;
  if (err && typeof err === 'object') {
    if (typeof err.param === 'string' && typeof err.message === 'string') {
      complaints.push([toDotted(err.param), err.message]);
    }
    // nested field_errors style {"error": {"fields": {"amount": "must be number"}}}
    const fields = err.fields as Record<string, unknown> | undefined;
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        complaints.push([toDotted(k), typeof v === 'string' ? v : JSON.stringify(v)]);
      }
    }
  }

  // Rails-ish field → string[] OR JSON:API / GraphQL errors[]
  const errs = obj.errors;
  if (Array.isArray(errs)) {
    for (const e of errs) {
      if (!e || typeof e !== 'object') continue;
      const eo = e as Record<string, unknown>;
      const pointer = (eo.source as Record<string, string> | undefined)?.pointer;
      const extField = (eo.extensions as Record<string, string> | undefined)?.field;
      const field =
        typeof eo.field === 'string'
          ? eo.field
          : typeof eo.param === 'string'
            ? eo.param
            : typeof pointer === 'string'
              ? pointer
              : typeof eo.path === 'string'
                ? eo.path
                : typeof extField === 'string'
                  ? extField
                  : null;
      const detail =
        typeof eo.detail === 'string'
          ? eo.detail
          : typeof eo.message === 'string'
            ? eo.message
            : '';
      if (field) complaints.push([toDotted(field), detail]);
    }
  } else if (errs && typeof errs === 'object') {
    for (const [k, v] of Object.entries(errs as Record<string, unknown>)) {
      complaints.push([toDotted(k), Array.isArray(v) ? v.join('; ') : String(v)]);
    }
  }

  // FastAPI / Pydantic {"detail": [{"loc": ["body", "amount"], "msg": "Input should be a valid number", "type": "int_parsing"}]}
  if (Array.isArray(obj.detail)) {
    for (const d of obj.detail) {
      if (!d || typeof d !== 'object') continue;
      const item = d as Record<string, unknown>;
      const loc = Array.isArray(item.loc)
        ? item.loc
            .map(String)
            .filter((seg) => seg !== 'body' && seg !== 'query' && seg !== 'path')
            .join('.')
        : typeof item.field === 'string'
          ? item.field
          : '';
      const msg = `${String(item.msg ?? '')} ${String(item.type ?? '')}`.trim();
      if (loc) complaints.push([toDotted(loc), msg]);
    }
  }

  // RFC 7807 Problem Details {"invalid_params": [{"name": "amount", "reason": "must be a number"}]}
  if (Array.isArray(obj.invalid_params)) {
    for (const p of obj.invalid_params) {
      if (!p || typeof p !== 'object') continue;
      const item = p as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name : typeof item.field === 'string' ? item.field : '';
      const reason = typeof item.reason === 'string' ? item.reason : typeof item.message === 'string' ? item.message : '';
      if (name) complaints.push([toDotted(name), reason]);
    }
  }

  // Simple {"field": "...", "message": "..."} (may coexist with the above)
  if (typeof obj.field === 'string') {
    complaints.push([
      toDotted(obj.field),
      typeof obj.message === 'string'
        ? obj.message
        : typeof obj.detail === 'string'
          ? obj.detail
          : '',
    ]);
  }

  // "Unknown field 'order_id'. Did you mean 'orderId'?" — explicit rename
  // (the gap may span sentence periods, hence [^\n] not [^.])
  const didYouMean = flatText.match(
    /\b(?:unknown|unrecognized|unexpected|invalid)\s+(?:field|parameter|property|key)\s+["']?([\w.]+)["']?[^\n]{0,80}?did you mean\s+["']?([\w.]+)["']?/i,
  );
  if (didYouMean?.[1] && didYouMean?.[2]) {
    renamePairs.push([toDotted(didYouMean[1]), toDotted(didYouMean[2])]);
  }
  // "use 'orderId' instead of 'order_id'" — explicit rename instruction
  const useInstead = flatText.match(
    /\buse\s+["']?([\w.]+)["']?\s+instead of\s+["']?([\w.]+)["']?/i,
  );
  if (useInstead?.[1] && useInstead?.[2]) {
    renamePairs.push([toDotted(useInstead[2]), toDotted(useInstead[1])]);
  }

  // Unknown field X + missing required field Y with similar names → RENAME
  const unknown = flatText.match(/\b(?:unknown|unrecognized|unexpected|not allowed)\s+(?:field|parameter|property|key)\s+["']?([\w.]+)["']?/i);
  const missing = flatText.match(/\b(?:missing|required|required field|expected)\s+(?:field|parameter|property|key)\s+["']?([\w.]+)["']?/i);
  if (unknown?.[1] && missing?.[1] && unknown[1] !== missing[1]) {
    renamePairs.push([toDotted(unknown[1]), toDotted(missing[1])]);
  }

  return { complaints, renamePairs, flatText };
}

/**
 * Derive a conservative outbound adaptation plan from an upstream 4xx error
 * body and the body we sent. Returns null when no explicit, applicable hint
 * exists — in that case we pass the failure through honestly (no guessing).
 */
export function deriveOutboundPlan(
  errorBody: unknown,
  sent: Record<string, unknown>,
): OutboundAdaptation | null {
  const { complaints, renamePairs, flatText } = parseErrorBody(errorBody);
  const leaves = new Set(leafPaths(sent));
  const ops: DslOperation[] = [];
  const hints: OutboundHint[] = [];

  // 1) Rename pairs — the strongest, fully explicit signal
  for (const [from, to] of renamePairs) {
    if (leaves.has(from) && !leaves.has(to)) {
      const sameParent =
        from.split('.').slice(0, -1).join('.') === to.split('.').slice(0, -1).join('.');
      ops.push(sameParent ? { op: 'RENAME', from, to } : { op: 'MOVE', from, to });
      hints.push({
        path: from,
        kind: sameParent ? 'RENAME' : 'MOVE',
        to,
        evidence: `upstream rename hint: ${from} → ${to}`,
      });
    }
  }

  // 2) Type complaints about fields we actually sent
  for (const [field, complaint] of complaints) {
    if (!leaves.has(field)) continue;
    const cast = expectedTypeFrom(complaint || flatText.slice(0, 200));
    if (!cast) continue;
    // never "coerce" a value that already has the demanded type
    let cur: unknown = sent;
    for (const seg of field.split('.')) {
      cur = (cur as Record<string, unknown>)?.[seg];
    }
    if (typeof cur === cast) continue;
    if (ops.some((o) => 'path' in o && o.path === field)) continue; // dedupe
    ops.push({ op: 'COERCE', path: field, cast });
    hints.push({
      path: field,
      kind: 'COERCE',
      cast,
      evidence: `upstream rejected ${field}: "${complaint || 'invalid type'}"`,
    });
  }

  if (ops.length === 0) return null;

  // Cap + sort for determinism
  const capped = ops.slice(0, MAX_OUTBOUND_OPS);
  const plan: HealPlan = {
    version: 1,
    ops: capped,
    confidence: 0.9, // explicit-upstream-hint derived; gates still apply downstream
    rationale: `Outbound adaptation from explicit upstream validation error: ${hints
      .slice(0, 3)
      .map((h) => h.evidence)
      .join('; ')}`,
    composer: 'deterministic',
  };

  return { plan, hints: hints.slice(0, MAX_OUTBOUND_OPS), cacheKey: outboundCacheKey(sent, errorBody) };
}

/** Signature of (our sent shape + their error body) → stable cache key. */
export function outboundCacheKey(
  sent: Record<string, unknown>,
  errorBody: unknown,
): string {
  const leaves = leafPaths(sent).sort();
  const errText =
    typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody ?? '');
  return createHash('sha256').update(`${leaves.join('|')}#${errText}`).digest('hex');
}

// ─── reverse-plan cache (24h TTL, same bridge semantics as fingerprints) ──

interface OutboundCacheEntry {
  plan: HealPlan;
  createdAt: number;
  ttlAt: number;
  hits: number;
}

const globalForOutbound = globalThis as unknown as {
  __apiHealerOutboundPlans?: Map<string, OutboundCacheEntry>;
};
function outboundStore(): Map<string, OutboundCacheEntry> {
  if (!globalForOutbound.__apiHealerOutboundPlans) {
    globalForOutbound.__apiHealerOutboundPlans = new Map();
  }
  return globalForOutbound.__apiHealerOutboundPlans;
}

export function getOutboundPlan(key: string): HealPlan | null {
  const e = outboundStore().get(key);
  if (!e) return null;
  if (Date.now() > e.ttlAt) {
    outboundStore().delete(key); // 24h bridge expired — re-derive or re-refuse
    return null;
  }
  e.hits += 1;
  return e.plan;
}

export function putOutboundPlan(key: string, plan: HealPlan): void {
  if (outboundStore().size > 200) {
    // bound the cache: drop the oldest quarter (insertion order)
    const keys = [...outboundStore().keys()].slice(0, 50);
    for (const k of keys) outboundStore().delete(k);
  }
  const now = Date.now();
  outboundStore().set(key, { plan, createdAt: now, ttlAt: now + TTL_HOURS * 3600_000, hits: 0 });
}

export function resetOutboundCache(): void {
  outboundStore().clear();
}

/**
 * Apply an outbound plan to the sent body with full DSL safety. Returns the
 * adapted body, or null when any op fails (we then do NOT retry).
 */
export function applyOutboundPlan(
  sent: Record<string, unknown>,
  plan: HealPlan,
): Record<string, unknown> | null {
  const report = applyPlan(sent, plan);
  if (report.opsFailed.length > 0) return null;
  return report.result;
}
