/**
 * API-HEALER · Engine Orchestrator (the dual-loop heart)
 * -------------------------------------------------------
 * HOT PATH  (Loop 1):
 *   intercept → Zod validate → classify (1ms) → resolve/compose →
 *   3-Gate Refusal → dual dispatch (serve healed / fail-safe rollback)
 *
 * BUDGETS (spec-enforced):
 *   healthy passthrough <0.3ms — runtime contract cache, ZERO SQLite reads
 *   or writes on healthy calls; history learned in-memory (write-behind),
 *   audit trail emitted on the bus only.
 *   statistical veto   <2ms  — DriftEvent persistence is backgrounded.
 *   cold heal          <650ms — composer ceiling enforced in composer.ts.
 *
 * BRIDGE    (invariants): zero-eval DSL, 4.5σ veto, 2ms rollback, 24h TTL.
 *
 * COLD PATH (Loop 2, async via background jobs):
 *   canary verification → SQLite fingerprint → automated GitHub PR.
 */
import { performance } from 'perf_hooks';
import { emitEvent } from '@/lib/events';
import type {
  Classification,
  ContractDef,
  GatesReport,
  HealPlan,
  HealResult,
} from './types';
import { COLD_HEAL_BUDGET_MS } from './types';
import { classify } from './classifier';
import { applyPlan, summarizePlan } from './dsl';
import { composePlan } from './composer';
import type { ComposeOutput } from './composer';
import { SingleFlight } from './single-flight';
import { runGates } from './gates';
import {
  canonicalSignature,
  structuralSignature,
  getHotPatch,
  getLastKnownGood,
  lookupFingerprint,
  putHotPatch,
  saveFingerprint,
  setLastKnownGood,
} from './memory';
import { checkBreaker, recordFailure, recordSuccess } from './breaker';
import { enqueueJob } from '@/lib/jobs/queue';
import { getContractRuntime, learnHistory } from './contract-cache';
import { recordDriftEventInBackground } from './audit';
import { bumpRuntimeCounter } from './counters';

export interface HealRequest {
  contractId: string;
  payload: Record<string, unknown>;
  /** LLM composer tier (default on; cached re-heals never touch it) */
  allowLlm?: boolean;
  /** Consumer callsite "services/checkout.ts:42" captured by the SDK client */
  callsite?: string | null;
  /** Bypass gate enforcement — used ONLY by the test suite */
  _skipGates?: never;
}

const HISTORY_CAP = 50;

/**
 * Single-flight plan synthesis: N concurrent requests hitting the SAME
 * drift signature share ONE composePlan() execution instead of stampeding
 * the LLM tier with N parallel calls (rate-limit thundering herd). The key
 * carries the allowLlm posture so an LLM-opt-out request can never inherit
 * an LLM-composed plan. Safety is unchanged: every caller — leader or
 * follower — still runs its own payload through the 3-Gate Refusal Engine.
 *
 * GlobalThis singleton (same pattern as the hot tier and breakers): Next.js
 * dev bundles each API route separately, so a plain module-level const would
 * give /api/heal and /api/metrics DIFFERENT instances and stats would lie.
 */
const globalForFlights = globalThis as unknown as {
  __apiHealerPlanFlights?: SingleFlight<string, ComposeOutput>;
};
const planFlights: SingleFlight<string, ComposeOutput> =
  globalForFlights.__apiHealerPlanFlights ??
  (globalForFlights.__apiHealerPlanFlights = new SingleFlight<string, ComposeOutput>());

/** Live single-flight synthesis stats for metrics/telemetry. */
export function planFlightStats() {
  return planFlights.stats();
}

function emptyResult(req: HealRequest, message: string): HealResult {
  return {
    status: 'ERROR',
    contractId: req.contractId,
    contractName: '',
    endpoint: '',
    servedPayload: null,
    rawPayload: req.payload,
    plan: null,
    classification: null,
    gates: null,
    signature: '',
    timing: { classifyMs: 0, composeMs: 0, gatesMs: 0, totalMs: 0 },
    composer: 'none',
    confidence: 0,
    canaryPassed: null,
    jobsQueued: [],
    message,
  };
}

/**
 * THE FIREWALL ENTRYPOINT. Takes one intercepted payload and returns the
 * decision envelope: pass-through, healed (cold/cached), refused, or rolled
 * back — with a complete timing waterfall and gate trace.
 */
export async function healRequest(req: HealRequest): Promise<HealResult> {
  const t0 = performance.now();

  // ── 0. Load contract (runtime cache — zero Prisma on the healthy path) ──
  const rt = await getContractRuntime(req.contractId);
  if (!rt) return emptyResult(req, `contract ${req.contractId} not found or corrupt`);
  if (!rt.enabled) {
    bumpRuntimeCounter('passthrough');
    const r = emptyResult(req, `contract "${rt.name}" is paused — traffic passes unguarded`);
    r.status = 'PASSTHROUGH';
    r.contractName = rt.name;
    r.endpoint = rt.endpoint;
    return r;
  }

  const contractDef: ContractDef = rt.contractDef;
  const mandatory: string[] = rt.mandatory;
  const defaults: Record<string, unknown> = rt.defaults;
  const history = rt.history; // authoritative in-memory copy (write-behind)

  const base = {
    contractId: rt.id,
    contractName: rt.name,
    endpoint: rt.endpoint,
    rawPayload: req.payload,
    callsite: req.callsite ?? null,
  };

  // ── 1. Interception: strict Zod validation of the raw payload ──────────
  const tValid = performance.now();
  // validation happens implicitly through canary/gates below; here we do a
  // fast structural sanity check that the payload is a JSON object at all
  if (req.payload === null || typeof req.payload !== 'object' || Array.isArray(req.payload)) {
    const r = emptyResult(req, 'payload is not a JSON object — refused at intercept');
    r.status = 'REFUSED';
    return r;
  }
  const interceptMs = Math.round((performance.now() - tValid) * 1000) / 1000;

  // ── 2. Deterministic drift classification (~1ms) ────────────────────────
  const classification: Classification = classify({
    payload: req.payload,
    contractDef,
    history,
  });

  const signature = canonicalSignature(rt.id, classification);
  const jobsQueued: string[] = [];

  /**
   * Background audit: the DriftEvent row lands a few ms later; the bus
   * event is emitted WITH the persisted eventId once the write settles.
   * The caller returns immediately — a statistical veto must not pay a
   * SQLite INSERT on its <2ms wall-time budget.
   */
  const persistAndEmit = (partial: Omit<HealResult, 'eventId'>): HealResult => {
    const timing = partial.timing;
    recordDriftEventInBackground(
      {
        contractId: rt.id,
        signature,
        driftType: classification.driftType,
        callsite: req.callsite ?? null,
        classificationJson: JSON.stringify(classification),
        rawPayloadJson: JSON.stringify(req.payload),
        healedPayloadJson: partial.servedPayload
          ? JSON.stringify(partial.servedPayload)
          : null,
        planJson: partial.plan ? JSON.stringify(partial.plan) : null,
        gatesJson: partial.gates ? JSON.stringify(partial.gates) : null,
        status: partial.status,
        composer: partial.composer,
        confidence: partial.confidence,
        classifyMs: timing.classifyMs,
        composeMs: timing.composeMs,
        gatesMs: timing.gatesMs,
        totalMs: timing.totalMs,
        canaryPassed: partial.canaryPassed,
      },
      { ...partial },
    );
    return partial as HealResult;
  };

  // ── 2.5 Circuit breaker (the eject button) ──────────────────────────
  // Repeated fast-loop failures (gate vetoes / canary fails) OPEN the
  // breaker: the runtime adapter is stripped and traffic takes the
  // deterministic fail-safe until a HALF_OPEN trial succeeds.
  const breaker = checkBreaker(rt.id);
  if (breaker.state === 'OPEN') {
    const lastGood = getLastKnownGood(rt.id) ?? null;
    const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    return persistAndEmit({
      status: 'ROLLED_BACK',
      ...base,
      servedPayload: lastGood,
      plan: null,
      classification: null,
      gates: {
        passed: false,
        results: [
          {
            gate: 'POLICY',
            passed: false,
            detail: `circuit OPEN — runtime adapter stripped after ${breaker.failures} consecutive failures: ${breaker.reason ?? 'repeated vetoes'}`,
            ms: 0,
          },
        ],
        totalMs: 0,
      } satisfies GatesReport,
      signature: '',
      timing: { classifyMs: 0, composeMs: 0, gatesMs: 0, totalMs },
      composer: 'none',
      confidence: 0,
      canaryPassed: null,
      jobsQueued: [],
      message: lastGood
        ? `circuit OPEN — adapter stripped, last-known-good served; half-open trial in ${(breaker.cooldownRemainingMs / 1000).toFixed(0)}s`
        : `circuit OPEN — adapter stripped, no last-known-good; half-open trial in ${(breaker.cooldownRemainingMs / 1000).toFixed(0)}s`,
    });
  }

  // ── 3. Fast lane: zero drift → passthrough ─────────────────────────────
  if (classification.driftType === 'NONE') {
    setLastKnownGood(rt.id, req.payload);
    recordSuccess(rt.id); // healthy traffic ⇒ breaker stays CLOSED
    learnHistory(rt, req.payload); // rolling σ baseline, debounced flush
    bumpRuntimeCounter('passthrough');
    const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    const result: HealResult = {
      status: 'PASSTHROUGH',
      ...base,
      servedPayload: req.payload,
      plan: null,
      classification,
      gates: null,
      signature,
      timing: { classifyMs: classification.diffMs, composeMs: 0, gatesMs: 0, totalMs },
      composer: 'none',
      confidence: 1,
      canaryPassed: null,
      jobsQueued: [],
      message: `contract satisfied — served untouched (classify ${classification.diffMs}ms)`,
    };
    void emitEvent('heal:event', result); // bus only — spec: no SQLite writes on healthy calls
    return result;
  }

  // ── 4. Deterministic fail-safe on value spikes (100× unit bug) ──────────
  const hasSpike = classification.findings.some((f) => f.type === 'SPIKE');
  if (hasSpike) {
    const lastGood = getLastKnownGood(rt.id) ?? null;
    const spikeFinding = classification.findings.find((f) => f.type === 'SPIKE');
    const spikeReason = String(spikeFinding?.meta.reason ?? 'value spike detected');
    recordFailure(
      rt.id,
      `${spikeFinding?.meta.kind === 'cold-start' ? 'cold-start' : '4.5σ'} spike veto: ${String(spikeFinding?.path ?? 'numeric leaf')}`,
    );
    const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    return persistAndEmit({
      status: 'ROLLED_BACK',
      ...base,
      servedPayload: lastGood,
      plan: null,
      classification,
      gates: {
        passed: false,
        results: [
          {
            gate: 'SIGMA',
            passed: false,
            detail:
              String(
                classification.findings.find((f) => f.type === 'SPIKE')?.meta.reason ??
                  'value spike detected',
              ),
            ms: 0,
          },
        ],
        totalMs: 0,
      } satisfies GatesReport,
      signature,
      timing: { classifyMs: classification.diffMs, composeMs: 0, gatesMs: 0, totalMs },
      composer: 'none',
      confidence: 0,
      canaryPassed: false,
      jobsQueued,
      message: lastGood
        ? `${spikeReason} — last-known-good served in ${totalMs.toFixed(2)}ms`
        : `${spikeReason} — no last-known-good available, transaction refused safely`,
    });
  }

  // ── 5. Memory tier: hot patch (0.8ms) then SQLite fingerprint ──────────
  const tResolve = performance.now();
  let plan: HealPlan | null = null;
  let composer: HealResult['composer'] = 'none';
  let fleetInherited = false;
  let singleFlightShared = false;

  const hot = getHotPatch(signature);
  if (hot) {
    plan = hot.plan;
    composer = 'cache';
  } else {
    // ── single-flight synthesis & cold lookup: identical signatures share one execution ──
    const flightKey = `${signature}#${req.allowLlm === false ? 'det' : 'llm'}`;
    const { value: resolved, shared } = await planFlights.run(flightKey, async () => {
      const fp = await lookupFingerprint(signature);
      if (fp) {
        putHotPatch(rt.id, signature, fp.plan, getLastKnownGood(rt.id) ?? req.payload);
        return { plan: fp.plan, composer: 'cache' as const, fleetInherited: false };
      }
      const fleetSig = structuralSignature(classification);
      if (fleetSig !== signature) {
        const fleet = await lookupFingerprint(fleetSig);
        if (fleet) {
          putHotPatch(rt.id, signature, fleet.plan, getLastKnownGood(rt.id) ?? req.payload);
          return { plan: fleet.plan, composer: 'cache' as const, fleetInherited: true };
        }
      }
      const composed = await composePlan(
        { payload: req.payload, contractDef, classification, defaults },
        { allowLlm: req.allowLlm !== false },
      );
      return {
        plan: composed.plan,
        composer: composed.composer,
        fleetInherited: false,
      };
    });
    plan = resolved.plan;
    composer = resolved.composer === 'none' ? 'none' : resolved.composer;
    fleetInherited = resolved.fleetInherited;
    singleFlightShared = shared;
  }
  const composeMs =
    Math.round((performance.now() - tResolve) * 1000) / 1000;

  // ── 6. No viable plan → advisory passthrough or refusal ────────────────
  if (!plan) {
    // Optional fields silently dropped with no whitelisted default are NOT
    // business-critical drift — serve with an advisory, never block checkout.
    const onlyOptionalMissing =
      classification.findings.length > 0 &&
      classification.findings.every(
        (f) => f.type === 'MISSING' && f.meta.mandatory !== true,
      );
    if (onlyOptionalMissing) {
      setLastKnownGood(rt.id, req.payload);
      learnHistory(rt, req.payload); // healthy traffic — no SQLite write
      bumpRuntimeCounter('passthrough');
      const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
      const result: HealResult = {
        status: 'PASSTHROUGH',
        ...base,
        servedPayload: req.payload,
        plan: null,
        classification,
        gates: null,
        signature,
        timing: { classifyMs: classification.diffMs, composeMs, gatesMs: 0, totalMs },
        composer: 'none',
        confidence: 1,
        canaryPassed: null,
        jobsQueued,
        message: `optional fields absent (${classification.findings.map((f) => f.path).join(', ')}) — contract-conformant, served with advisory`,
      };
      void emitEvent('heal:event', result);
      return result;
    }
    const lastGood = getLastKnownGood(rt.id) ?? null;
    recordFailure(rt.id, 'composer abstained — no safe declarative plan for the drift');
    const totalMs = Math.round((performance.now() - t0) * 1000) / 1000;
    // Cold path still engages: an engineer-facing PR documents the refusal
    const prJob = await enqueueJob('PR_GENERATION', {
      contractId: rt.id,
      driftType: classification.driftType,
      signature,
      refused: true,
      rawPayload: req.payload,
      findings: classification.findings,
      plan: null,
    });
    jobsQueued.push(prJob.id);
    return persistAndEmit({
      status: 'REFUSED',
      ...base,
      servedPayload: lastGood,
      plan: null,
      classification,
      gates: {
        passed: false,
        results: [
          {
            gate: 'CONFIDENCE',
            passed: false,
            detail: 'no safe declarative plan exists for this drift — composer abstained',
            ms: 0,
          },
        ],
        totalMs: 0,
      } satisfies GatesReport,
      signature,
      timing: { classifyMs: classification.diffMs, composeMs, gatesMs: 0, totalMs },
      composer,
      confidence: 0,
      canaryPassed: null,
      jobsQueued,
      message: lastGood
        ? `heal refused (composer abstained) — last-known-good served; engineer alert + PR queued`
        : `heal refused (composer abstained) — no baseline available; incident raised`,
    });
  }

  // ── 7. 3-Gate Refusal Engine ────────────────────────────────────────────
  const gates = runGates({
    payload: req.payload,
    plan,
    contractDef,
    defaults,
    history,
    mandatory,
  });

  const totalMsNow = () => Math.round((performance.now() - t0) * 1000) / 1000;

  // ── 8. Veto paths: deterministic fail-safe ──────────────────────────────
  if (!gates.report.passed || !gates.healedPayload) {
    const lastGood = getLastKnownGood(rt.id) ?? null;
    const sigmaVeto = gates.report.results.some((g) => g.gate === 'SIGMA' && !g.passed);
    const vetoed = gates.report.results.find((g) => !g.passed);
    recordFailure(rt.id, `gate veto [${vetoed?.gate ?? '?'}]: ${String(vetoed?.detail ?? 'unsafe plan blocked')}`);
    const totalMs = totalMsNow();
    return persistAndEmit({
      status: sigmaVeto ? 'ROLLED_BACK' : 'REFUSED',
      ...base,
      servedPayload: lastGood,
      plan,
      classification,
      gates: gates.report,
      signature,
      timing: { classifyMs: classification.diffMs, composeMs, gatesMs: gates.report.totalMs, totalMs },
      composer,
      confidence: plan.confidence,
      canaryPassed: false,
      jobsQueued,
      message: sigmaVeto
        ? `sigma gate veto — rolled back to last-known-good in ${totalMs.toFixed(2)}ms`
        : `gate veto [${vetoed?.gate ?? '?'}] — ${String(vetoed?.detail ?? 'unsafe plan blocked')}`,
    });
  }

  // ── 9. Dual dispatch: serve healed + persist memory + enqueue cold path ─
  const healedPayload = gates.healedPayload;
  setLastKnownGood(rt.id, healedPayload);
  if (!hot) {
    putHotPatch(rt.id, signature, plan, req.payload);
  }
  recordSuccess(rt.id); // HALF_OPEN trial succeeded ⇒ breaker CLOSED
  if (!hot && !singleFlightShared) {
    void saveFingerprint({
      contractId: rt.id,
      signature,
      plan,
      opsSummary: summarizePlan(plan),
    }).catch(() => undefined);
    // Fleet immunity: index the same verified plan under the structural
    // signature so sibling routes inherit it (still gate-verified per route).
    void saveFingerprint({
      contractId: rt.id,
      signature: structuralSignature(classification),
      plan,
      opsSummary: `fleet · ${summarizePlan(plan)}`,
    }).catch(() => undefined);
  }

  learnHistory(rt, healedPayload);

  // Cold-path dispatch is LEADER-ONLY and NOVEL-ONLY:
  //  • cached re-heals (fingerprint/hot-patch hit) skip the canary + PR
  //    workers — that plan was already canary-proven and PR'd when first
  //    healed cold; re-dispatching per request would stampede the PR bot
  //    (50 cached requests ⇒ 50 duplicate PRs) and burn the 0.8ms MTTI budget
  //    on awaited job inserts.
  //  • single-flight followers (shared=true) skip dispatch for the same
  //    reason: the leader of their flight already queued the cold path for
  //    this exact signature.
  const dispatchColdPath = composer !== 'cache' && !singleFlightShared;
  if (dispatchColdPath) {
    const canaryJob = await enqueueJob('CANARY', {
      contractId: rt.id,
      signature,
      rawPayload: req.payload,
      healedPayload,
      plan,
    });
    jobsQueued.push(canaryJob.id);
    const prJob = await enqueueJob('PR_GENERATION', {
      contractId: rt.id,
      driftType: classification.driftType,
      signature,
      refused: false,
      rawPayload: req.payload,
      healedPayload,
      findings: classification.findings,
      plan,
    });
    jobsQueued.push(prJob.id);
  }

  const totalMs = totalMsNow();
  const cached = composer === 'cache';
  const message = cached
    ? fleetInherited
      ? `fleet fingerprint hit — plan learned on a sibling route, re-verified by gates in ${totalMs.toFixed(2)}ms with zero LLM overhead`
      : `fingerprint hit — re-healed in ${totalMs.toFixed(2)}ms with zero LLM overhead (canary + PR already proven for this signature)`
    : `novel drift healed cold in ${totalMs.toFixed(2)}ms${totalMs > COLD_HEAL_BUDGET_MS ? ' (LLM tier — budget noted)' : ''}${dispatchColdPath ? '; canary + PR workers dispatched' : '; cold path dispatched by the synthesis leader'}`;
  return persistAndEmit({
    status: cached ? 'HEALED_CACHED' : 'HEALED_COLD',
    ...base,
    servedPayload: healedPayload,
    plan,
    classification,
    gates: gates.report,
    signature,
    timing: { classifyMs: classification.diffMs, composeMs, gatesMs: gates.report.totalMs, totalMs },
    composer,
    confidence: plan.confidence,
    canaryPassed: null, // async canary worker will confirm (Loop 2)
    jobsQueued,
    message: singleFlightShared
      ? `${message}; single-flight: inherited the in-flight synthesis (no duplicate LLM call)`
      : message,
  });
}
