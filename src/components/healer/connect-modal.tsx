'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Terminal,
  Trash2,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type LeafType = 'string' | 'number' | 'boolean' | 'unknown';

interface InferredLeaf {
  path: string;
  type: LeafType;
  mandatory: boolean;
}

const APP_PRESETS: {
  id: string;
  label: string;
  name: string;
  endpoint: string;
  method: string;
  payload: Record<string, unknown>;
}[] = [
  {
    id: 'payments',
    label: 'Payments / Checkout',
    name: 'Checkout Payments API',
    endpoint: '/v1/payments/checkout',
    method: 'POST',
    payload: {
      orderId: 'ord_94810',
      amount: 1499,
      currency: 'INR',
      status: 'CAPTURED',
      customer: {
        id: 'usr_301',
        email: 'buyer@app.io',
      },
    },
  },
  {
    id: 'orders',
    label: 'Orders / E-Commerce',
    name: 'Orders Service API',
    endpoint: '/v1/orders/status',
    method: 'POST',
    payload: {
      id: 'ord_7721',
      status: 'CONFIRMED',
      total: 2999,
      shipping: {
        carrier: 'Express',
        trackingCode: 'TRK99812',
        delivered: false,
      },
    },
  },
  {
    id: 'users',
    label: 'User Profile / Auth',
    name: 'User Session API',
    endpoint: '/v1/users/profile',
    method: 'GET',
    payload: {
      id: 'usr_88210',
      email: 'developer@company.com',
      role: 'admin',
      verified: true,
      quotaLimit: 5000,
    },
  },
];

function inferLeaves(sample: unknown, prefix = '', out: InferredLeaf[] = []): InferredLeaf[] {
  if (sample === null || sample === undefined) return out;
  if (Array.isArray(sample)) {
    out.push({ path: prefix, type: 'unknown', mandatory: false });
    return out;
  }
  if (typeof sample === 'object') {
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        inferLeaves(v, path, out);
      } else if (v !== null && typeof v === 'object') {
        out.push({ path, type: 'unknown', mandatory: false });
      } else {
        const t = typeof v;
        out.push({
          path,
          type: t === 'string' || t === 'number' || t === 'boolean' ? t : 'unknown',
          mandatory: false,
        });
      }
    }
  }
  return out;
}

function leavesToFields(leaves: InferredLeaf[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const leaf of leaves) {
    const parts = leaf.path.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      const node = cur[k];
      if (typeof node !== 'object' || node === null || !('fields' in (node as object))) {
        cur[k] = { type: 'object', fields: {} };
      }
      cur = (cur[k] as { fields: Record<string, unknown> }).fields;
    }
    cur[parts[parts.length - 1]] =
      leaf.type === 'unknown'
        ? { type: 'unknown' }
        : { type: leaf.type, ...(leaf.mandatory ? { mandatory: true } : {}) };
  }
  return root;
}

interface OneClickSetupResult {
  contract: {
    id: string;
    name: string;
    endpoint: string;
    method: string;
    fieldsCount: number;
    mandatoryCount: number;
  };
  verification: {
    status: string;
    totalMs: number;
    message: string;
  };
}

export function ConnectModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<'one-click' | 'manual'>('one-click');

  // 1-Click state
  const [quickInput, setQuickInput] = useState('');
  const [quickSampleJson, setQuickSampleJson] = useState('');
  const [quickName, setQuickName] = useState('');
  const [quickMethod, setQuickMethod] = useState('POST');
  const [setupResult, setSetupResult] = useState<OneClickSetupResult | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Manual JSON state
  const [sampleText, setSampleText] = useState('');
  const [leaves, setLeaves] = useState<InferredLeaf[] | null>(null);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [method, setMethod] = useState('POST');
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const canCreate = useMemo(
    () => !!name && !!endpoint && !!leaves && leaves.length > 0 && !busy,
    [name, endpoint, leaves, busy],
  );

  const copySnippet = async (key: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success(`${label} copied`);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      toast.error('Clipboard unavailable');
    }
  };

  const applyPreset = (preset: (typeof APP_PRESETS)[number]) => {
    setQuickName(preset.name);
    setQuickInput(preset.endpoint);
    setQuickMethod(preset.method);
    setQuickSampleJson(JSON.stringify(preset.payload, null, 2));
    setSetupResult(null);
  };

  const runOneClickSetup = async () => {
    setBusy(true);
    setSetupResult(null);
    try {
      const trimmed = quickInput.trim();
      const isCurl = /^curl\s+/i.test(trimmed);

      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: isCurl ? undefined : trimmed || '/v1/app/endpoint',
          curl: isCurl ? trimmed : undefined,
          payload: quickSampleJson.trim() || undefined,
          name: quickName.trim() || undefined,
          method: quickMethod,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        contract?: OneClickSetupResult['contract'];
        verification?: OneClickSetupResult['verification'];
      };
      if (!res.ok || !data.contract || !data.verification) {
        toast.error(data.error ?? '1-Click setup failed');
        return;
      }

      setSetupResult({
        contract: data.contract,
        verification: data.verification,
      });
      toast.success('1-Click Setup Complete!', {
        description: `${data.contract.name} protected (${data.contract.fieldsCount} fields) & verified in ${data.verification.totalMs.toFixed(2)}ms`,
      });
      onCreated();
    } catch {
      toast.error('Setup service unreachable');
    } finally {
      setBusy(false);
    }
  };

  const infer = () => {
    try {
      const parsed: unknown = JSON.parse(sampleText);
      const found = inferLeaves(parsed);
      if (found.length === 0) {
        toast.error('No fields found in that JSON');
        return;
      }
      setLeaves(found);
      toast.success(`${found.length} fields inferred`);
    } catch {
      toast.error('Invalid JSON payload');
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/contracts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          endpoint,
          method,
          fields: leavesToFields(leaves ?? []),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Contract rejected');
        return;
      }
      toast.success('Contract registered', {
        description: `${name} · ${method} ${endpoint}`,
      });
      onCreated();
      onOpenChange(false);
      setSampleText('');
      setLeaves(null);
      setName('');
      setEndpoint('');
      setMethod('POST');
    } catch {
      toast.error('Registry unreachable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-border bg-card text-foreground sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Zap className="h-4 w-4 text-primary" />
            Connect & Protect Your App
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Set up API Healer with your application in one click or define a custom contract schema.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => setMode('one-click')}
            data-testid="connect-tab-one-click"
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              mode === 'one-click'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Zap className="h-3.5 w-3.5" />
            1-Click App Setup
          </button>
          <button
            type="button"
            onClick={() => setMode('manual')}
            data-testid="connect-tab-manual"
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors',
              mode === 'manual'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Custom JSON Schema
          </button>
        </div>

        {mode === 'one-click' ? (
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-foreground">
                1-Click App Templates (Instant Fill)
              </p>
              <div className="grid grid-cols-3 gap-2">
                {APP_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`preset-${preset.id}`}
                    onClick={() => applyPreset(preset)}
                    className="flex flex-col items-start rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent"
                  >
                    <span className="text-xs font-semibold text-foreground">{preset.label}</span>
                    <span className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {preset.method} {preset.endpoint}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">
                  Live Endpoint URL, Route Path, or cURL Command
                </p>
                <Input
                  value={quickInput}
                  onChange={(e) => setQuickInput(e.target.value)}
                  data-testid="one-click-endpoint-input"
                  placeholder="https://api.yourapp.com/v1/orders or curl https://..."
                  className="h-8 border-border bg-background font-mono text-xs text-foreground"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Method</p>
                <Select value={quickMethod} onValueChange={setQuickMethod}>
                  <SelectTrigger className="h-8 w-24 border-border bg-background text-xs text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['GET', 'POST', 'PUT', 'PATCH'].map((m) => (
                      <SelectItem key={m} value={m} className="text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Service Name (Optional)</p>
                <Input
                  value={quickName}
                  onChange={(e) => setQuickName(e.target.value)}
                  data-testid="one-click-name-input"
                  placeholder="Auto-detected from URL"
                  className="h-8 border-border bg-background text-xs text-foreground"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">
                  Sample Response JSON (Optional if URL is public)
                </p>
                <Input
                  value={quickSampleJson}
                  onChange={(e) => setQuickSampleJson(e.target.value)}
                  data-testid="one-click-sample-input"
                  placeholder='{"orderId":"101","amount":499,"status":"OK"}'
                  className="h-8 border-border bg-background font-mono text-xs text-foreground"
                />
              </div>
            </div>

            <Button
              type="button"
              disabled={busy || (!quickInput.trim() && !quickSampleJson.trim())}
              onClick={() => void runOneClickSetup()}
              data-testid="one-click-setup-submit"
              className="h-9 w-full gap-2 bg-primary text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              {busy ? 'Auto-Discovering & Verifying…' : '1-Click Auto-Setup & Verify'}
            </Button>

            {setupResult && (
              <div
                data-testid="one-click-setup-result"
                className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        {setupResult.contract.name} is Live & Protected
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        ID: {setupResult.contract.id} · {setupResult.contract.fieldsCount} fields (
                        {setupResult.contract.mandatoryCount} mandatory) · Verified{' '}
                        {setupResult.verification.status} in{' '}
                        {setupResult.verification.totalMs.toFixed(2)}ms
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="rounded-md border border-border bg-card p-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                        <Terminal className="h-3 w-3 text-primary" />
                        1-Click Terminal Installer (Run in your app folder)
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[11px]"
                        onClick={() =>
                          void copySnippet(
                            'cli',
                            `curl -fsSL "${origin}/api/setup/script?contractId=${setupResult.contract.id}" | sh`,
                            'Installer command',
                          )
                        }
                      >
                        {copiedKey === 'cli' ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {copiedKey === 'cli' ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <pre className="overflow-x-auto font-mono text-[11px] text-foreground/90">
                      {`curl -fsSL "${origin}/api/setup/script?contractId=${setupResult.contract.id}" | sh`}
                    </pre>
                  </div>

                  <div className="rounded-md border border-border bg-card p-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-foreground">
                        Zero-Code-Change Auto-Interceptor (1 Line)
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[11px]"
                        onClick={() =>
                          void copySnippet(
                            'auto',
                            `import { enableAutoHeal } from './api-healer-client';\nenableAutoHeal();`,
                            '1-Line setup',
                          )
                        }
                      >
                        {copiedKey === 'auto' ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {copiedKey === 'auto' ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <pre className="overflow-x-auto font-mono text-[11px] text-foreground/90">
                      {`import { enableAutoHeal } from './api-healer-client';\nenableAutoHeal();`}
                    </pre>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <a
                      href={`/api/setup/script?contractId=${encodeURIComponent(setupResult.contract.id)}&format=ts`}
                      download="api-healer-client.ts"
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download Pre-Configured SDK
                      </Button>
                    </a>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onOpenChange(false)}
                      className="h-8 bg-primary px-3 text-xs text-primary-foreground"
                    >
                      Done
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-foreground">JSON Payload</p>
              <Textarea
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder="{}"
                className="h-32 resize-none border-border bg-muted/40 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:bg-background"
                spellCheck={false}
              />
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-8 w-full border-border bg-background text-xs font-medium text-foreground hover:bg-accent"
                onClick={infer}
                disabled={!sampleText.trim()}
              >
                Infer Fields
              </Button>
            </div>

            {leaves && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-foreground">Fields</p>
                <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/40 p-2">
                  {leaves.map((l, i) => (
                    <div
                      key={l.path}
                      className="flex items-center gap-2 rounded px-2 py-1 hover:bg-card"
                    >
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">
                        {l.type}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {l.path}
                      </span>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        Required
                        <Switch
                          checked={l.mandatory}
                          className="scale-75"
                          onCheckedChange={(v) =>
                            setLeaves((prev) =>
                              (prev ?? []).map((x, xi) => (xi === i ? { ...x, mandatory: v } : x)),
                            )
                          }
                        />
                      </label>
                      <button
                        className="text-muted-foreground transition-colors hover:text-rose-500"
                        onClick={() =>
                          setLeaves((prev) => (prev ?? []).filter((_, xi) => xi !== i))
                        }
                        aria-label={`Remove ${l.path}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-2.5 sm:grid-cols-[1fr_1.4fr_auto]">
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Name</p>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Contract name"
                  className="h-8 border-border bg-background text-xs text-foreground"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Endpoint</p>
                <Input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="/v1/endpoint"
                  className="h-8 border-border bg-background font-mono text-xs text-foreground"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Method</p>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger className="h-8 w-24 border-border bg-background text-xs text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['GET', 'POST', 'PUT', 'PATCH'].map((m) => (
                      <SelectItem key={m} value={m} className="text-xs">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button
              disabled={!canCreate}
              onClick={create}
              className="h-9 w-full gap-2 bg-primary text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {busy ? 'Creating…' : 'Create Contract'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
