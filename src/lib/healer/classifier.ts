/**
 * API-HEALER · Deterministic Drift Classifier (Loop 1 · step 2)
 * -------------------------------------------------------------
 * Pure structural + semantic diff between the observed payload and the
 * contract. ZERO LLM calls, ZERO eval — a closed-form algorithm that runs
 * in ~1ms and emits typed DriftFindings consumed by the plan composer.
 *
 * Drift taxonomy:
 *   MISSING — contract path absent from payload
 *   TYPE    — path present with wrong primitive type
 *   RENAME  — sibling key with a similar name carries the expected type/value
 *   MOVE    — expected leaf name found relocated at another (nested) path
 *   SPIKE   — numeric leaf deviates > 4.5σ from rolling history (unit bug)
 *   COMPOUND— ≥ 2 findings of different classes at once
 */
import { performance } from 'perf_hooks';
import type {
  Classification,
  ContractDef,
  DriftFinding,
  DriftType,
  HistoryMap,
} from './types';
import { flattenLeaves, readPath, numericLeaves, parseContractDef } from './contract';
import { SIGMA_THRESHOLD, COLD_START_RATIO } from './types';

/** Normalize a key for fuzzy name matching: lowercase, strip separators. */
function norm(key: string): string {
  return key.toLowerCase().replace(/[_\-. ]+/g, '');
}

/** Bounded Levenshtein — early-exit once distance exceeds max. */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
    if (dp[b.length] > max && j > b.length - 1) return false;
  }
  return dp[b.length] <= max;
}

/** Cheap semantic name similarity for RENAME/MOVE candidates. */
export function namesSimilar(a: string, b: string): boolean {
  return nameSimilarityStrength(a, b) !== null;
}

/**
 * Similarity strength used for confidence scoring:
 *   exact   — normalized keys identical (status ≡ status)
 *   partial — one normalized key contains the other (status ⊂ current_status)
 *   fuzzy   — bounded edit distance (orderId ≈ order_id)
 */
export function nameSimilarityStrength(
  a: string,
  b: string,
): 'exact' | 'partial' | 'fuzzy' | null {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 'exact';
  if (Math.min(na.length, nb.length) >= 3 && (na.includes(nb) || nb.includes(na))) {
    return 'partial';
  }
  if (editDistanceWithin(na, nb, 2)) return 'fuzzy';
  return null;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Z-score of x against a rolling sample; null when not computable. */
export function zScore(x: number, values: number[]): number | null {
  if (values.length < 3) return null; // need minimal history for statistics
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return x === mean ? 0 : Infinity;
  return (x - mean) / sd;
}

export interface SigmaViolation {
  kind: 'sigma' | 'cold-start';
  /** Human-readable reason, path-free (callers prefix the leaf path). */
  detail: string;
}

/**
 * Unified magnitude-anomaly check for one numeric leaf — BOTH statistical
 * regimes, so no window of blindness exists after the first baseline value:
 *
 *   ≥3 samples  → standard regime: |z| > 4.5 veto (100× unit-bug protection).
 *   1–2 samples → COLD-START QUARANTINE: too few points for a z-score, so the
 *                 value is ratio-checked against the FIRST baseline sample.
 *                 A >10× or <0.1× jump is the classic unit-bug signature
 *                 (499 ↔ 49900) and is vetoed before it can be learned into
 *                 the rolling history (callers never record vetoed values).
 *   0 samples   → statistically blind (no reference exists yet): the value
 *                 forms the baseline. Honest residual risk — covered by the
 *                 canary + PR loop, not by statistics.
 */
export function sigmaViolation(
  value: number,
  history: number[],
): SigmaViolation | null {
  if (history.length >= 3) {
    const z = zScore(value, history);
    if (z !== null && Math.abs(z) > SIGMA_THRESHOLD) {
      return {
        kind: 'sigma',
        detail: `deviates ${Math.round(Math.abs(z) * 100) / 100}σ from rolling mean (> ${SIGMA_THRESHOLD}σ)`,
      };
    }
    return null;
  }
  if (history.length >= 1) {
    const baseline = history[0];
    // A zero baseline has no magnitude meaning (defaults / absent counters) —
    // ratio math there would flag every first real value as an infinite jump.
    if (baseline === 0) return null;
    const ratio = value / baseline;
    if (ratio > COLD_START_RATIO || ratio < 1 / COLD_START_RATIO) {
      return {
        kind: 'cold-start',
        detail: `Cold-start magnitude anomaly detected. Auto-patch refused. (${value} vs baseline ${baseline} — ${Math.round(ratio * 100) / 100}× jump, allowed ±${COLD_START_RATIO}×)`,
      };
    }
  }
  return null;
}

/** All (path → value) leaf entries of an arbitrary payload object. */
function payloadLeaves(
  obj: Record<string, unknown>,
  prefix = '',
): { path: string; key: string; value: unknown; type: string }[] {
  const out: { path: string; key: string; value: unknown; type: string }[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...payloadLeaves(v as Record<string, unknown>, path));
    } else {
      out.push({ path, key: k, value: v, type: typeOf(v) });
    }
  }
  return out;
}

export interface ClassifyInput {
  payload: Record<string, unknown>;
  contractDef: ContractDef;
  /** Rolling numeric history keyed by contract path (for SPIKE detection) */
  history?: HistoryMap;
}

/**
 * Classify drift between payload and contract. Deterministic, allocation-
 * conscious, and side-effect free. Budget: ~1ms for typical checkout JSON.
 */
export function classify(input: ClassifyInput): Classification {
  const t0 = performance.now();
  const findings: DriftFinding[] = [];
  const { payload, contractDef, history = {} } = input;

  const leaves = flattenLeaves(contractDef.fields);
  const observed = payloadLeaves(payload);
  const observedByPath = new Map(observed.map((o) => [o.path, o]));
  // Mandatory contract paths that are PRESENT in the payload are load-bearing:
  // consuming them as RENAME/MOVE sources would destroy conformant data.
  const mandatoryPresent = new Set(
    leaves.filter((l) => l.def.mandatory === true).map((l) => l.path),
  );
  const observedByLeafName = new Map<string, typeof observed>();
  for (const o of observed) {
    const list = observedByLeafName.get(o.key) ?? [];
    list.push(o);
    observedByLeafName.set(o.key, list);
  }

  for (const leaf of leaves) {
    const expectedType = leaf.def.type === 'unknown' ? null : leaf.def.type;
    const obs = observedByPath.get(leaf.path);

    if (obs === undefined) {
      // 1) MISSING — explain via RENAME / MOVE evidence, or flag ambiguity.
      //    Ambiguity (≥2 similar-name candidates) is NEVER guessed: the
      //    composer caps confidence below the gate and the LLM tier
      //    disambiguates under full gate supervision.
      const expectedLeafName = leaf.path.split('.').pop() ?? leaf.path;
      const parent = leaf.path.split('.').slice(0, -1).join('.');
      const candidates = observed.filter(
        (o) =>
          o.path !== leaf.path &&
          !mandatoryPresent.has(o.path) &&
          (expectedType === null || o.type === expectedType) &&
          namesSimilar(o.key, expectedLeafName),
      );
      // same-parent, non-contract keys = RENAME evidence (order_id → orderId)
      const renameHits = candidates.filter(
        (o) =>
          o.path.split('.').slice(0, -1).join('.') === parent &&
          !leaves.some((l) => l.path === o.path),
      );
      const moveHits = candidates.filter((o) => !renameHits.includes(o));

      if (candidates.length === 1) {
        const hit = candidates[0];
        if (renameHits.length === 1) {
          findings.push({
            type: 'RENAME',
            path: leaf.path,
            meta: {
              observedKey: hit.path,
              observedValue: hit.value,
              strength: nameSimilarityStrength(hit.key, expectedLeafName),
              reason: `sibling key "${hit.key}" matches expected "${expectedLeafName}" (fuzzy) with type ${hit.type}`,
            },
          });
          continue;
        }
        findings.push({
          type: 'MOVE',
          path: leaf.path,
          meta: {
            candidatePath: hit.path,
            observedValue: hit.value,
            candidates: [hit.path],
            strength: nameSimilarityStrength(hit.key, expectedLeafName),
            reason: `leaf "${expectedLeafName}" found relocated at "${hit.path}"`,
          },
        });
        continue;
      }

      if (candidates.length > 1) {
        const ranked = [...renameHits, ...moveHits].sort((a, b) => {
          const aExact = norm(a.key) === norm(expectedLeafName) ? 0 : 1;
          const bExact = norm(b.key) === norm(expectedLeafName) ? 0 : 1;
          return aExact - bExact || a.path.length - b.path.length;
        });
        findings.push({
          type: 'MOVE',
          path: leaf.path,
          meta: {
            candidatePath: ranked[0].path,
            observedValue: ranked[0].value,
            candidates: ranked.slice(0, 4).map((m) => m.path),
            strength: nameSimilarityStrength(ranked[0].key, expectedLeafName),
            ambiguous: true,
            reason: `"${expectedLeafName}" ambiguous — ${candidates.length} similar candidates: ${ranked.slice(0, 4).map((m) => m.path).join(', ')}`,
          },
        });
        continue;
      }

      // no similar candidate anywhere — plain missing field
      findings.push({
        type: 'MISSING',
        path: leaf.path,
        meta: { mandatory: leaf.def.mandatory === true },
      });
      continue;
    }

    // 2) TYPE mismatch
    if (expectedType && obs.type !== expectedType && obs.type !== 'null') {
      findings.push({
        type: 'TYPE',
        path: leaf.path,
        meta: {
          observedType: obs.type,
          expectedType,
          observedValue: obs.value,
          reason: `"${leaf.path}" is ${obs.type}, contract requires ${expectedType}`,
        },
      });
      continue;
    }

    // 3) SPIKE — numeric leaf vs rolling history (z-score OR cold-start ratio)
    if (typeof obs.value === 'number') {
      const violation = sigmaViolation(obs.value, history[leaf.path] ?? []);
      if (violation) {
        findings.push({
          type: 'SPIKE',
          path: leaf.path,
          meta: {
            kind: violation.kind,
            ...(violation.kind === 'sigma'
              ? {
                  zScore:
                    Math.round(
                      (zScore(obs.value, history[leaf.path]) ?? 0) * 100,
                    ) / 100,
                  threshold: SIGMA_THRESHOLD,
                }
              : {
                  ratio:
                    Math.round(
                      (obs.value / history[leaf.path][0]) * 100,
                    ) / 100,
                  threshold: COLD_START_RATIO,
                }),
            observedValue: obs.value,
            historyMean:
              Math.round(
                (history[leaf.path].reduce((s, v) => s + v, 0) /
                  history[leaf.path].length) *
                  100,
              ) / 100,
            unit: leaf.def.unit,
            reason: `"${leaf.path}" ${violation.detail}${leaf.def.unit && violation.kind === 'sigma' ? ` — possible unit bug (${leaf.def.unit})` : ''}`,
          },
        });
      }
    }
  }

  const types = new Set(findings.map((f) => f.type));
  const driftType: DriftType =
    findings.length === 0
      ? 'NONE'
      : findings.length === 1 || types.size === 1
        ? findings[0].type
        : 'COMPOUND';

  return {
    driftType,
    findings,
    diffMs: Math.round((performance.now() - t0) * 1000) / 1000,
  };
}

/** Convenience wrapper taking raw JSON strings (API boundary). */
export function classifyRaw(
  payload: Record<string, unknown>,
  schemaJson: string,
  history?: HistoryMap,
): Classification {
  return classify({ payload, contractDef: parseContractDef(schemaJson), history });
}
