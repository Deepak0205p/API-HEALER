'use client';

import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  buildWorkerLatencyTrends24h,
  CORE_WORKER_TYPES,
  type CoreWorkerType,
} from '@/lib/healer/system-health';
import { useHealer } from './store';
import type { JobRow } from './ui-types';

function getWorkerSeriesMeta(isDark: boolean): Record<
  CoreWorkerType,
  {
    label: string;
    color: string;
    dotFill: string;
    textClass: string;
  }
> {
  return {
    CANARY: {
      label: 'CANARY',
      color: isDark ? '#fafafa' : '#18181b',
      dotFill: isDark ? '#fafafa' : '#18181b',
      textClass: 'text-foreground',
    },
    PR_GENERATION: {
      label: 'PR_GENERATION',
      color: isDark ? '#38bdf8' : '#0284c7',
      dotFill: isDark ? '#38bdf8' : '#0284c7',
      textClass: 'text-sky-700 dark:text-sky-400',
    },
    TTL_SWEEP: {
      label: 'TTL_SWEEP',
      color: isDark ? '#fbbf24' : '#d97706',
      dotFill: isDark ? '#fbbf24' : '#d97706',
      textClass: 'text-amber-700 dark:text-amber-400',
    },
    METRICS: {
      label: 'METRICS',
      color: isDark ? '#34d399' : '#059669',
      dotFill: isDark ? '#34d399' : '#059669',
      textClass: 'text-emerald-700 dark:text-emerald-400',
    },
  };
}

export interface WorkerLatencyChartProps {
  jobs: JobRow[];
  selectedWorker?: CoreWorkerType | 'ALL';
  onSelectWorker?: (worker: CoreWorkerType | 'ALL') => void;
}

export function WorkerLatencyChart({
  jobs,
  selectedWorker = 'ALL',
  onSelectWorker,
}: WorkerLatencyChartProps) {
  const { theme } = useHealer();
  const isDark = theme === 'dark';
  const seriesMeta = getWorkerSeriesMeta(isDark);

  const [granularity, setGranularity] = useState<'adaptive' | 'hourly'>('adaptive');
  const [hiddenWorkers, setHiddenWorkers] = useState<Record<CoreWorkerType, boolean>>({
    CANARY: false,
    PR_GENERATION: false,
    TTL_SWEEP: false,
    METRICS: false,
  });

  const trends = buildWorkerLatencyTrends24h(jobs);
  const chartData =
    granularity === 'hourly' ? trends.hourlyPoints : trends.adaptivePoints;

  const activeStats =
    selectedWorker === 'ALL'
      ? trends.overall
      : trends.byWorker[selectedWorker];

  const toggleWorkerSeries = (type: CoreWorkerType) => {
    if (selectedWorker !== 'ALL' && onSelectWorker) {
      onSelectWorker(selectedWorker === type ? 'ALL' : type);
      return;
    }
    setHiddenWorkers((prev) => ({ ...prev, [type]: !prev[type] }));
  };

  const isWorkerVisible = (type: CoreWorkerType): boolean => {
    if (selectedWorker !== 'ALL') {
      return selectedWorker === type;
    }
    return !hiddenWorkers[type];
  };

  const gridStroke = isDark ? '#27272a' : '#e4e4e7';
  const axisTickColor = isDark ? '#a1a1aa' : '#71717a';
  const dotStroke = isDark ? '#121215' : '#ffffff';

  return (
    <section
      aria-label="Job Latency Trends (Last 24 Hours)"
      data-testid="worker-latency-chart"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 className="text-sm font-semibold text-foreground">
            Latency Trends (24h)
          </h2>
          <span className="text-muted-foreground/40" aria-hidden="true">·</span>
          <div
            data-testid="latency-chart-percentiles"
            className="flex flex-wrap items-center gap-1.5 font-mono text-xs tabular-nums text-muted-foreground"
          >
            <span>P50 {activeStats.p50Ms}ms</span>
            <span aria-hidden="true">·</span>
            <span>P95 {activeStats.p95Ms}ms</span>
            <span aria-hidden="true">·</span>
            <span>Peak {activeStats.peakMs}ms</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Toggle worker latency series"
            className="flex flex-wrap items-center gap-1"
          >
            {CORE_WORKER_TYPES.map((type) => {
              const meta = seriesMeta[type];
              const visible = isWorkerVisible(type);
              const wStats = trends.byWorker[type];
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleWorkerSeries(type)}
                  aria-pressed={visible}
                  data-testid={`chart-series-toggle-${type}`}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-[10px] font-medium transition-colors',
                    visible
                      ? 'border-border bg-muted/60 text-foreground'
                      : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-xs"
                    style={{
                      backgroundColor: visible ? meta.color : isDark ? '#52525b' : '#d4d4d8',
                    }}
                  />
                  <span>{type}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {wStats.avgMs > 0 ? `${wStats.avgMs}ms` : '—'}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            role="group"
            aria-label="Latency chart time resolution"
            className="flex items-center gap-1 rounded-md bg-muted p-1"
          >
            <button
              type="button"
              onClick={() => setGranularity('adaptive')}
              aria-pressed={granularity === 'adaptive'}
              data-testid="granularity-adaptive-btn"
              className={cn(
                'shrink-0 whitespace-nowrap rounded px-2.5 py-1 font-mono text-[10px] font-medium transition-colors',
                granularity === 'adaptive'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setGranularity('hourly')}
              aria-pressed={granularity === 'hourly'}
              data-testid="granularity-hourly-btn"
              className={cn(
                'shrink-0 whitespace-nowrap rounded px-2.5 py-1 font-mono text-[10px] font-medium transition-colors',
                granularity === 'hourly'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Hourly
            </button>
          </div>
        </div>
      </div>

      <div className="px-3 pt-4 pb-2 sm:px-5">
        {trends.overall.sampleCount === 0 ? (
          <div className="flex h-60 flex-col items-center justify-center text-center">
            <p className="text-xs font-medium text-muted-foreground">
              No latency samples recorded in the last 24 hours.
            </p>
          </div>
        ) : (
          <div className="h-60 w-full" data-testid="recharts-latency-container">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 8, right: 16, left: 0, bottom: 4 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke={gridStroke}
                />
                <XAxis
                  dataKey="bucketLabel"
                  tick={{ fontSize: 10, fill: axisTickColor, fontFamily: 'var(--font-geist-mono)' }}
                  axisLine={{ stroke: gridStroke }}
                  tickLine={false}
                  minTickGap={20}
                />
                <YAxis
                  unit="ms"
                  width={48}
                  tick={{ fontSize: 10, fill: axisTickColor, fontFamily: 'var(--font-geist-mono)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDark ? '#18181c' : '#ffffff',
                    borderColor: gridStroke,
                    color: isDark ? '#fafafa' : '#09090b',
                    borderRadius: '0.5rem',
                    fontSize: '11px',
                    fontFamily: 'var(--font-geist-mono)',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.16)',
                  }}
                  labelFormatter={(_, payload) => {
                    const item = payload?.[0]?.payload as
                      | { windowLabel?: string; totalSamples?: number }
                      | undefined;
                    if (!item) return '';
                    return `${item.windowLabel ?? ''} · ${item.totalSamples ?? 0} runs`;
                  }}
                  formatter={(value: unknown, name: unknown) => [
                    typeof value === 'number' ? `${value}ms` : '—',
                    String(name),
                  ]}
                />
                {CORE_WORKER_TYPES.map((type) => {
                  if (!isWorkerVisible(type)) return null;
                  const meta = seriesMeta[type];
                  return (
                    <Line
                      key={type}
                      type="monotone"
                      dataKey={type}
                      name={meta.label}
                      stroke={meta.color}
                      strokeWidth={2}
                      connectNulls
                      isAnimationActive={false}
                      dot={{
                        r: 2.5,
                        fill: meta.dotFill,
                        strokeWidth: 1.5,
                        stroke: dotStroke,
                      }}
                      activeDot={{
                        r: 4,
                        fill: meta.color,
                        stroke: dotStroke,
                        strokeWidth: 2,
                      }}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-border border-t border-border bg-muted/30 font-mono text-[11px] tabular-nums sm:grid-cols-4 sm:divide-y-0">
        {CORE_WORKER_TYPES.map((type) => {
          const stat = trends.byWorker[type];
          const meta = seriesMeta[type];
          return (
            <div key={type} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className={cn('font-semibold', meta.textClass)}>{type}</span>
                <span className="text-[10px] text-muted-foreground">
                  {stat.sampleCount} runs
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>P50 {stat.sampleCount > 0 ? `${stat.p50Ms}ms` : '—'}</span>
                <span>P95 {stat.sampleCount > 0 ? `${stat.p95Ms}ms` : '—'}</span>
                <span>Peak {stat.sampleCount > 0 ? `${stat.peakMs}ms` : '—'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
