'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Plus, Terminal, GitPullRequest } from 'lucide-react';
import { useHealer } from '../store';
import { MetricsStrip } from '../metrics-strip';
import { EventStream } from '../event-stream';
import { EventInspector } from '../event-inspector';
import { SystemHealth } from '../system-health';
import { PageHeader } from '../app-shell';

export function HomePage() {
  const {
    loading,
    connected,
    events,
    selected,
    selectEvent,
    metrics,
    hotPatches,
    prs,
    jobs,
    jobStats,
    alertConfig,
    refreshJobs,
    triggerWorker,
    simulateWorkerFailure,
    clearWorkerFailures,
    updateAlertConfig,
    navigate,
    openConnect,
  } = useHealer();

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          <Skeleton className="h-[480px] rounded-lg" />
          <Skeleton className="h-[480px] rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate('playground')}
              className="h-8 gap-1.5 border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap shrink-0"
            >
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Workbench</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate('cold-path')}
              className="h-8 gap-1.5 border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap shrink-0"
            >
              <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Pull Requests ({prs.length})</span>
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={openConnect}
              className="h-8 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Register Endpoint</span>
            </Button>
          </div>
        }
      />

      {/* Real-time telemetry metrics */}
      <MetricsStrip metrics={metrics} hotCount={hotPatches.length} />

      {/* Live Request Stream & Inspector */}
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="min-w-0">
          <EventStream events={events} selectedId={selected?.eventId} onSelect={selectEvent} />
        </div>
        <div className="min-w-0">
          <EventInspector event={selected} />
        </div>
      </div>

      {/* Core Infrastructure Health */}
      <SystemHealth
        jobs={jobs}
        jobStats={jobStats}
        connected={connected}
        alertConfig={alertConfig}
        onUpdateAlertConfig={updateAlertConfig}
        onSimulateFailure={simulateWorkerFailure}
        onClearFailures={clearWorkerFailures}
        onTriggerWorker={triggerWorker}
        onRefresh={refreshJobs}
        onNavigateWorkers={() => navigate('workers')}
        compact
      />
    </div>
  );
}
