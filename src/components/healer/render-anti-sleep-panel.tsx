'use client';

import { useState, useEffect } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Flame,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import type { KeepAliveState, PingRecord } from '@/lib/render-keep-alive';

export function RenderAntiSleepPanel() {
  const [loading, setLoading] = useState(true);
  const [pinging, setPinging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [targetUrl, setTargetUrl] = useState('');
  const [state, setState] = useState<KeepAliveState | null>(null);
  const [healthData, setHealthData] = useState<{
    status: string;
    uptimeFormatted: string;
    memoryUsageMb: number;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const [resKeepAlive, resHealth] = await Promise.all([
        fetch('/api/keep-alive'),
        fetch('/api/health'),
      ]);

      if (resKeepAlive.ok) {
        const d = (await resKeepAlive.json()) as { state: KeepAliveState };
        setState(d.state);
        if (!targetUrl && d.state.targetUrl) {
          setTargetUrl(d.state.targetUrl);
        }
      }

      if (resHealth.ok) {
        const h = await resHealth.json();
        setHealthData({
          status: h.status,
          uptimeFormatted: h.uptimeFormatted,
          memoryUsageMb: h.platform?.memoryUsageMb ?? 0,
        });
      }
    } catch {
      // offline / quiet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchStatus();
    }, 0);
    const interval = setInterval(fetchStatus, 10000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);

  const handleCopy = async (key: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success(`${label} copied to clipboard`);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      toast.error('Failed to copy');
    }
  };

  const handleSaveUrl = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/keep-alive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetUrl }),
      });
      if (res.ok) {
        const d = await res.json();
        setState(d.state);
        toast.success('Render anti-sleep ping URL saved', {
          description: `Target set to: ${d.state.resolvedUrl}`,
        });
      } else {
        toast.error('Failed to update URL');
      }
    } catch {
      toast.error('Service unreachable');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/keep-alive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const d = await res.json();
        setState(d.state);
        toast.success(enabled ? 'Anti-Sleep 4m pinger activated' : 'Anti-Sleep pinger paused');
      }
    } catch {
      toast.error('Failed to toggle keep-alive');
    }
  };

  const handleTriggerPing = async () => {
    setPinging(true);
    try {
      const res = await fetch('/api/keep-alive?action=ping', { method: 'POST' });
      const d = await res.json();
      if (res.ok && d.ping) {
        setState(d.state);
        if (d.ping.status === 'SUCCESS') {
          toast.success('Keep-Alive Ping Succeeded', {
            description: `${d.ping.url} responded in ${d.ping.durationMs}ms (HTTP ${d.ping.statusCode})`,
          });
        } else {
          toast.warning('Ping encountered error', {
            description: d.ping.error || `HTTP ${d.ping.statusCode}`,
          });
        }
      } else {
        toast.error('Failed to send test ping');
      }
    } catch {
      toast.error('Ping request failed');
    } finally {
      setPinging(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Banner: Keep-Alive Pinger Status */}
      <Card className="border-border bg-card">
        <CardHeader className="py-3 px-4 border-b border-border">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Flame className="h-4 w-4 text-amber-500" />
                Render Anti-Sleep & Health Check Engine
              </CardTitle>
              <CardDescription className="text-xs">
                Keeps your Render Web Service permanently awake with an automated self-ping every 4 minutes.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono text-[11px]"
              >
                <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Cadence: 4 min (240s)
              </Badge>
              <div className="flex items-center gap-1.5 pl-2 border-l border-border">
                <span className="text-[11px] text-muted-foreground">Active</span>
                <Switch
                  checked={state?.enabled ?? true}
                  onCheckedChange={handleToggle}
                  className="scale-75"
                />
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-4 space-y-4">
          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg bg-muted/40 border border-border">
              <span className="text-[11px] text-muted-foreground block">Health Check Probe</span>
              <div className="mt-1 flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                <span className="font-mono text-xs font-semibold text-foreground">
                  {healthData?.status === 'ok' ? 'HTTP 200 OK' : 'Operational'}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground mt-0.5 block font-mono">/api/health</span>
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border">
              <span className="text-[11px] text-muted-foreground block">Service Uptime</span>
              <div className="mt-1 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-primary" />
                <span className="font-mono text-xs font-semibold text-foreground">
                  {healthData?.uptimeFormatted || 'Active'}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground mt-0.5 block">
                RAM: {healthData?.memoryUsageMb ?? 0} MB
              </span>
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border">
              <span className="text-[11px] text-muted-foreground block">Anti-Sleep Pings</span>
              <div className="mt-1 flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-mono text-xs font-semibold text-foreground">
                  {state?.totalPings ?? 0} sent
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground mt-0.5 block">
                {state?.successfulPings ?? 0} successful
              </span>
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border">
              <span className="text-[11px] text-muted-foreground block">Last Ping Latency</span>
              <div className="mt-1 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-sky-500" />
                <span className="font-mono text-xs font-semibold text-foreground">
                  {state?.lastPingLatencyMs !== null ? `${state?.lastPingLatencyMs}ms` : '—'}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground mt-0.5 block truncate">
                {state?.lastPingAt ? new Date(state.lastPingAt).toLocaleTimeString() : 'Pending'}
              </span>
            </div>
          </div>

          {/* Config URL Bar */}
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-primary" />
                Render External URL or Domain (Sends Public Traffic Every 4 Minutes)
              </label>
              <span className="text-[11px] text-muted-foreground">
                Target: <code className="font-mono text-foreground">{state?.resolvedUrl || '/api/health'}</code>
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://my-app.onrender.com (Auto-detected if on Render)"
                className="h-8 text-xs font-mono bg-background"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveUrl}
                disabled={saving}
                className="h-8 text-xs shrink-0"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Save URL
              </Button>
              <Button
                size="sm"
                onClick={handleTriggerPing}
                disabled={pinging}
                className="h-8 text-xs shrink-0 bg-primary text-primary-foreground font-medium"
              >
                {pinging ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1.5 fill-current" />
                )}
                Ping Now
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              💡 Tip: Render free tier puts services to sleep after 15 minutes of inactivity. This worker automatically hits your endpoint every 4 minutes so Render never sleeps.
            </p>
          </div>

          {/* Recent Pings Stream */}
          {state?.recentPings && state.recentPings.length > 0 && (
            <div className="pt-2">
              <span className="text-xs font-medium text-foreground block mb-2">Recent Anti-Sleep Pings</span>
              <div className="space-y-1.5 max-h-36 overflow-y-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-[11px]">
                {state.recentPings.map((p, idx) => (
                  <div key={idx} className="flex items-center justify-between py-0.5 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 truncate">
                      <span className={`h-1.5 w-1.5 rounded-full ${p.status === 'SUCCESS' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                      <span className="text-muted-foreground">{new Date(p.timestamp).toLocaleTimeString()}</span>
                      <span className="text-foreground truncate max-w-[280px]">{p.url}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={p.status === 'SUCCESS' ? 'text-emerald-500 font-semibold' : 'text-rose-500'}>
                        {p.statusCode ? `HTTP ${p.statusCode}` : p.status}
                      </span>
                      <span className="text-muted-foreground">{p.durationMs}ms</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Render Hosting Configuration Cheat-Sheet */}
      <Card className="border-border bg-card">
        <CardHeader className="py-3 px-4 border-b border-border">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            Render.com Web Service Hosting Configuration
          </CardTitle>
          <CardDescription className="text-xs">
            Deploy this application on Render as a Node.js Web Service or Docker container.
          </CardDescription>
        </CardHeader>

        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-3 rounded-lg border border-border bg-muted/30 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Build Command</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => handleCopy('build', 'npm install && npm run build', 'Build command')}
                >
                  {copiedKey === 'build' ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
              <code className="text-xs font-mono block p-1.5 rounded bg-background border border-border text-foreground">
                npm install && npm run build
              </code>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted/30 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Start Command</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => handleCopy('start', 'node .next/standalone/server.js', 'Start command')}
                >
                  {copiedKey === 'start' ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
              <code className="text-xs font-mono block p-1.5 rounded bg-background border border-border text-foreground">
                node .next/standalone/server.js
              </code>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted/30 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">Health Check Path</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => handleCopy('health', '/api/health', 'Health check path')}
                >
                  {copiedKey === 'health' ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
              <code className="text-xs font-mono block p-1.5 rounded bg-background border border-border text-foreground">
                /api/health
              </code>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="space-y-0.5">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5 text-primary" />
                Render Blueprint File Ready (<code className="font-mono text-primary">render.yaml</code>)
              </span>
              <p className="text-muted-foreground text-[11px]">
                A pre-configured <code>render.yaml</code> and <code>Dockerfile</code> are included at the root of the project for 1-click Blueprints or Docker container deploys.
              </p>
            </div>
            <a href="/render.yaml" download="render.yaml">
              <Button size="sm" variant="outline" className="h-7 text-xs shrink-0 gap-1">
                View render.yaml
              </Button>
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
