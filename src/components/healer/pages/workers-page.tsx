'use client';

import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useHealer } from '../store';
import { JobsPanel } from '../jobs-panel';
import { SystemHealth } from '../system-health';
import { WorkerLatencyChart } from '../worker-latency-chart';
import { PageHeader } from '../app-shell';
import type { CoreWorkerType } from '@/lib/healer/system-health';

export function WorkersPage() {
  const {
    loading,
    jobs,
    jobStats,
    alertConfig,
    connected,
    metrics,
    refreshJobs,
    triggerWorker,
    simulateWorkerFailure,
    retryJob,
    clearWorkerFailures,
    updateAlertConfig,
  } = useHealer();
  const [selectedWorker, setSelectedWorker] = useState<CoreWorkerType | 'ALL'>('ALL');

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-64 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const filteredJobs =
    selectedWorker === 'ALL'
      ? jobs
      : jobs.filter((j) => j.type === selectedWorker);

  return (
    <div className="space-y-5">
      <PageHeader />

      <SystemHealth
        jobs={jobs}
        jobStats={jobStats}
        connected={connected}
        alertConfig={alertConfig}
        onUpdateAlertConfig={updateAlertConfig}
        onSimulateFailure={simulateWorkerFailure}
        onClearFailures={clearWorkerFailures}
        selectedWorker={selectedWorker}
        onSelectWorker={setSelectedWorker}
        onTriggerWorker={triggerWorker}
        onRefresh={refreshJobs}
      />

      <WorkerLatencyChart
        jobs={jobs}
        selectedWorker={selectedWorker}
        onSelectWorker={setSelectedWorker}
      />

      <JobsPanel
        jobs={filteredJobs}
        breakers={metrics?.breakers ?? { open: 0, halfOpen: 0, closed: 0, list: [] }}
        onRetryJob={retryJob}
      />
    </div>
  );
}
