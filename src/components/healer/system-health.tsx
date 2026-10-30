'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
  Play,
  RefreshCw,
  ArrowUpRight,
  Bell,
  Flame,
  RotateCcw,
  Check,
  Minus,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  computeSystemHealth,
  CORE_WORKER_TYPES,
  DEFAULT_WORKER_ALERT_CONFIG,
  evaluateWorkerAlerts,
  normalizeWorkerAlertConfig,
  type CoreWorkerType,
  type WorkerAlertConfig,
  type WorkerHealthState,
  type WorkerHealthSummary,
} from '@/lib/healer/system-health';
import type { JobQueueStats, JobRow } from './ui-types';

const STATE_VISUALS: Record<
  WorkerHealthState,
  {
    icon: React.ReactNode;
    textClass: string;
    barClass: string;
    signalColor: string;
    activeBars: number;
  }
> = {
  RUNNING: {
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />,
    textClass: 'text-foreground',
    barClass: 'bg-primary',
    signalColor: 'bg-primary',
    activeBars: 4,
  },
  HEALTHY: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />,
    textClass: 'text-emerald-700 dark:text-emerald-400',
    barClass: 'bg-emerald-600 dark:bg-emerald-400',
    signalColor: 'bg-emerald-600 dark:bg-emerald-400',
    activeBars: 4,
  },
  STANDBY: {
    icon: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
    textClass: 'text-muted-foreground',
    barClass: 'bg-muted-foreground/60',
    signalColor: 'bg-emerald-600/70 dark:bg-emerald-400/70',
    activeBars: 3,
  },
  DEGRADED: {
    icon: <AlertTriangle className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />,
    textClass: 'text-rose-700 dark:text-rose-400',
    barClass: 'bg-rose-600 dark:bg-rose-400',
    signalColor: 'bg-rose-600 dark:bg-rose-400',
    activeBars: 1,
  },
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Idle';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'Now';
  const secs = Math.floor(diffMs / 1000);
  if (secs < 5) return 'Now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function LiveSignalIndicator({ state }: { state: WorkerHealthState }) {
  const vis = STATE_VISUALS[state];
  const heights = ['h-1.5', 'h-2', 'h-2.5', 'h-3'];
  return (
    <span
      className="inline-flex items-end gap-0.5"
      aria-hidden="true"
      title={`Signal state: ${state}`}
    >
      {heights.map((h, idx) => (
        <span
          key={idx}
          className={cn(
            'w-1 rounded-[1px] transition-opacity duration-150',
            h,
            idx < vis.activeBars ? vis.signalColor : 'bg-muted-foreground/20',
          )}
        />
      ))}
    </span>
  );
}

function LatencySparkline({
  latencies,
  state,
}: {
  latencies: number[];
  state: WorkerHealthState;
}) {
  const slots = 8;
  const padded = [
    ...Array.from({ length: Math.max(0, slots - latencies.length) }, () => null),
    ...latencies.slice(-slots),
  ];
  const maxVal = Math.max(...latencies, 10);
  const vis = STATE_VISUALS[state];

  return (
    <div
      className="flex h-6 items-end gap-1 pt-1"
      aria-label={
        latencies.length > 0
          ? `Recent execution latencies: ${latencies.map((n) => `${n}ms`).join(', ')}`
          : 'No execution latency samples yet'
      }
    >
      {padded.map((val, idx) => {
        if (val === null) {
          return <span key={idx} className="h-1 flex-1 rounded-xs bg-muted" />;
        }
        const pct = Math.max(20, Math.min(100, Math.round((val / maxVal) * 100)));
        return (
          <span
            key={idx}
            style={{ height: `${pct}%` }}
            title={`${val}ms`}
            className={cn(
              'flex-1 rounded-xs opacity-85 transition-opacity hover:opacity-100',
              vis.barClass,
            )}
          />
        );
      })}
    </div>
  );
}

export interface SystemHealthProps {
  jobs: JobRow[];
  jobStats?: JobQueueStats | null;
  connected?: boolean;
  alertConfig?: WorkerAlertConfig;
  onUpdateAlertConfig?: (next: WorkerAlertConfig) => void;
  onSimulateFailure?: (type: CoreWorkerType) => Promise<void>;
  onClearFailures?: (type?: CoreWorkerType) => Promise<void>;
  selectedWorker?: CoreWorkerType | 'ALL';
  onSelectWorker?: (worker: CoreWorkerType | 'ALL') => void;
  onTriggerWorker?: (type: 'TTL_SWEEP' | 'METRICS') => Promise<void>;
  onRefresh?: () => Promise<void>;
  onNavigateWorkers?: () => void;
  compact?: boolean;
}

export function SystemHealth({
  jobs,
  jobStats,
  alertConfig = DEFAULT_WORKER_ALERT_CONFIG,
  onUpdateAlertConfig,
  onSimulateFailure,
  onClearFailures,
  selectedWorker = 'ALL',
  onSelectWorker,
  onTriggerWorker,
  onRefresh,
  onNavigateWorkers,
}: SystemHealthProps) {
  const [triggeringType, setTriggeringType] = useState<string | null>(null);
  const [simulatingType, setSimulatingType] = useState<string | null>(null);
  const [clearingFailures, setClearingFailures] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [draftConfig, setDraftConfig] = useState<WorkerAlertConfig>(() =>
    normalizeWorkerAlertConfig(alertConfig),
  );

  const overview = computeSystemHealth(jobs, jobStats);
  const { activeBreaches } = evaluateWorkerAlerts(
    overview.workers,
    jobs,
    alertConfig,
  );
  const totalFailedRuns = overview.workers.reduce(
    (sum, w) => sum + w.failedCount,
    0,
  );
  const enabledRulesCount = CORE_WORKER_TYPES.filter(
    (t) => alertConfig[t]?.enabled,
  ).length;

  const handleTrigger = async (
    e: React.MouseEvent,
    type: 'TTL_SWEEP' | 'METRICS',
  ) => {
    e.stopPropagation();
    if (!onTriggerWorker || triggeringType) return;
    setTriggeringType(type);
    try {
      await onTriggerWorker(type);
    } finally {
      setTriggeringType(null);
    }
  };

  const handleSimulateFailure = async (
    e: React.MouseEvent,
    type: CoreWorkerType,
  ) => {
    e.stopPropagation();
    if (!onSimulateFailure || simulatingType) return;
    setSimulatingType(type);
    try {
      await onSimulateFailure(type);
    } finally {
      setSimulatingType(null);
    }
  };

  const handleClearFailures = async () => {
    if (!onClearFailures || clearingFailures) return;
    setClearingFailures(true);
    try {
      await onClearFailures();
    } finally {
      setClearingFailures(false);
    }
  };

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const updateDraftRule = (
    type: CoreWorkerType,
    patch: Partial<{ enabled: boolean; failureThreshold: number }>,
  ) => {
    setDraftConfig((prev) => ({
      ...prev,
      [type]: {
        ...prev[type],
        ...patch,
        failureThreshold:
          patch.failureThreshold !== undefined
            ? Math.max(1, Math.min(20, Math.round(patch.failureThreshold)))
            : prev[type].failureThreshold,
      },
    }));
  };

  const handleSaveConfig = () => {
    onUpdateAlertConfig?.(draftConfig);
  };

  const handleResetDefaults = () => {
    setDraftConfig(DEFAULT_WORKER_ALERT_CONFIG);
    onUpdateAlertConfig?.(DEFAULT_WORKER_ALERT_CONFIG);
  };

  return (
    <section
      aria-label="System Health Dashboard"
      data-testid="system-health-dashboard"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 className="text-sm font-semibold text-foreground">System Health</h2>
          <span className="text-muted-foreground/40" aria-hidden="true">·</span>
          <span
            data-testid="system-health-overall-status"
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-medium',
              overview.overallState === 'DEGRADED' || activeBreaches.length > 0
                ? 'text-rose-700 dark:text-rose-400'
                : overview.overallState === 'ACTIVE'
                  ? 'text-foreground'
                  : 'text-emerald-700 dark:text-emerald-400',
            )}
          >
            {overview.overallState === 'DEGRADED' || activeBreaches.length > 0 ? (
              <AlertTriangle className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
            ) : overview.overallState === 'ACTIVE' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            )}
            {activeBreaches.length > 0
              ? `${activeBreaches.length} Alert${activeBreaches.length > 1 ? 's' : ''}`
              : overview.overallLabel}
          </span>
          <span className="hidden text-muted-foreground/40 sm:inline" aria-hidden="true">·</span>
          <span className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:inline">
            {overview.healthyWorkerCount}/{overview.totalWorkers} healthy · {overview.totalJobsProcessed} runs
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onSelectWorker && (
            <div
              role="group"
              aria-label="Filter by worker type"
              className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-muted p-1"
            >
              {(['ALL', 'CANARY', 'PR_GENERATION', 'TTL_SWEEP', 'METRICS'] as const).map(
                (type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => onSelectWorker(type)}
                    aria-pressed={selectedWorker === type}
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded px-2.5 py-1 font-mono text-[10px] font-medium transition-colors',
                      selectedWorker === type
                        ? 'bg-card text-foreground shadow-2xs'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {type === 'ALL' ? 'All' : type}
                  </button>
                ),
              )}
            </div>
          )}

          <Button
            type="button"
            variant={configOpen ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              if (!configOpen) {
                setDraftConfig(normalizeWorkerAlertConfig(alertConfig));
              }
              setConfigOpen((v) => !v);
            }}
            aria-expanded={configOpen}
            aria-label="Configure worker failure threshold alerts"
            data-testid="toggle-alert-config-btn"
            className={cn(
              'h-7 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-xs',
              configOpen
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : activeBreaches.length > 0
                  ? 'border-rose-500/40 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400'
                  : 'border-border bg-card text-foreground hover:bg-accent',
            )}
          >
            <Bell className="h-3 w-3" />
            {activeBreaches.length > 0
              ? `Alerts (${activeBreaches.length})`
              : `Alerts (${enabledRulesCount}/4)`}
          </Button>

          {onRefresh && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="h-7 shrink-0 gap-1.5 whitespace-nowrap border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent"
              aria-label="Refresh system health telemetry"
            >
              <RefreshCw
                className={cn('h-3 w-3', refreshing && 'animate-spin')}
              />
              Refresh
            </Button>
          )}

          {onNavigateWorkers && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onNavigateWorkers}
              className="h-7 shrink-0 gap-1 whitespace-nowrap px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Details
              <ArrowUpRight className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {configOpen && (
        <div
          role="region"
          aria-label="Worker Failure Threshold Alert Configuration"
          data-testid="worker-alert-config-panel"
          className="border-b border-border bg-muted/40 px-4 py-4 sm:px-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
            <h3 className="text-xs font-semibold text-foreground">
              Failure Threshold Alerts
            </h3>

            <div className="flex flex-wrap items-center gap-2">
              {totalFailedRuns > 0 && onClearFailures && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={clearingFailures}
                  onClick={() => void handleClearFailures()}
                  className="h-7 shrink-0 gap-1.5 whitespace-nowrap border-border bg-card px-2.5 text-xs text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                >
                  <RotateCcw className="h-3 w-3" />
                  Clear Failures ({totalFailedRuns})
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleResetDefaults}
                className="h-7 shrink-0 whitespace-nowrap px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSaveConfig}
                data-testid="save-alert-thresholds-btn"
                className="h-7 shrink-0 gap-1.5 whitespace-nowrap bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <Check className="h-3 w-3" />
                Save
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {overview.workers.map((worker) => {
              const rule = draftConfig[worker.type] ?? {
                enabled: true,
                failureThreshold: 2,
              };
              const isBreached =
                rule.enabled && worker.failedCount >= rule.failureThreshold;
              const isSimulating = simulatingType === worker.type;

              return (
                <div
                  key={worker.type}
                  data-testid={`alert-rule-row-${worker.type}`}
                  className={cn(
                    'flex flex-col justify-between rounded-lg border bg-card p-3.5 transition-colors',
                    isBreached ? 'border-rose-500/50' : 'border-border',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-foreground">
                      {worker.type}
                    </span>
                    <Switch
                      id={`alert-switch-${worker.type}`}
                      checked={rule.enabled}
                      onCheckedChange={(checked) =>
                        updateDraftRule(worker.type, { enabled: checked })
                      }
                      aria-label={`Enable failure alert for ${worker.type}`}
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2">
                    <label
                      htmlFor={`alert-threshold-${worker.type}`}
                      className="text-xs text-muted-foreground"
                    >
                      Threshold
                    </label>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={!rule.enabled || rule.failureThreshold <= 1}
                        onClick={() =>
                          updateDraftRule(worker.type, {
                            failureThreshold: rule.failureThreshold - 1,
                          })
                        }
                        aria-label={`Decrease failure threshold for ${worker.type}`}
                        className="h-6 w-6 border-border bg-background"
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <Input
                        id={`alert-threshold-${worker.type}`}
                        type="number"
                        min={1}
                        max={20}
                        disabled={!rule.enabled}
                        value={rule.failureThreshold}
                        onChange={(e) =>
                          updateDraftRule(worker.type, {
                            failureThreshold: Number(e.target.value || 1),
                          })
                        }
                        aria-label={`Failure threshold count for ${worker.type}`}
                        className="h-6 w-12 border-border bg-background px-1.5 text-center font-mono text-xs tabular-nums text-foreground"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={!rule.enabled || rule.failureThreshold >= 20}
                        onClick={() =>
                          updateDraftRule(worker.type, {
                            failureThreshold: rule.failureThreshold + 1,
                          })
                        }
                        aria-label={`Increase failure threshold for ${worker.type}`}
                        className="h-6 w-6 border-border bg-background"
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5 font-mono text-[11px] tabular-nums">
                    <span
                      className={cn(
                        isBreached ? 'font-semibold text-rose-600 dark:text-rose-400' : 'text-muted-foreground',
                      )}
                    >
                      {worker.failedCount}/{rule.failureThreshold} failed
                    </span>

                    {onSimulateFailure && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isSimulating}
                        onClick={(e) => void handleSimulateFailure(e, worker.type)}
                        aria-label={`Simulate failure for ${worker.type}`}
                        data-testid={`simulate-failure-${worker.type}`}
                        className="h-6 shrink-0 gap-1 whitespace-nowrap px-2 font-mono text-[10px] font-medium text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
                      >
                        {isSimulating ? (
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        ) : (
                          <Flame className="h-2.5 w-2.5" />
                        )}
                        Simulate Failure
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
        {overview.workers.map((worker: WorkerHealthSummary) => {
          const vis = STATE_VISUALS[worker.state];
          const isSelected = selectedWorker === worker.type;
          const isTriggering = triggeringType === worker.type;
          const rule = alertConfig[worker.type] ?? DEFAULT_WORKER_ALERT_CONFIG[worker.type];
          const isAlertBreached =
            rule.enabled && worker.failedCount >= rule.failureThreshold;

          return (
            <div
              key={worker.type}
              role="region"
              aria-label={`${worker.type} worker health`}
              data-testid={`worker-health-card-${worker.type}`}
              onClick={
                onSelectWorker
                  ? () =>
                      onSelectWorker(
                        selectedWorker === worker.type ? 'ALL' : worker.type,
                      )
                  : undefined
              }
              className={cn(
                'flex flex-col justify-between p-4 transition-colors sm:p-5',
                onSelectWorker && 'cursor-pointer hover:bg-accent/50',
                isSelected && 'bg-accent/70',
                isAlertBreached && 'bg-rose-500/5',
              )}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-semibold text-foreground">
                    {worker.type}
                  </span>

                  <div
                    data-testid={`worker-status-${worker.type}`}
                    className="flex shrink-0 items-center gap-1.5"
                  >
                    <LiveSignalIndicator state={worker.state} />
                    {vis.icon}
                    <span
                      className={cn(
                        'whitespace-nowrap font-mono text-[11px] font-medium',
                        vis.textClass,
                      )}
                    >
                      {worker.stateLabel}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2.5">
                <div className="grid grid-cols-3 gap-2 border-y border-border/60 py-2 font-mono tabular-nums">
                  <div>
                    <span className="block text-[10px] text-muted-foreground">Runs</span>
                    <span
                      data-testid={`worker-runs-${worker.type}`}
                      className="text-xs font-semibold text-foreground"
                    >
                      {worker.doneCount}
                      {worker.failedCount > 0 ? ` (${worker.failedCount} err)` : ''}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-muted-foreground">Success</span>
                    <span
                      className={cn(
                        'text-xs font-semibold',
                        worker.successRatePct < 90
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-emerald-600 dark:text-emerald-400',
                      )}
                    >
                      {worker.successRatePct}%
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="block text-[10px] text-muted-foreground">Latency</span>
                    <span className="text-xs font-semibold text-foreground">
                      {worker.avgMs > 0 ? `${worker.avgMs}ms` : '—'}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
                    <span>Recent</span>
                    <span>
                      {worker.lastRunMs !== null ? `${worker.lastRunMs}ms` : '—'}
                    </span>
                  </div>
                  <LatencySparkline
                    latencies={worker.recentLatencies}
                    state={worker.state}
                  />
                </div>

                {isAlertBreached && (
                  <div
                    data-testid={`worker-alert-breach-${worker.type}`}
                    className="flex items-center gap-1.5 font-mono text-[10px] font-medium text-rose-700 dark:text-rose-400"
                  >
                    <AlertTriangle className="h-3 w-3 shrink-0 text-rose-600 dark:text-rose-400" />
                    <span className="truncate">
                      Threshold breached ({worker.failedCount}/{rule.failureThreshold})
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    <span>{worker.cadence}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatRelativeTime(worker.lastRunAt)}</span>
                  </div>

                  {worker.canTriggerManually && onTriggerWorker && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isTriggering}
                      onClick={(e) =>
                        void handleTrigger(
                          e,
                          worker.type as 'TTL_SWEEP' | 'METRICS',
                        )
                      }
                      aria-label={`Run ${worker.type} worker now`}
                      className="h-6 shrink-0 gap-1 whitespace-nowrap px-2 font-mono text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {isTriggering ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        <Play className="h-2.5 w-2.5" />
                      )}
                      Run Now
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

