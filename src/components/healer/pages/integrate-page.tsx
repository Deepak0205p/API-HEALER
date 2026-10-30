'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Play,
  Terminal,
  Zap,
} from 'lucide-react';
import { PageHeader } from '../app-shell';
import { useHealer } from '../store';

const ONE_CLICK_CLI = (origin: string, contractId: string) =>
  `curl -fsSL "${origin}/api/setup/script?contractId=${contractId}" | sh`;

const AUTO_INTERCEPT_SNIPPET = (origin: string, contractId: string, endpoint: string) => `// 1-Click Zero-Code-Change Setup (place once in your app entry, e.g. instrumentation.ts or layout.tsx)
import { enableAutoHeal } from './api-healer-client';

enableAutoHeal({
  server: process.env.NEXT_PUBLIC_API_HEALER_URL ?? '${origin}',
  contract: '${contractId}',
  matchUrls: ['${endpoint}'],
});`;

const CLIENT_SNIPPET = (origin: string, contractId: string, endpoint: string) => `import { configureHealer, healerFetch, healPayload } from './api-healer-client';

configureHealer({ server: process.env.API_HEALER_URL ?? '${origin}' });

const res = await healerFetch(
  '${endpoint}',
  { method: 'POST', body: JSON.stringify(payload) },
  { contract: '${contractId}' },
);
const data = await res.json();

const { body, meta } = await healPayload('${contractId}', webhookBody);`;

const CURL_SNIPPET = (origin: string, contractId: string) => `curl -X POST ${origin}/api/heal \\
  -H 'content-type: application/json' \\
  -d '{
    "contractId": "${contractId}",
    "payload": { "status": "OK" },
    "allowLlm": true
  }'`;

function CopyBlock({ code, label }: { code: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setDone(true);
      toast.success(`${label} copied`);
      setTimeout(() => setDone(false), 1600);
    } catch {
      toast.error('Clipboard unavailable');
    }
  };
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-semibold text-foreground">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={copy}
          aria-label={`Copy ${label}`}
        >
          {done ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          {done ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground/90">
        {code}
      </pre>
    </div>
  );
}

export function IntegratePage() {
  const {
    contracts,
    refreshContracts,
    refreshEvents,
    refreshMetrics,
    refreshNotifications,
    openConnect,
  } = useHealer();
  const [selectedContractId, setSelectedContractId] = useState<string>('');
  const [verifying, setVerifying] = useState(false);
  const [quickUrl, setQuickUrl] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{
    status: string;
    totalMs: number;
    endpoint: string;
  } | null>(null);

  const activeContract =
    contracts.find((c) => c.id === selectedContractId) ?? contracts[0] ?? null;
  const contractId = activeContract?.id ?? '<contract-id>';
  const endpoint = activeContract?.endpoint ?? 'https://api.example.com/v1/resource';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

  const handleVerifyLive = async () => {
    if (!activeContract) {
      openConnect();
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verifyOnly: true,
          contractId: activeContract.id,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        verification?: { status: string; totalMs: number };
      };
      if (!res.ok || !data.verification) {
        toast.error(data.error ?? 'Verification failed');
        return;
      }
      setVerifyStatus({
        status: data.verification.status,
        totalMs: data.verification.totalMs,
        endpoint: activeContract.endpoint,
      });
      toast.success(
        `Verified ${activeContract.name}: ${data.verification.status} in ${data.verification.totalMs.toFixed(2)}ms`,
      );
      void refreshEvents();
      void refreshMetrics();
      void refreshNotifications();
    } catch {
      toast.error('Failed to verify connection');
    } finally {
      setVerifying(false);
    }
  };

  const handleInstantUrlSetup = async () => {
    if (!quickUrl.trim()) return;
    setQuickBusy(true);
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: quickUrl.trim(),
          payload: {
            id: 'item_101',
            status: 'ACTIVE',
            amount: 999,
            verified: true,
          },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        contract?: { id: string; name: string; endpoint: string };
        verification?: { status: string; totalMs: number };
      };
      if (!res.ok || !data.contract) {
        toast.error(data.error ?? 'Instant setup failed');
        return;
      }
      await refreshContracts();
      setSelectedContractId(data.contract.id);
      if (data.verification) {
        setVerifyStatus({
          status: data.verification.status,
          totalMs: data.verification.totalMs,
          endpoint: data.contract.endpoint,
        });
      }
      setQuickUrl('');
      toast.success(`1-Click Setup Ready: ${data.contract.name}`);
      void refreshEvents();
      void refreshMetrics();
      void refreshNotifications();
    } catch {
      toast.error('Setup request failed');
    } finally {
      setQuickBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {contracts.length > 0 && (
              <Select
                value={activeContract?.id ?? ''}
                onValueChange={(v) => setSelectedContractId(v)}
              >
                <SelectTrigger className="h-8 w-52 border-border bg-card text-xs text-foreground">
                  <SelectValue placeholder="Select contract" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={verifying}
              onClick={() => void handleVerifyLive()}
              data-testid="integrate-verify-connection-btn"
              className="h-8 gap-1.5 border-border bg-card text-xs font-medium text-foreground hover:bg-accent"
            >
              {verifying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5 text-emerald-500" />
              )}
              {activeContract ? 'Verify Live Connection' : '1-Click Wizard'}
            </Button>

            <a
              href={`/api/setup/script?contractId=${encodeURIComponent(contractId)}&format=ts`}
              download="api-healer-client.ts"
              className="shrink-0"
            >
              <Button
                size="sm"
                className="h-8 shrink-0 gap-1.5 whitespace-nowrap bg-primary text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <Download className="h-3.5 w-3.5" />
                Download Pre-Configured SDK
              </Button>
            </a>
          </div>
        }
      />

      {/* 1-Click Quick Connect Banner */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">
                1-Click App Setup & Auto-Installer
              </h2>
            </div>
            <p className="text-xs text-muted-foreground">
              Enter your app endpoint URL to auto-generate a pre-configured contract and 1-command SDK installer.
            </p>
          </div>

          <div className="flex w-full max-w-md items-center gap-2">
            <Input
              value={quickUrl}
              onChange={(e) => setQuickUrl(e.target.value)}
              data-testid="integrate-quick-url-input"
              placeholder="https://api.yourapp.com/v1/checkout"
              className="h-8 border-border bg-background font-mono text-xs text-foreground"
            />
            <Button
              type="button"
              size="sm"
              disabled={quickBusy || !quickUrl.trim()}
              onClick={() => void handleInstantUrlSetup()}
              data-testid="integrate-quick-setup-btn"
              className="h-8 shrink-0 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              {quickBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              1-Click Setup
            </Button>
          </div>
        </div>

        {verifyStatus && (
          <div
            data-testid="integrate-verify-banner"
            className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            <span>
              Live connection verified for <strong className="font-mono">{verifyStatus.endpoint}</strong> —{' '}
              <strong className="font-mono">{verifyStatus.status}</strong> in{' '}
              <strong className="font-mono">{verifyStatus.totalMs.toFixed(2)}ms</strong>.
            </span>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CopyBlock
          label="Step 1 · 1-Click Terminal Installer (Auto-detects src/lib)"
          code={ONE_CLICK_CLI(origin, contractId)}
        />
        <CopyBlock
          label="Step 2 · 1-Line Auto-Interceptor (Zero Callsite Changes)"
          code={AUTO_INTERCEPT_SNIPPET(origin, contractId, endpoint)}
        />
        <CopyBlock
          label="Explicit TypeScript SDK Wrapper"
          code={CLIENT_SNIPPET(origin, contractId, endpoint)}
        />
        <CopyBlock
          label="Direct HTTP Firewall Endpoint (cURL)"
          code={CURL_SNIPPET(origin, contractId)}
        />
      </div>

      {/* Render Web Service Hosting & Anti-Sleep Engine */}
          </div>
  );
}
