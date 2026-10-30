'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { CircleCheck, CircleX, Loader2, Clock, Download, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  canAutoRetryJob,
  formatJobsCsv,
  isAutoRetriedJob,
} from '@/lib/healer/system-health';
import type { JobRow, MetricsData } from './ui-types';

const ICONS: Record<string, React.ReactNode> = {
  DONE: <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />,
  FAILED: <CircleX className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />,
  RUNNING: <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground" />,
  QUEUED: <Clock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />,
};

function formatAuditTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function JobsPanel({
  jobs,
  onRetryJob,
}: {
  jobs: JobRow[];
  breakers?: MetricsData['breakers'];
  onRetryJob?: (jobId: string, autoRetry?: boolean) => Promise<boolean>;
}) {
  const [autoRetryMap, setAutoRetryMap] = useState<Record<string, boolean>>({});
  const [retryingMap, setRetryingMap] = useState<Record<string, boolean>>({});

  const failedCount = jobs.filter((j) => canAutoRetryJob(j)).length;

  const handleToggleAutoRetry = async (job: JobRow, checked: boolean) => {
    setAutoRetryMap((prev) => ({ ...prev, [job.id]: checked }));
    if (!checked || retryingMap[job.id]) return;

    setRetryingMap((prev) => ({ ...prev, [job.id]: true }));
    try {
      if (onRetryJob) {
        const ok = await onRetryJob(job.id, true);
        if (!ok) {
          setAutoRetryMap((prev) => ({ ...prev, [job.id]: false }));
        }
      } else {
        const r = await fetch('/api/jobs', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: job.id, autoRetry: true }),
        });
        if (!r.ok) {
          toast.error(`Failed to queue Auto-Retry for ${job.type}`);
          setAutoRetryMap((prev) => ({ ...prev, [job.id]: false }));
        } else {
          toast.success(`Auto-Retry completed for ${job.type} job ${job.id.slice(0, 8)}`);
        }
      }
    } finally {
      setRetryingMap((prev) => ({ ...prev, [job.id]: false }));
    }
  };

  const handleExportCsv = () => {
    if (jobs.length === 0) {
      toast.info('No job records available to export.');
      return;
    }

    const csvContent = formatJobsCsv(jobs);
    const blob = new Blob(['\uFEFF' + csvContent], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `api-healer-job-ledger-${stamp}.csv`;

    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast.success(`Exported ${jobs.length} rows to CSV`, {
      description: filename,
    });
  };

  return (
    <div
      data-testid="jobs-panel"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Job Ledger</h3>
          <span className="text-muted-foreground/40" aria-hidden="true">·</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {jobs.length}
          </span>
          {failedCount > 0 && (
            <>
              <span className="text-muted-foreground/40" aria-hidden="true">·</span>
              <span
                data-testid="jobs-panel-failed-count"
                className="font-mono text-xs font-medium tabular-nums text-rose-600 dark:text-rose-400"
              >
                {failedCount} failed
              </span>
            </>
          )}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleExportCsv}
          disabled={jobs.length === 0}
          data-testid="export-jobs-csv-btn"
          className="h-7 shrink-0 gap-1.5 whitespace-nowrap border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent"
        >
          <Download className="h-3 w-3 text-muted-foreground" />
          Export CSV
        </Button>
      </div>

      <div className="max-h-72 divide-y divide-border/60 overflow-y-auto">
        {jobs.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            No background jobs recorded yet.
          </p>
        )}
        {jobs.map((j) => {
          const isFailed = canAutoRetryJob(j);
          const isRetrying = Boolean(retryingMap[j.id]);
          const isAutoRetryChecked = Boolean(autoRetryMap[j.id] || isRetrying);
          const wasAutoRetried = isAutoRetriedJob(j);

          return (
            <div
              key={j.id}
              data-testid={`job-row-${j.id}`}
              className="flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-xs transition-colors hover:bg-accent/50 sm:flex-nowrap sm:gap-3 sm:px-5"
            >
              {isRetrying ? ICONS.RUNNING : (ICONS[j.status] ?? ICONS.QUEUED)}
              <span className="w-28 shrink-0 font-mono text-[11px] font-medium text-foreground">
                {j.type}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground" title={j.id}>
                {j.id.slice(0, 10)}
              </span>
              {j.createdAt && (
                <span
                  className="hidden font-mono text-[11px] tabular-nums text-muted-foreground sm:inline"
                  title={j.createdAt}
                >
                  {formatAuditTime(j.createdAt)}
                </span>
              )}

              {wasAutoRetried && j.status === 'DONE' && (
                <span
                  data-testid={`job-auto-retried-badge-${j.id}`}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                  title={`Recovered via Auto-Retry (Attempt #${j.attempts})`}
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  Auto-Retried #{j.attempts}
                </span>
              )}

              <div className="ml-auto flex items-center gap-3">
                {j.error && (
                  <span
                    className="max-w-44 truncate text-right font-mono text-[11px] text-rose-600 dark:text-rose-400"
                    title={j.error}
                  >
                    {j.error}
                  </span>
                )}

                {(isFailed || isRetrying) && (
                  <div
                    data-testid={`job-auto-retry-control-${j.id}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1"
                  >
                    <Switch
                      id={`auto-retry-switch-${j.id}`}
                      data-testid={`auto-retry-toggle-${j.id}`}
                      checked={isAutoRetryChecked}
                      disabled={isRetrying}
                      onCheckedChange={(checked) => void handleToggleAutoRetry(j, checked)}
                      aria-label={`Auto-Retry failed ${j.type} job ${j.id.slice(0, 8)}`}
                      className="scale-90"
                    />
                    <label
                      htmlFor={`auto-retry-switch-${j.id}`}
                      className="cursor-pointer select-none whitespace-nowrap font-mono text-[10px] font-medium text-foreground"
                    >
                      {isRetrying ? 'Retrying…' : 'Auto-Retry'}
                    </label>
                  </div>
                )}

                <span className="w-12 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {j.ms !== null ? `${j.ms}ms` : '—'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

