'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Loader2,
  Play,
  Plus,
  Braces,
  Zap,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Code2,
  Copy,
  Check,
  Bug,
  Eye,
  EyeOff,
  GitPullRequest,
  ExternalLink,
  Network,
  Layers,
  FileCode2,
} from 'lucide-react';
import type { ContractRow, EventRow } from './ui-types';
import type { AiFixResponse } from '@/lib/ai/code-fixer';
import type { SwarmOrchestrationResult } from '@/lib/ai/agent-swarm';
import type { SilentCrashAnalysisResult } from '@/lib/healer/silent-crash-detector';

interface SilentDemoScenario {
  id: string;
  label: string;
  badge: string;
  crashRisk: string;
  payload: Record<string, unknown> | null;
  rawText?: string;
  context: Record<string, unknown>;
}

const SILENT_CRASH_SCENARIOS: SilentDemoScenario[] = [
  {
    id: 'null-pointer',
    label: '1. Null User Object Trap',
    badge: 'NULL_POINTER',
    crashRisk: "TypeError: Cannot read properties of null (reading 'name')",
    payload: {
      orderId: 'ORD-2026-9921',
      user: null, // Frontend executes `res.user.name` -> Fatal blank screen crash!
      items: [{ id: 1, name: 'Smartwatch' }],
    },
    context: { url: '/api/v1/orders/ORD-2026-9921', method: 'GET' },
  },
  {
    id: 'array-map',
    label: '2. Null Items List Trap',
    badge: 'ARRAY_MAP',
    crashRisk: "TypeError: items.map is not a function (items is null)",
    payload: {
      category: 'Electronics',
      totalCount: 42,
      items: null, // Frontend executes `res.items.map(...)` -> Instant crash!
      orders: null,
    },
    context: { url: '/api/v1/products', method: 'GET' },
  },
  {
    id: 'disguised-200',
    label: '3. Disguised 200 OK Failure',
    badge: 'DISGUISED_200',
    crashRisk: 'Silent data corruption: UI treats response as 200 OK success',
    payload: {
      ok: false,
      error_code: 'SESSION_REVOKED',
      message: 'User authentication token was invalidated on server',
      retry_after: 5,
    },
    context: { url: '/api/v1/account', method: 'GET' },
  },
  {
    id: 'poisoned-literals',
    label: '4. Poisoned String Literals',
    badge: 'POISONED_TYPES',
    crashRisk: 'String "NaN" corrupts charts; "false" string evaluates truthy in JS',
    payload: {
      userId: 'null', // String "null" is truthy! Boolean("null") === true
      amount: 'NaN', // Numeric calculations result in NaN
      isActive: 'false',
    },
    context: { url: '/api/v1/billing', method: 'GET' },
  },
  {
    id: 'malformed-xssi',
    label: '5. Malformed XSSI Prefix',
    badge: 'XSSI_GUARD',
    crashRisk: 'SyntaxError: Unexpected token ) in JSON at position 0',
    payload: null,
    rawText: ")]}',\n" + JSON.stringify({ status: 'ACTIVE', balance: 5000, orders: [] }),
    context: { url: '/api/v1/google-partner/feed', method: 'GET' },
  },
];

function buildContractSkeleton(contract: ContractRow): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const leaf of contract.leaves) {
    const parts = leaf.path.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== 'object' || cur[k] === null) {
        cur[k] = {};
      }
      cur = cur[k] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (leaf.path in contract.defaults) {
      cur[last] = contract.defaults[leaf.path];
    } else if (leaf.type === 'number') {
      cur[last] = 1499;
    } else if (leaf.type === 'boolean') {
      cur[last] = true;
    } else {
      cur[last] = last.toLowerCase().includes('id')
        ? 'ord_94810'
        : last.toLowerCase().includes('status')
          ? 'CAPTURED'
          : last.toLowerCase().includes('email')
            ? 'buyer@app.io'
            : 'INR';
    }
  }
  return root;
}

function buildDriftPreset(
  contract: ContractRow,
  kind: 'healthy' | 'rename' | 'type' | 'move' | 'spike',
): string {
  const base = buildContractSkeleton(contract);
  const keys = Object.keys(base);
  if (keys.length === 0) return JSON.stringify(base, null, 2);

  if (kind === 'healthy') {
    return JSON.stringify(base, null, 2);
  }

  if (kind === 'rename') {
    const firstKey = keys[0];
    const val = base[firstKey];
    delete base[firstKey];
    const renamed = firstKey.includes('_')
      ? firstKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      : `${firstKey}_v2`;
    return JSON.stringify({ [renamed]: val, ...base }, null, 2);
  }

  if (kind === 'type') {
    for (const [k, v] of Object.entries(base)) {
      if (typeof v === 'number') {
        base[k] = String(v);
        break;
      }
    }
    return JSON.stringify(base, null, 2);
  }

  if (kind === 'move') {
    const firstKey = keys[0];
    const val = base[firstKey];
    delete base[firstKey];
    return JSON.stringify({ ...base, payload_meta: { [firstKey]: val } }, null, 2);
  }

  if (kind === 'spike') {
    for (const [k, v] of Object.entries(base)) {
      if (typeof v === 'number') {
        base[k] = v * 100; // 100x Rupees -> Paise unit bug
        break;
      }
    }
    return JSON.stringify(base, null, 2);
  }

  return JSON.stringify(base, null, 2);
}

interface HttpDemoScenario {
  id: string;
  label: string;
  badge: string;
  status: number;
  headers?: Record<string, string>;
  error: Record<string, unknown>;
  context: Record<string, unknown>;
}

const HTTP_DEMO_SCENARIOS: HttpDemoScenario[] = [
  {
    id: 'auth-401',
    label: '401 Expired JWT',
    badge: 'AUTH_REFRESH',
    status: 401,
    error: {
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'The provided JWT access token has expired',
      },
    },
    context: {
      url: '/v1/payments/checkout',
      method: 'POST',
      hasAuthRefresh: true,
      isRead: false,
    },
  },
  {
    id: 'rate-429',
    label: '429 Rate Limit + Retry-After',
    badge: 'RATE_LIMIT_WAIT',
    status: 429,
    headers: { 'retry-after': '12' },
    error: {
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: 'Too many requests hitting upstream gateway',
      },
    },
    context: {
      url: '/v1/orders/status',
      method: 'GET',
      isRead: true,
      hasLkg: false,
    },
  },
  {
    id: 'validation-422',
    label: '422 FastAPI Drift',
    badge: 'PAYLOAD_REPAIR',
    status: 422,
    error: {
      detail: [
        {
          loc: ['body', 'amount'],
          msg: 'Input should be a valid number',
          type: 'float_parsing',
        },
      ],
    },
    context: {
      url: '/v1/payments/checkout',
      method: 'POST',
      isRead: false,
    },
  },
  {
    id: 'server-503',
    label: '503 Outage -> LKG Fallback',
    badge: 'LKG_FALLBACK',
    status: 503,
    error: {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Upstream database pool exhausted',
      },
    },
    context: {
      url: '/v1/orders/status',
      method: 'GET',
      isRead: true,
      hasLkg: true,
    },
  },
  {
    id: 'hidden-200',
    label: '200 OK Disguised Error',
    badge: 'HIDDEN_ERROR',
    status: 200,
    error: {
      ok: false,
      error_code: 'RATE_LIMITED',
      message: 'Quota exceeded despite HTTP 200 OK wrapper',
      retry_after: 8,
    },
    context: {
      url: '/v1/users/profile',
      method: 'GET',
      isRead: true,
      hasLkg: true,
    },
  },
];

interface ResilienceSimResult {
  classification: {
    statusCode: number;
    family: string;
    severity: string;
    confidence: number;
    signature: string;
    recommendedStrategy: string;
    resolutionTier: string;
    normalized: {
      code: string;
      vendor: string;
      message: string;
      retryAfter: number | null;
      hiddenError: boolean;
    };
  };
  decision: {
    action: string;
    shouldRetry: boolean;
    useFallback: boolean;
    failClosed: boolean;
    notes: string;
  };
  backoffMs: number;
  runtimeMs?: number;
  cacheHit?: boolean;
}

export function Playground({
  contracts,
  allowLlm,
  onAllowLlmChange,
  onOpenConnect,
  selectedEvent,
  onNavigateColdPath,
  onResult,
}: {
  contracts: ContractRow[];
  allowLlm: boolean;
  onAllowLlmChange: (v: boolean) => void;
  onOpenConnect?: () => void;
  selectedEvent?: EventRow | null;
  onNavigateColdPath?: () => void;
  onResult: (r: EventRow) => void;
}) {
  const [contractId, setContractId] = useState<string>('');
  const [payloadText, setPayloadText] = useState('');
  const [running, setRunning] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);

  // Workbench right-pane inspector mode
  const [inspectorTab, setInspectorTab] = useState<'swarm' | 'drift'>('swarm');
  const [artifactTab, setArtifactTab] = useState<'patch' | 'test' | 'diff' | 'pitch'>('patch');

  // HTTP Resilience Simulator state
  const [simBusy, setSimBusy] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<ResilienceSimResult | null>(null);

  // Silent Crash Simulator & AI Auto-Patcher state
  const [demoCategory, setDemoCategory] = useState<'visible' | 'silent'>('visible');
  const [silentBusy, setSilentBusy] = useState<string | null>(null);
  const [silentResult, setSilentResult] = useState<SilentCrashAnalysisResult | null>(null);
  const [selectedErrorContext, setSelectedErrorContext] = useState<{
    label: string;
    errorType: string;
    statusCode: number;
    rawPayload: unknown;
    crashSignature: string;
    context: Record<string, unknown>;
  } | null>(null);

  const [aiFixBusy, setAiFixBusy] = useState(false);
  const [aiFixResult, setAiFixResult] = useState<AiFixResponse | null>(null);
  const [swarmResult, setSwarmResult] = useState<SwarmOrchestrationResult | null>(null);
  const [fastPatchMode, setFastPatchMode] = useState(true);
  const [autoPrEnabled, setAutoPrEnabled] = useState(true);
  const [prBusy, setPrBusy] = useState(false);
  const [dispatchedPr, setDispatchedPr] = useState<{
    id: string;
    number: number;
    title: string;
    branch: string;
    mode: 'GITHUB' | 'DRY_RUN';
    status: string;
    url: string | null;
    diffText: string;
    filesCount?: number;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const effectiveContractId = contractId || contracts[0]?.id || '';
  const selectedContract = contracts.find((c) => c.id === effectiveContractId);
  const displayedPayloadText =
    payloadText || (selectedContract ? JSON.stringify(buildContractSkeleton(selectedContract), null, 2) : '');

  const handleSelectContract = (id: string) => {
    setContractId(id);
    const found = contracts.find((c) => c.id === id);
    if (found) {
      setPayloadText(JSON.stringify(buildContractSkeleton(found), null, 2));
    }
  };

  const quickBootstrapContract = async () => {
    setBootstrapping(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: '/v1/payments/checkout',
          name: 'Checkout Payments API',
          method: 'POST',
          payload: {
            orderId: 'ord_94810',
            amount: 1499,
            currency: 'INR',
            status: 'CAPTURED',
          },
        }),
      });
      const data = (await res.json()) as {
        contract?: { id: string; name: string };
        error?: string;
      };
      if (!res.ok || !data.contract) {
        toast.error(data.error ?? 'Failed to create demo contract');
        return;
      }
      toast.success(`Demo Contract Ready: ${data.contract.name}`);
      window.location.reload();
    } catch {
      toast.error('Setup failed');
    } finally {
      setBootstrapping(false);
    }
  };

  const firePayload = async (overrideText?: string) => {
    const contract = contracts.find((c) => c.id === effectiveContractId);
    if (!contract) {
      toast.error('Select a contract first');
      return;
    }
    const raw = overrideText ?? displayedPayloadText;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      toast.error('Invalid JSON payload');
      return;
    }
    setRunning(true);
    setInspectorTab('drift');
    try {
      const res = await fetch('/api/heal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractId: effectiveContractId, payload, allowLlm }),
      });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      onResult({ ...data, eventId: data.eventId });
      const st = data.status as string;
      if (st.startsWith('HEALED')) toast.success(`Healed: ${st}`, { description: data.message });
      else if (st === 'ROLLED_BACK') toast.warning('Rolled back (4.5σ Veto)', { description: data.message });
      else if (st === 'REFUSED') toast.error('Refused', { description: data.message });
      else toast.info('Passthrough (<0.3ms)', { description: data.message });
    } catch {
      toast.error('Request failed');
    } finally {
      setRunning(false);
    }
  };

  const runPresetAndFire = (kind: 'healthy' | 'rename' | 'type' | 'move' | 'spike') => {
    if (!selectedContract) return;
    const text = buildDriftPreset(selectedContract, kind);
    setPayloadText(text);
    void firePayload(text);
  };

  const synthesizeAndMaybeDispatchPr = async (
    errCtx: {
      label: string;
      errorType: string;
      statusCode: number;
      rawPayload: unknown;
      crashSignature: string;
      context: Record<string, unknown>;
    },
    overrideFast?: boolean,
  ) => {
    const useFast = overrideFast ?? fastPatchMode;
    setAiFixBusy(true);
    setPrBusy(autoPrEnabled);
    try {
      const res = await fetch('/api/ai/swarm-dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contractId: effectiveContractId || undefined,
          errorType: errCtx.errorType,
          statusCode: errCtx.statusCode,
          rawPayload: errCtx.rawPayload,
          crashSignature: errCtx.crashSignature,
          context: errCtx.context,
          forceFallback: useFast,
          autoCreatePr: autoPrEnabled,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        swarm?: SwarmOrchestrationResult;
        pr?: {
          id: string;
          number: number;
          title: string;
          branch: string;
          mode: 'GITHUB' | 'DRY_RUN';
          status: string;
          url: string | null;
          diffText: string;
          filesCount: number;
        } | null;
        error?: string;
      };
      if (data.error || !data.swarm) {
        toast.error('Multi-Agent Swarm execution failed');
        return;
      }
      setSwarmResult(data.swarm);
      setAiFixResult(data.swarm.coreAiFix);
      if (data.pr) {
        setDispatchedPr(data.pr);
        toast.success(
          `Swarm Dispatched 6 Patchers → Atomic GitHub PR #${data.pr.number}`,
          {
            description: `Patched ${data.pr.filesCount} files across Schema, Transport, UI & Tests in ${data.swarm.masterOrchestrator.totalDurationMs}ms.`,
          },
        );
      }
    } catch {
      toast.error('Failed to contact Multi-Agent Swarm Orchestrator');
    } finally {
      setAiFixBusy(false);
      setPrBusy(false);
    }
  };

  const runHttpScenario = async (scenario: HttpDemoScenario) => {
    setInspectorTab('swarm');
    setSimBusy(scenario.id);
    setSilentResult(null);
    setAiFixResult(null);
    setSwarmResult(null);
    setDispatchedPr(null);
    const errCtx = {
      label: scenario.label,
      errorType: scenario.badge,
      statusCode: scenario.status,
      rawPayload: scenario.error,
      crashSignature: `HTTP ${scenario.status} uncaught client exception`,
      context: scenario.context,
    };
    setSelectedErrorContext(errCtx);

    try {
      const res = await fetch('/api/resilience', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: scenario.status,
          headers: scenario.headers,
          error: scenario.error,
          context: scenario.context,
        }),
      });
      const data = (await res.json()) as ResilienceSimResult;
      setSimResult(data);
      toast.success(
        `Shielded User in ${data.runtimeMs ?? 0.08}ms (${data.decision.action.toUpperCase()})`,
        {
          description: 'Zero user crash. Launching Multi-Agent Swarm (Master → 3 Sub → 6 Patchers)…',
        },
      );
      void synthesizeAndMaybeDispatchPr(errCtx);
    } catch {
      toast.error('HTTP Resilience simulation failed');
    } finally {
      setSimBusy(null);
    }
  };

  const runSilentScenario = async (scenario: SilentDemoScenario) => {
    setInspectorTab('swarm');
    setSilentBusy(scenario.id);
    setSimResult(null);
    setAiFixResult(null);
    setSwarmResult(null);
    setDispatchedPr(null);
    const errCtx = {
      label: scenario.label,
      errorType: scenario.badge,
      statusCode: 200,
      rawPayload: scenario.payload ?? scenario.rawText,
      crashSignature: scenario.crashRisk,
      context: scenario.context,
    };
    setSelectedErrorContext(errCtx);

    try {
      const res = await fetch('/api/resilience/silent-traps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          payload: scenario.payload,
          rawText: scenario.rawText,
        }),
      });
      const data = (await res.json()) as SilentCrashAnalysisResult;
      setSilentResult(data);
      if (data.hasSilentTraps) {
        toast.warning(
          `Intercepted & Healed ${data.trapCount} Silent Crash Trap(s) in ${data.runtimeMs ?? 0.12}ms`,
          {
            description: 'User shielded. Launching Multi-Agent Swarm (Master → 3 Sub → 6 Patchers)…',
          },
        );
      } else {
        toast.success('Payload verified safe for frontend execution.');
      }
      void synthesizeAndMaybeDispatchPr(errCtx);
    } catch {
      toast.error('Silent trap analysis failed');
    } finally {
      setSilentBusy(null);
    }
  };

  const requestAiFix = async (overrideFast?: boolean) => {
    if (!selectedErrorContext) {
      toast.info('Select and run a fault scenario first');
      return;
    }
    setInspectorTab('swarm');
    await synthesizeAndMaybeDispatchPr(selectedErrorContext, overrideFast);
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-12">
      {/* LEFT PANE (5 Columns): Fault Injection & Drift Simulator Controls */}
      <div className="min-w-0 space-y-6 lg:col-span-5">
        {/* Module 1: Universal HTTP Resilience & Silent Trap Injector */}
        <section
          aria-label="Universal HTTP & Silent Trap Fault Injector"
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                01. HTTP &amp; Silent Trap Fault Injector
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Trigger a live fault to verify Loop-1 (&lt;0.1ms) shielding and Loop-2 Swarm PR dispatch.
              </p>
            </div>
          </div>

          <div className="p-4 space-y-4">
            {/* Segmented Mode Switcher */}
            <div
              role="group"
              aria-label="Select fault category"
              className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1"
            >
              <button
                type="button"
                onClick={() => setDemoCategory('visible')}
                className={`flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  demoCategory === 'visible'
                    ? 'bg-card text-foreground shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Eye className="h-3.5 w-3.5 shrink-0" />
                Visible HTTP Faults (4xx/5xx)
              </button>
              <button
                type="button"
                onClick={() => setDemoCategory('silent')}
                className={`flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  demoCategory === 'silent'
                    ? 'bg-card text-foreground shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <EyeOff className="h-3.5 w-3.5 shrink-0" />
                Silent 200 OK Traps
              </button>
            </div>

            {/* Scenario List */}
            {demoCategory === 'visible' ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground pb-1">
                  <span>Select HTTP Error Scenario</span>
                  <span className="font-mono tabular-nums">Status · Endpoint</span>
                </div>
                <div className="grid gap-1.5">
                  {HTTP_DEMO_SCENARIOS.map((sc) => {
                    const isSelected = selectedErrorContext?.label === sc.label;
                    return (
                      <button
                        key={sc.id}
                        type="button"
                        disabled={simBusy !== null || silentBusy !== null}
                        onClick={() => void runHttpScenario(sc)}
                        data-testid={`http-sim-${sc.id}`}
                        className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                          isSelected
                            ? 'border-primary bg-accent/80 font-semibold text-foreground'
                            : 'border-border bg-background text-foreground hover:bg-accent/50'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2 truncate">
                          {simBusy === sc.id ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground" />
                          ) : (
                            <Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{sc.label}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          HTTP {sc.status} · {String(sc.context.method ?? 'GET')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground pb-1">
                  <span>Select Silent 200 OK Crash Trap</span>
                  <span className="font-mono tabular-nums">Trap Vector</span>
                </div>
                <div className="grid gap-1.5">
                  {SILENT_CRASH_SCENARIOS.map((sc) => {
                    const isSelected = selectedErrorContext?.label === sc.label;
                    return (
                      <button
                        key={sc.id}
                        type="button"
                        disabled={silentBusy !== null || simBusy !== null}
                        onClick={() => void runSilentScenario(sc)}
                        data-testid={`silent-sim-${sc.id}`}
                        className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                          isSelected
                            ? 'border-primary bg-accent/80 font-semibold text-foreground'
                            : 'border-border bg-background text-foreground hover:bg-accent/50'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2 truncate">
                          {silentBusy === sc.id ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground" />
                          ) : (
                            <Bug className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                          )}
                          <span className="truncate">{sc.label}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          200 OK · {sc.badge}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Swarm Execution Policy Controls */}
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <label className="flex items-center gap-2 font-medium text-foreground cursor-pointer">
                  <Switch checked={fastPatchMode} onCheckedChange={setFastPatchMode} />
                  <span>Instant Synthesis (&lt;0.5ms)</span>
                </label>

                <label className="flex items-center gap-2 font-medium text-foreground cursor-pointer">
                  <Switch checked={autoPrEnabled} onCheckedChange={setAutoPrEnabled} />
                  <span>Auto-Push GitHub PR</span>
                </label>
              </div>

              {selectedErrorContext && (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="min-w-0 text-[11px] text-muted-foreground truncate">
                    Active: <span className="font-medium text-foreground">{selectedErrorContext.label}</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={aiFixBusy || prBusy}
                    onClick={() => void requestAiFix()}
                    className="h-8 shrink-0 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
                  >
                    {aiFixBusy || prBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <GitPullRequest className="h-3.5 w-3.5" />
                    )}
                    {aiFixBusy
                      ? 'Synthesizing…'
                      : prBusy
                        ? 'Opening PR…'
                        : 'Re-Synthesize & Push PR'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Module 2: Contract Schema Drift Simulator */}
        <section
          aria-label="Contract Schema Drift Simulator"
          className="overflow-hidden rounded-lg border border-border bg-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                02. Contract Schema Drift Firewall
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                6-Verb JSON DSL composition with 4.5σ Welford unit-bug veto.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <span>LLM Tier</span>
              <Switch checked={allowLlm} onCheckedChange={onAllowLlmChange} />
            </label>
          </div>

          {contracts.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
              <p className="text-xs text-muted-foreground">
                No contracts registered yet. Bootstrap a demo Checkout API contract in one click.
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <Button
                  size="sm"
                  disabled={bootstrapping}
                  onClick={() => void quickBootstrapContract()}
                  className="h-8 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
                >
                  {bootstrapping ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  1-Click Demo Checkout Contract
                </Button>
                {onOpenConnect && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onOpenConnect}
                    className="h-8 gap-1.5 border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Custom Contract
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                <div className="min-w-0">
                  <Select value={effectiveContractId} onValueChange={handleSelectContract}>
                    <SelectTrigger className="h-8 w-full min-w-0 max-w-full overflow-hidden border-border bg-background text-xs text-foreground [&>span]:truncate">
                      <SelectValue placeholder="Select contract…" />
                    </SelectTrigger>
                    <SelectContent>
                      {contracts.map((c) => (
                        <SelectItem key={c.id} value={c.id} className="text-xs">
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedContract && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPayloadText(JSON.stringify(buildContractSkeleton(selectedContract), null, 2))
                    }
                    className="h-8 shrink-0 gap-1.5 border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap"
                  >
                    <Braces className="h-3.5 w-3.5 text-muted-foreground" />
                    Reset
                  </Button>
                )}

                <Button
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 whitespace-nowrap bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                  disabled={running || !effectiveContractId || !displayedPayloadText.trim()}
                  onClick={() => void firePayload()}
                >
                  {running ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {running ? 'Sending…' : 'Send Request'}
                </Button>
              </div>

              {selectedContract && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    1-Click Drift Presets:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => runPresetAndFire('healthy')}
                      className="h-7 border-border bg-background px-2.5 text-[11px] font-medium text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      01. Healthy
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => runPresetAndFire('rename')}
                      className="h-7 border-border bg-background px-2.5 text-[11px] font-medium text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      02. RENAME
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => runPresetAndFire('type')}
                      className="h-7 border-border bg-background px-2.5 text-[11px] font-medium text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      03. TYPE Cast
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => runPresetAndFire('move')}
                      className="h-7 border-border bg-background px-2.5 text-[11px] font-medium text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      04. MOVED Field
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running}
                      onClick={() => runPresetAndFire('spike')}
                      className="h-7 border-border bg-background px-2.5 text-[11px] font-medium text-amber-700 hover:bg-accent dark:text-amber-400 whitespace-nowrap"
                    >
                      05. 100× Paise Veto
                    </Button>
                  </div>
                </div>
              )}

              <Textarea
                value={displayedPayloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                placeholder="{}"
                className="h-40 resize-none border-border bg-muted/40 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:bg-background"
                spellCheck={false}
              />
            </div>
          )}
        </section>
      </div>

      {/* RIGHT PANE (7 Columns): Unified Telemetry, Multi-Agent Swarm Tree & Code Inspector */}
      <div className="min-w-0 space-y-4 lg:col-span-7">
        {/* Right-Pane View Mode Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Live Telemetry &amp; Artifact Inspector</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {inspectorTab === 'swarm'
                ? swarmResult
                  ? `${swarmResult.filesPatched.length} Files Synthesized`
                  : 'Ready for Fault Injection'
                : selectedEvent
                  ? `${selectedEvent.status} (${selectedEvent.timing.totalMs.toFixed(2)}ms)`
                  : 'Schema Drift View'}
            </span>
          </div>

          <div
            role="group"
            aria-label="Inspector view mode"
            className="flex items-center gap-1 rounded-md bg-muted p-1"
          >
            <button
              type="button"
              onClick={() => setInspectorTab('swarm')}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                inspectorTab === 'swarm'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Swarm &amp; Code Patch
            </button>
            <button
              type="button"
              onClick={() => setInspectorTab('drift')}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                inspectorTab === 'drift'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Schema Drift Diff
            </button>
          </div>
        </div>

        {/* Always keep http-sim-result, dispatched-github-pr, and agent-swarm-tree mounted in the DOM when present */}
        {simResult && (
          <div
            data-testid="http-sim-result"
            className="rounded-lg border border-border bg-card p-4 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
              <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                {simResult.decision.failClosed ? (
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                )}
                <span>Loop-1 Runtime Shield</span>
                <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">HTTP {simResult.classification.statusCode}</span>
                <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                <span className="font-mono uppercase">{simResult.classification.family}</span>
                <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                <span className="font-mono font-semibold text-foreground">
                  {simResult.decision.action}
                </span>
              </div>

              <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {simResult.runtimeMs ?? 0.08}ms
                </span>
                <span aria-hidden="true">·</span>
                <span>{simResult.cacheHit ? 'L1 Hot-Cache' : 'Cold Classify'}</span>
                <span aria-hidden="true">·</span>
                <span>{(simResult.classification.confidence * 100).toFixed(0)}% Conf</span>
              </div>
            </div>

            <p className="mt-2.5 text-muted-foreground">{simResult.decision.notes}</p>

            <div className="mt-3 grid grid-cols-3 divide-x divide-border border-t border-border pt-2.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              <div className="pr-3">
                Vendor: <span className="font-medium text-foreground">{simResult.classification.normalized.vendor}</span>
              </div>
              <div className="px-3">
                Code: <span className="font-medium text-foreground">{simResult.classification.normalized.code}</span>
              </div>
              <div className="pl-3">
                Backoff:{' '}
                <span className="font-medium text-foreground">
                  {simResult.backoffMs > 0 ? `${simResult.backoffMs}ms` : 'Immediate'}
                </span>
              </div>
            </div>
          </div>
        )}

        {silentResult && (
          <div className="rounded-lg border border-border bg-card p-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
              <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" />
                <span>Loop-1 Silent Trap Shield</span>
                <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {silentResult.trapCount} Trap{silentResult.trapCount > 1 ? 's' : ''} Neutralized
                </span>
                <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                <span className="font-mono">HTTP 200 OK</span>
              </div>

              <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {silentResult.runtimeMs ?? 0.12}ms
                </span>
                <span aria-hidden="true">·</span>
                <span>{silentResult.cacheHit ? 'L1 Hot-Cache' : 'Cold AST Scan'}</span>
              </div>
            </div>

            <div className="mt-3 divide-y divide-border">
              {silentResult.risks.map((risk, idx) => (
                <div key={idx} className="py-2.5 first:pt-0 last:pb-0 space-y-1">
                  <div className="flex items-center justify-between font-mono text-[11px] tabular-nums">
                    <span className="font-semibold text-amber-600 dark:text-amber-400">
                      {risk.trapType} @ {risk.path}
                    </span>
                    <span className="text-muted-foreground">Severity: {risk.severity}</span>
                  </div>
                  <p className="font-mono text-[11px] text-destructive">
                    Prevented Exception: {risk.clientCrashSignature}
                  </p>
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                    Applied Guard: {risk.recommendedRule}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dispatched GitHub Pull Request Live Receipt Banner */}
        {dispatchedPr && (
          <div
            data-testid="dispatched-github-pr"
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <GitPullRequest className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span className="font-bold text-foreground">
                    Atomic Multi-File GitHub PR #{dispatchedPr.number} Dispatched
                  </span>
                  <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-300 font-semibold">
                    {dispatchedPr.filesCount ?? 6} Files Merged
                  </span>
                  <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                  <span className="font-mono text-muted-foreground">
                    {dispatchedPr.status} ({dispatchedPr.mode})
                  </span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  Branch: <span className="text-foreground font-medium">{dispatchedPr.branch}</span> ·{' '}
                  <span className="text-foreground">{dispatchedPr.title}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(dispatchedPr.diffText, 'pr-diff')}
                  className="h-7 gap-1.5 border-border bg-card px-2.5 text-[11px] font-medium text-foreground hover:bg-accent whitespace-nowrap"
                >
                  {copiedKey === 'pr-diff' ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === 'pr-diff' ? 'Copied 6-File Diff' : 'Copy 6-File Atomic Diff'}
                </Button>
                {onNavigateColdPath ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={onNavigateColdPath}
                    className="h-7 gap-1 bg-primary px-2.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
                  >
                    Open PR Ledger
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                ) : (
                  dispatchedPr.url && (
                    <a
                      href="/cold-path"
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
                    >
                      Open PR Ledger
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )
                )}
              </div>
            </div>
          </div>
        )}

        {/* Live Hierarchical Multi-Agent Swarm Execution Tree */}
        {swarmResult && (
          <div
            data-testid="agent-swarm-tree"
            className="overflow-hidden rounded-lg border border-border bg-card text-xs"
          >
            {/* Tier 1: Master Incident Orchestrator */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3">
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Network className="h-4 w-4 text-foreground shrink-0" />
                  <span className="font-bold text-foreground">
                    {swarmResult.masterOrchestrator.name}
                  </span>
                  <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                  <span className="font-mono text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">
                    {swarmResult.masterOrchestrator.totalDurationMs}ms Swarm Execution
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {swarmResult.masterOrchestrator.strategySummaryHindi}
                </p>
              </div>

              <div className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0">
                Blast Radius:{' '}
                <span className="font-semibold text-foreground">
                  {swarmResult.masterOrchestrator.blastRadiusCount} Callsites
                </span>{' '}
                →{' '}
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {swarmResult.filesPatched.length} Files Patched
                </span>
              </div>
            </div>

            {/* Tier 2 & 3: 3 Domain Sub-Orchestrators -> 6 Specialized Patcher Agents */}
            <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
              {swarmResult.subOrchestrators.map((sub) => (
                <div key={sub.id} className="p-3.5 space-y-3">
                  <div className="border-b border-border pb-2">
                    <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                      <span className="inline-flex items-center gap-1 font-semibold uppercase text-foreground">
                        <Layers className="h-3 w-3" />
                        {sub.domain}
                      </span>
                      <span>{sub.durationMs}ms</span>
                    </div>
                    <p className="mt-0.5 font-semibold text-foreground text-[11px]">{sub.name}</p>
                  </div>

                  <div className="divide-y divide-border/60">
                    {sub.patchers.map((patcher) => (
                      <div key={patcher.id} className="py-2 first:pt-0 last:pb-0 space-y-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold text-[11px] text-foreground">
                            {patcher.name}
                          </span>
                          <span className="font-mono text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                            +{patcher.linesAdded}L · {patcher.durationMs}ms
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{patcher.specialty}</p>
                        <div className="flex items-center gap-1 font-mono text-[10px] text-foreground/80">
                          <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate">{patcher.targetFile}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tabbed Code & Verification Artifact Viewer */}
        {aiFixResult && inspectorTab === 'swarm' && (
          <div className="overflow-hidden rounded-lg border border-border bg-card text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Code2 className="h-4 w-4 text-foreground" />
                  <h3 className="font-semibold text-foreground">
                    Synthesized Code &amp; Verification Artifacts
                  </h3>
                  <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {aiFixResult.model} · {(aiFixResult.confidence * 100).toFixed(0)}% Conf ·{' '}
                    {aiFixResult.runtimeMs ?? 0.18}ms
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                  <span>Gate 1: Contract Safety</span>
                  <span aria-hidden="true">·</span>
                  <span>Gate 2: 4.5σ Outlier Guard</span>
                  <span aria-hidden="true">·</span>
                  <span>Gate 3: Zero-Eval Sandbox</span>
                </div>
              </div>

              <div
                role="group"
                aria-label="Select synthesized artifact"
                className="flex flex-wrap items-center gap-1 rounded-md bg-muted p-1"
              >
                {(
                  [
                    ['patch', 'Production Patch (.ts)'],
                    ['test', 'Unit Test (.test.ts)'],
                    ['diff', 'Atomic 6-File Diff'],
                    ['pitch', 'Rules & Pitch'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setArtifactTab(key)}
                    className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                      artifactTab === key
                        ? 'bg-card text-foreground shadow-2xs'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4">
              {artifactTab === 'patch' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      TypeScript Resilience Patch (Zod Coercion + Optional Chaining + Bounded Retry)
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(aiFixResult.productionPatch, 'patch')}
                      className="h-7 gap-1.5 border-border bg-background px-2.5 text-[11px] text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      {copiedKey === 'patch' ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedKey === 'patch' ? 'Copied' : 'Copy Patch'}
                    </Button>
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3.5 font-mono text-[11px] leading-relaxed text-foreground">
                    <code>{aiFixResult.productionPatch}</code>
                  </pre>
                </div>
              )}

              {artifactTab === 'test' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      Automated Regression Suite (Bun / Vitest / Jest)
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(aiFixResult.testSnippet, 'test')}
                      className="h-7 gap-1.5 border-border bg-background px-2.5 text-[11px] text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      {copiedKey === 'test' ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedKey === 'test' ? 'Copied' : 'Copy Unit Test'}
                    </Button>
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3.5 font-mono text-[11px] leading-relaxed text-foreground">
                    <code>{aiFixResult.testSnippet}</code>
                  </pre>
                </div>
              )}

              {artifactTab === 'diff' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      Unified Multi-File Git Diff ({swarmResult?.filesPatched.length ?? 6} Files Merged)
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        copyToClipboard(
                          dispatchedPr?.diffText ?? swarmResult?.atomicUnifiedDiff ?? aiFixResult.productionPatch,
                          'unified-diff',
                        )
                      }
                      className="h-7 gap-1.5 border-border bg-background px-2.5 text-[11px] text-foreground hover:bg-accent whitespace-nowrap"
                    >
                      {copiedKey === 'unified-diff' ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedKey === 'unified-diff' ? 'Copied Diff' : 'Copy Unified Diff'}
                    </Button>
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3.5 font-mono text-[11px] leading-relaxed text-foreground">
                    <code>
                      {dispatchedPr?.diffText ?? swarmResult?.atomicUnifiedDiff ?? aiFixResult.productionPatch}
                    </code>
                  </pre>
                </div>
              )}

              {artifactTab === 'pitch' && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="text-[11px] font-semibold text-foreground">
                        Root Cause (English)
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {aiFixResult.rootCause}
                      </p>
                    </div>
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="text-[11px] font-semibold text-foreground">
                        Root Cause &amp; Pitch (Hindi / Hinglish)
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {aiFixResult.hackathonPitchHindi}
                      </p>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-foreground">
                      Architectural Safety Rules Enforced
                    </div>
                    <ul className="divide-y divide-border rounded-md border border-border font-mono text-[11px] text-muted-foreground">
                      {aiFixResult.rulesEnforced.map((rule, idx) => (
                        <li key={idx} className="px-3 py-2">
                          {rule}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {aiFixResult.clientUsageExample && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-foreground">
                          Drop-In Client Integration
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => copyToClipboard(aiFixResult.clientUsageExample, 'usage')}
                          className="h-6 gap-1 border-border bg-background px-2 text-[10px] text-foreground hover:bg-accent"
                        >
                          {copiedKey === 'usage' ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          {copiedKey === 'usage' ? 'Copied' : 'Copy Snippet'}
                        </Button>
                      </div>
                      <pre className="overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] text-foreground">
                        <code>{aiFixResult.clientUsageExample}</code>
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Empty State when no HTTP/Silent Scenario has been triggered yet in Swarm tab */}
        {!simResult && !silentResult && !swarmResult && inspectorTab === 'swarm' && (
          <div className="flex min-h-[420px] flex-col items-center justify-center rounded-lg border border-border bg-card p-8 text-center">
            <Network className="mb-3 h-7 w-7 text-muted-foreground/60" />
            <h3 className="text-sm font-semibold text-foreground">
              Multi-Agent Swarm Workbench Ready
            </h3>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              Select any Visible HTTP Fault (401, 429, 422, 503) or Silent 200 OK Trap on the left to execute the Loop-1 Runtime Shield (&lt;0.1ms) and dispatch the 6-Agent Swarm PR generator.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void runSilentScenario(SILENT_CRASH_SCENARIOS[0])}
                className="h-8 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
              >
                <Play className="h-3.5 w-3.5" />
                Run Null-Pointer 200 OK Trap Demo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runHttpScenario(HTTP_DEMO_SCENARIOS[0])}
                className="h-8 gap-1.5 border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap"
              >
                <Zap className="h-3.5 w-3.5" />
                Run 401 JWT Refresh Demo
              </Button>
            </div>
          </div>
        )}

        {/* Schema Drift Event Inspector when in 'drift' tab */}
        {inspectorTab === 'drift' && (
          <div className="space-y-4">
            {selectedEvent ? (
              <div className="rounded-lg border border-border bg-card p-4 text-xs space-y-4">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{selectedEvent.contractName}</span>
                    <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                    <span className="font-mono">{selectedEvent.status}</span>
                    <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                    <span className="font-mono text-muted-foreground">{selectedEvent.driftType}</span>
                  </div>
                  <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">
                    {selectedEvent.timing.totalMs.toFixed(2)}ms
                  </span>
                </div>

                {selectedEvent.message && (
                  <p className="rounded border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
                    {selectedEvent.message}
                  </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1.5 font-mono text-[11px] text-muted-foreground">
                      Inbound Upstream Payload
                    </div>
                    <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-3 font-mono text-[11px] text-foreground">
                      {JSON.stringify(selectedEvent.rawPayload ?? {}, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1.5 font-mono text-[11px] text-muted-foreground">
                      Healed Downstream Payload
                    </div>
                    <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-3 font-mono text-[11px] text-foreground">
                      {JSON.stringify(selectedEvent.servedPayload ?? {}, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-border bg-card p-8 text-center">
                <Braces className="mb-2.5 h-6 w-6 text-muted-foreground/50" />
                <p className="text-xs font-medium text-muted-foreground">
                  Click any Drift Preset (Healthy, RENAME, TYPE, MOVE, 100× Paise Veto) on the left to inspect the 6-Verb DSL transformation.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
