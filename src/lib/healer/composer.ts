/**
 * API-HEALER · Plan Composer (Loop 1 · step 3b)
 * ----------------------------------------------
 * Converts DriftFindings into a Declarative JSON DSL HealPlan.
 *
 * Tier 1 — Deterministic composer: closed-form heuristics, zero LLM, <5ms.
 * Tier 2 — LLM composer: engaged ONLY for novel drift the heuristics cannot
 *          express. Its output is UNTRUSTED: it must re-express itself using
 *          the same 4 whitelisted ops and passes through the identical
 *          3-Gate Refusal Engine. A strict JSON schema + whitelist filter
 *          bounds the blast radius (SWEADV-style exploit vectors are
 *          neutralized because the plan language itself is not executable).
 */
import type {
  Classification,
  ContractDef,
  DriftFinding,
  HealPlan,
  DslOperation,
} from './types';
import { MIN_CONFIDENCE, COLD_HEAL_BUDGET_MS } from './types';
import { flattenLeaves, coerceValue, readPath } from './contract';

export interface ComposeInput {
  payload: Record<string, unknown>;
  contractDef: ContractDef;
  classification: Classification;
  /** Whitelisted safe defaults: path → primitive (DEFAULT may only use these) */
  defaults: Record<string, unknown>;
}

export interface ComposeOutput {
  plan: HealPlan | null;
  composer: 'deterministic' | 'llm' | 'none';
}

// ─── Tier 1 · Deterministic ────────────────────────────────────────────────

export function composeDeterministic(input: ComposeInput): ComposeOutput {
  const { contractDef, classification, payload, defaults } = input;
  const leaves = new Map(flattenLeaves(contractDef.fields).map((l) => [l.path, l]));
  const ops: DslOperation[] = [];
  let confidence = 1;
  const notes: string[] = [];

  for (const f of classification.findings) {
    const leaf = leaves.get(f.path);
    const expectedType = leaf?.def.type;

    switch (f.type) {
      case 'RENAME': {
        const from = String(f.meta.observedKey ?? '');
        if (!from) continue;
        ops.push({ op: 'RENAME', from, to: f.path });
        confidence = Math.min(confidence, 0.92);
        notes.push(`rename ${from}→${f.path}`);
        break;
      }
      case 'MOVE': {
        const from = String(f.meta.candidatePath ?? '');
        if (!from) continue;
        // Evidence-based confidence: exact leaf-name match > partial inclusion
        // (status ⊂ current_status) > fuzzy edit-distance. Ambiguity penalizes.
        const strength = String(f.meta.strength ?? 'fuzzy') as 'exact' | 'partial' | 'fuzzy';
        const baseConf = strength === 'exact' ? 0.92 : strength === 'partial' ? 0.88 : 0.8;
        const candidates = (f.meta.candidates as string[] | undefined)?.length ?? 1;
        ops.push({ op: 'MOVE', from, to: f.path });
        confidence = Math.min(confidence, candidates > 1 ? Math.min(baseConf, 0.65) : baseConf);
        notes.push(`move ${from}→${f.path}`);
        break;
      }
      case 'TYPE': {
        const value = readPath(payload, f.path);
        if (expectedType !== 'string' && expectedType !== 'number' && expectedType !== 'boolean') {
          continue; // object/unknown targets are not strictly coercible
        }
        const cast = coerceValue(value, expectedType);
        if (cast === undefined) {
          // irreconcilable type — leave to LLM tier or refusal
          confidence = 0;
          notes.push(`cannot strictly coerce ${f.path} to ${expectedType}`);
          continue;
        }
        ops.push({ op: 'COERCE', path: f.path, cast: expectedType });
        confidence = Math.min(confidence, 0.95);
        notes.push(`coerce ${f.path}:${expectedType}`);
        break;
      }
      case 'MISSING': {
        const isMandatory = f.meta.mandatory === true;
        if (isMandatory) {
          // NEVER hallucinate data for mandatory business fields.
          // Composer deliberately skips; Gate 3 will veto completeness.
          notes.push(`mandatory ${f.path} missing — refusal expected`);
          continue;
        }
        const hasDefault = Object.prototype.hasOwnProperty.call(defaults, f.path);
        if (hasDefault) {
          ops.push({ op: 'DEFAULT', path: f.path, value: defaults[f.path] });
          confidence = Math.min(confidence, 0.88);
          notes.push(`default ${f.path}`);
        } else {
          notes.push(`optional ${f.path} missing without whitelisted default`);
        }
        break;
      }
      case 'SPIKE': {
        // Data-integrity event, not a shape problem. The composer NEVER
        // mutates money values — the sigma gate owns this outcome.
        notes.push(`value spike on ${f.path} — no shape heal exists`);
        continue;
      }
      default:
        continue;
    }
  }

  if (ops.length === 0) {
    return { plan: null, composer: 'none' };
  }

  return {
    plan: {
      version: 1,
      ops,
      confidence: Math.round(confidence * 1000) / 1000,
      rationale: `Deterministic heuristics: ${notes.join('; ')}`,
      composer: 'deterministic',
    },
    composer: 'deterministic',
  };
}

// ─── Tier 2 · LLM (novel drift only) ───────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You are the plan composer inside API-Healer, a zero-RCE runtime schema firewall.
Your ONLY job: output a declarative JSON heal plan that adapts a drifted API payload to a contract.

STRICT RULES:
1. Output PURE JSON. No markdown, no prose, no code fences.
2. Schema: {"ops":[{"op":"RENAME","from":"<existing.path>","to":"<contract.path>"}|{"op":"MOVE","from":"<existing.path>","to":"<contract.path>"}|{"op":"COERCE","path":"<path>","cast":"string"|"number"|"boolean"}|{"op":"DEFAULT","path":"<optional-path>","value":<json-primitive>}],"confidence":<0..1>,"rationale":"<one sentence>"}
3. ONLY these 4 op types exist. NEVER emit anything executable.
4. NEVER use DEFAULT on a mandatory field. NEVER invent business data (tax IDs, amounts, reference IDs).
5. NEVER modify numeric values (no unit conversions like /100). If a value looks like a unit bug, omit it — the statistical gate will refuse.
6. "from"/source paths MUST reference keys that exist in the observed payload.
7. confidence reflects your certainty the plan makes the payload satisfy the contract EXACTLY.

If no safe plan exists, output {"ops":[],"confidence":0,"rationale":"<why>"}.`;

/** Hard filter: drop anything that is not one of the 4 whitelisted shapes. */
export function sanitizeLlmPlan(raw: unknown): HealPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.ops)) return null;
  const ops: DslOperation[] = [];
  for (const candidate of obj.ops) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as Record<string, unknown>;
    const op = c.op;
    if (op === 'RENAME' && typeof c.from === 'string' && typeof c.to === 'string') {
      ops.push({ op: 'RENAME', from: c.from, to: c.to });
    } else if (op === 'MOVE' && typeof c.from === 'string' && typeof c.to === 'string') {
      ops.push({ op: 'MOVE', from: c.from, to: c.to });
    } else if (
      op === 'COERCE' &&
      typeof c.path === 'string' &&
      (c.cast === 'string' || c.cast === 'number' || c.cast === 'boolean')
    ) {
      ops.push({ op: 'COERCE', path: c.path, cast: c.cast });
    } else if (op === 'DEFAULT' && typeof c.path === 'string') {
      const t = typeof c.value;
      if (t === 'string' || t === 'number' || t === 'boolean' || c.value === null) {
        ops.push({ op: 'DEFAULT', path: c.path, value: c.value });
      }
    }
    // anything else is silently dropped — the plan language is closed
  }
  const confidenceRaw = typeof obj.confidence === 'number' ? obj.confidence : 0;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  return {
    version: 1,
    ops,
    confidence,
    rationale: String(obj.rationale ?? 'LLM-composed plan'),
    composer: 'llm',
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * LLM composer for novel/compound drift.
 *
 * HARD 650ms CEILING (the cold-heal budget): the hot path must never hang on
 * a provider outage. An AbortController flips at the ceiling — the current
 * z-ai transport is single-arg and ignores signals, so the Promise.race below
 * is the actual enforcement wall; the controller is defense-in-depth for the
 * day the transport accepts a signal (extra args are silently ignored by JS,
 * so passing it today is safe and makes the swap a one-line change).
 *
 * On timeout OR transport failure this THROWS — composePlan() catches it and
 * falls back seamlessly to the local deterministic heuristic plan
 * (composeDeterministic), which then faces the same 3-Gate Refusal Engine.
 */
export const LLM_TIMEOUT_MS = COLD_HEAL_BUDGET_MS;

type ChatCompletion = { choices?: { message?: { content?: string } }[] };

type SignalCapableCreate = (
  body: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<ChatCompletion>;

async function synthesize(input: ComposeInput, signal: AbortSignal): Promise<ChatCompletion> {
  const mod = await import('z-ai-web-dev-sdk');
  const zai = await mod.default.create();

  const leaves = flattenLeaves(input.contractDef.fields).map((l) => ({
    path: l.path,
    type: l.def.type,
    mandatory: !!l.def.mandatory,
  }));
  const whitelistedDefaults = Object.keys(input.defaults);

  const userPrompt = JSON.stringify({
    contract: leaves,
    whitelistedDefaultPaths: whitelistedDefaults,
    driftFindings: input.classification.findings,
    observedPayload: input.payload,
  });

  const create = zai.chat.completions.create as unknown as SignalCapableCreate;
  return create(
    {
      messages: [
        { role: 'assistant', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      thinking: { type: 'disabled' },
    },
    { signal },
  );
}

export async function composeWithLlm(input: ComposeInput): Promise<ComposeOutput> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = await Promise.race([
      synthesize(input, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(); // formal cancel — honored whenever the transport supports it
          reject(new Error(`LLM composer timed out after ${LLM_TIMEOUT_MS}ms`));
        }, LLM_TIMEOUT_MS);
      }),
    ]);

    const content = completion?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM composer returned empty content');

    const parsed = extractJson(content);
    const plan = sanitizeLlmPlan(parsed);
    if (!plan || plan.ops.length === 0) {
      return { plan: null, composer: 'none' };
    }
    return { plan, composer: 'llm' };
  } finally {
    if (timer) clearTimeout(timer); // never leave a live timer on the event loop
  }
}

/**
 * Unified entry with smart tiering:
 *   1. Deterministic plan with confidence ≥ MIN_CONFIDENCE → ship it.
 *   2. Deterministic plan exists but would fail the confidence gate
 *      (e.g. ambiguous MOVE candidates) → escalate to LLM disambiguation;
 *      keep whichever plan is stronger. Both tiers face identical gates.
 *   3. SPIKE findings never reach the LLM — data integrity is non-negotiable.
 *   4. LLM timeout/throw → seamless fallback to the local deterministic
 *      heuristic plan below — never an exception to the hot path.
 */
export async function composePlan(
  input: ComposeInput,
  opts: { allowLlm: boolean },
): Promise<ComposeOutput> {
  const det = composeDeterministic(input);
  if (det.plan && det.plan.confidence >= MIN_CONFIDENCE) return det;

  const hasSpike = input.classification.findings.some((f) => f.type === 'SPIKE');
  if (!opts.allowLlm || hasSpike) return det;

  try {
    const llm = await composeWithLlm(input);
    if (llm.plan) {
      if (!det.plan || llm.plan.confidence > det.plan.confidence) return llm;
    }
  } catch {
    // LLM unavailable — fall through to whatever deterministic produced
  }
  return det;
}

export type { DriftFinding };
