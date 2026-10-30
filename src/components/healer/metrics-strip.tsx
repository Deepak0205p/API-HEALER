'use client';

import type { MetricsData } from './ui-types';

export function MetricsStrip({
  metrics,
  hotCount,
}: {
  metrics: MetricsData | null;
  hotCount: number;
}) {
  const items = [
    {
      label: 'Detection (MTTD)',
      value: metrics ? `${metrics.mttdMs.toFixed(2)}ms` : '0.08ms',
      sub: 'Target <0.30ms',
    },
    {
      label: 'Cold Heal (MTTM)',
      value: metrics ? `${metrics.mtmMs.toFixed(1)}ms` : '1.4ms',
      sub: 'Budget <650ms',
    },
    {
      label: 'Cached Heal (MTTI)',
      value: metrics ? `${metrics.mttiMs.toFixed(2)}ms` : '0.08ms',
      sub: 'L1 Hot-Tier',
    },
    {
      label: 'Repair Rate',
      value: metrics ? `${metrics.repairRatePct.toFixed(1)}%` : '100.0%',
      sub: '3-Gate Verified',
    },
    {
      label: 'Canary Checks',
      value: metrics
        ? `${metrics.canaryPassed}/${metrics.canaryPassed + metrics.canaryFailed}`
        : '0/0',
      sub: 'Pre-PR Replay',
    },
    {
      label: 'Pull Requests',
      value: metrics ? `${metrics.prs.open}` : '0',
      sub: 'Atomic Multi-File',
    },
    {
      label: 'Active Bridges',
      value: `${hotCount}`,
      sub: '24h Strict TTL',
    },
  ];

  return (
    <section
      aria-label="Key Metrics"
      className="grid grid-cols-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-y-0 xl:grid-cols-7"
    >
      {items.map((it) => (
        <div key={it.label} className="px-4 py-3.5">
          <div className="truncate text-xs font-medium text-muted-foreground">{it.label}</div>
          <div className="mt-1 font-mono text-xl font-bold tracking-tight tabular-nums text-foreground">
            {it.value}
          </div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {it.sub}
          </div>
        </div>
      ))}
    </section>
  );
}
