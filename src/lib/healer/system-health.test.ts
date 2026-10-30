import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutoRetryJobPayload,
  buildWorkerLatencyTrends24h,
  canAutoRetryJob,
  computeSystemHealth,
  CORE_WORKER_TYPES,
  DEFAULT_WORKER_ALERT_CONFIG,
  escapeCsvCell,
  evaluateWorkerAlerts,
  formatJobsCsv,
  isAutoRetriedJob,
  normalizeWorkerAlertConfig,
} from './system-health';
import { pageToPath, resolvePageFromUrl } from './route-utils';

test('computeSystemHealth returns all 4 core workers in STANDBY when empty', () => {
  const health = computeSystemHealth([], null);
  assert.equal(health.workers.length, 4);
  assert.deepEqual(
    health.workers.map((w) => w.type),
    [...CORE_WORKER_TYPES],
  );
  assert.equal(health.overallState, 'NOMINAL');
  assert.equal(health.healthyWorkerCount, 4);
  assert.equal(health.totalJobsProcessed, 0);
  for (const w of health.workers) {
    assert.equal(w.state, 'STANDBY');
    assert.equal(w.successRatePct, 100);
  }
});

test('computeSystemHealth marks workers HEALTHY and calculates avgMs and latencies', () => {
  const now = new Date().toISOString();
  const health = computeSystemHealth(
    [
      {
        id: 'j-2',
        type: 'METRICS',
        status: 'DONE',
        ms: 6,
        attempts: 1,
        error: null,
        createdAt: now,
      },
      {
        id: 'j-1',
        type: 'METRICS',
        status: 'DONE',
        ms: 4,
        attempts: 1,
        error: null,
        createdAt: now,
      },
      {
        id: 'j-3',
        type: 'CANARY',
        status: 'DONE',
        ms: 2,
        attempts: 1,
        error: null,
        createdAt: now,
      },
    ],
    {
      byType: [
        { type: 'METRICS', status: 'DONE', count: 12 },
        { type: 'CANARY', status: 'DONE', count: 3 },
      ],
    },
  );

  const metricsWorker = health.workers.find((w) => w.type === 'METRICS')!;
  assert.equal(metricsWorker.state, 'HEALTHY');
  assert.equal(metricsWorker.doneCount, 12);
  assert.equal(metricsWorker.avgMs, 5);
  assert.deepEqual(metricsWorker.recentLatencies, [4, 6]);

  const canaryWorker = health.workers.find((w) => w.type === 'CANARY')!;
  assert.equal(canaryWorker.state, 'HEALTHY');
  assert.equal(canaryWorker.doneCount, 3);
  assert.equal(health.totalJobsProcessed, 15);
});

test('computeSystemHealth transitions to RUNNING when jobs are QUEUED or RUNNING', () => {
  const health = computeSystemHealth([
    {
      id: 'j-run',
      type: 'PR_GENERATION',
      status: 'RUNNING',
      ms: null,
      attempts: 1,
      error: null,
      createdAt: new Date().toISOString(),
    },
  ]);

  const prWorker = health.workers.find((w) => w.type === 'PR_GENERATION')!;
  assert.equal(prWorker.state, 'RUNNING');
  assert.equal(health.overallState, 'ACTIVE');
  assert.equal(health.activeQueueDepth, 1);
});

test('computeSystemHealth transitions to DEGRADED when latest job failed', () => {
  const health = computeSystemHealth([
    {
      id: 'j-fail',
      type: 'TTL_SWEEP',
      status: 'FAILED',
      ms: 14,
      attempts: 2,
      error: 'SQLite busy timeout',
      createdAt: new Date().toISOString(),
    },
  ]);

  const ttlWorker = health.workers.find((w) => w.type === 'TTL_SWEEP')!;
  assert.equal(ttlWorker.state, 'DEGRADED');
  assert.equal(ttlWorker.lastError, 'SQLite busy timeout');
  assert.equal(health.overallState, 'DEGRADED');
  assert.equal(health.healthyWorkerCount, 3);
});

test('evaluateWorkerAlerts detects threshold breaches and deduplicates notified signatures', () => {
  const now = new Date().toISOString();
  const jobs = [
    {
      id: 'f-2',
      type: 'CANARY',
      status: 'FAILED',
      ms: 8,
      attempts: 1,
      error: '5-assertion canary rejected payload',
      createdAt: now,
    },
    {
      id: 'f-1',
      type: 'CANARY',
      status: 'FAILED',
      ms: 7,
      attempts: 1,
      error: 'sigma violation',
      createdAt: now,
    },
  ];
  const health = computeSystemHealth(jobs);
  const config = normalizeWorkerAlertConfig({
    ...DEFAULT_WORKER_ALERT_CONFIG,
    CANARY: { enabled: true, failureThreshold: 2 },
  });

  const firstEval = evaluateWorkerAlerts(health.workers, jobs, config);
  assert.equal(firstEval.activeBreaches.length, 1);
  assert.equal(firstEval.newBreaches.length, 1);
  assert.equal(firstEval.newBreaches[0].workerType, 'CANARY');
  assert.equal(firstEval.newBreaches[0].failedCount, 2);
  assert.equal(firstEval.newBreaches[0].consecutiveFailures, 2);

  // Second evaluation with notified signature should not re-emit newBreaches
  const notified = new Set([firstEval.newBreaches[0].signature]);
  const secondEval = evaluateWorkerAlerts(health.workers, jobs, config, notified);
  assert.equal(secondEval.activeBreaches.length, 1);
  assert.equal(secondEval.newBreaches.length, 0);

  // Disabled rule should produce 0 breaches
  const disabledConfig = normalizeWorkerAlertConfig({
    ...config,
    CANARY: { enabled: false, failureThreshold: 2 },
  });
  const disabledEval = evaluateWorkerAlerts(health.workers, jobs, disabledConfig);
  assert.equal(disabledEval.activeBreaches.length, 0);
});

test('buildWorkerLatencyTrends24h builds 24 hourly buckets and calculates 24h percentiles per worker', () => {
  const nowMs = Date.parse('2026-10-28T20:30:00.000Z');
  const jobs = [
    {
      id: 'm-1',
      type: 'METRICS',
      status: 'DONE',
      ms: 4,
      attempts: 1,
      error: null,
      createdAt: new Date(nowMs - 2 * 3600_000).toISOString(),
    },
    {
      id: 'm-2',
      type: 'METRICS',
      status: 'DONE',
      ms: 8,
      attempts: 1,
      error: null,
      createdAt: new Date(nowMs - 2 * 3600_000 + 10_000).toISOString(),
    },
    {
      id: 't-1',
      type: 'TTL_SWEEP',
      status: 'DONE',
      ms: 2,
      attempts: 1,
      error: null,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    },
    {
      id: 'old-1',
      type: 'METRICS',
      status: 'DONE',
      ms: 999,
      attempts: 1,
      error: null,
      // 30 hours ago -> outside 24h window, should be excluded
      createdAt: new Date(nowMs - 30 * 3600_000).toISOString(),
    },
  ];

  const trends = buildWorkerLatencyTrends24h(jobs, nowMs);
  assert.equal(trends.hourlyPoints.length, 24);
  assert.equal(trends.hourlyPoints[23].bucketLabel, 'Now');
  assert.equal(trends.hourlyPoints[23].TTL_SWEEP, 2);
  assert.equal(trends.hourlyPoints[21].METRICS, 6);
  assert.equal(trends.byWorker.METRICS.sampleCount, 2);
  assert.equal(trends.byWorker.METRICS.avgMs, 6);
  assert.equal(trends.byWorker.METRICS.peakMs, 8);
  assert.equal(trends.overall.sampleCount, 3);
  assert.ok(trends.adaptivePoints.length >= 6);
});

test('resolvePageFromUrl maps clean /[pagename] paths and canonicalizes legacy ?page= query strings', () => {
  assert.equal(pageToPath('home'), '/');
  assert.equal(pageToPath('workers'), '/workers');
  assert.equal(pageToPath('cold-path'), '/cold-path');

  const rootRoute = resolvePageFromUrl('/', '');
  assert.equal(rootRoute.page, 'home');
  assert.equal(rootRoute.canonicalPath, '/');
  assert.equal(rootRoute.needsCanonicalReplace, false);

  const workersRoute = resolvePageFromUrl('/workers', '');
  assert.equal(workersRoute.page, 'workers');
  assert.equal(workersRoute.canonicalPath, '/workers');
  assert.equal(workersRoute.needsCanonicalReplace, false);

  const legacyQueryRoute = resolvePageFromUrl('/', '?page=playground');
  assert.equal(legacyQueryRoute.page, 'playground');
  assert.equal(legacyQueryRoute.canonicalPath, '/playground');
  assert.equal(legacyQueryRoute.needsCanonicalReplace, true);
});

test('formatJobsCsv serializes job ledger into RFC 4180 CSV with proper escaping', () => {
  assert.equal(escapeCsvCell('simple'), 'simple');
  assert.equal(escapeCsvCell('has,comma'), '"has,comma"');
  assert.equal(escapeCsvCell('quote "here"'), '"quote ""here"""');

  const csv = formatJobsCsv([
    {
      id: 'job-001',
      type: 'CANARY',
      status: 'DONE',
      attempts: 1,
      ms: 4,
      createdAt: '2026-10-28T20:00:00.000Z',
      error: null,
      resultJson: '{"passed":true}',
    },
    {
      id: 'job-002',
      type: 'PR_GENERATION',
      status: 'FAILED',
      attempts: 2,
      ms: null,
      createdAt: '2026-10-28T20:01:00.000Z',
      error: 'GitHub API error, status 502 "Bad Gateway"',
      resultJson: null,
    },
  ]);

  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    'job_id,worker_type,status,attempts,latency_ms,created_at,error,result_json',
  );
  assert.equal(
    lines[1],
    'job-001,CANARY,DONE,1,4,2026-10-28T20:00:00.000Z,,"{""passed"":true}"',
  );
  assert.equal(
    lines[2],
    'job-002,PR_GENERATION,FAILED,2,,2026-10-28T20:01:00.000Z,"GitHub API error, status 502 ""Bad Gateway""",',
  );
});

test('Auto-Retry helpers validate failed job eligibility and enrich retry payloads', () => {
  assert.equal(canAutoRetryJob(null), false);
  assert.equal(canAutoRetryJob({ status: 'DONE' }), false);
  assert.equal(canAutoRetryJob({ status: 'RUNNING' }), false);
  assert.equal(canAutoRetryJob({ status: 'QUEUED' }), false);
  assert.equal(canAutoRetryJob({ status: 'FAILED' }), true);

  const retryPayload = buildAutoRetryJobPayload(
    JSON.stringify({ simulatedFault: true, contractId: 'c-1' }),
    2,
    '2026-10-28T21:00:00.000Z',
  );
  assert.deepEqual(retryPayload, {
    simulatedFault: true,
    contractId: 'c-1',
    autoRetry: true,
    transientRecovery: true,
    previousAttempts: 2,
    retriedAt: '2026-10-28T21:00:00.000Z',
  });

  // Malformed JSON falls back cleanly
  const fallbackPayload = buildAutoRetryJobPayload('not-json', 0, '2026-10-28T21:00:00.000Z');
  assert.equal(fallbackPayload.autoRetry, true);
  assert.equal(fallbackPayload.previousAttempts, 1);

  assert.equal(isAutoRetriedJob({ payloadJson: '{}', resultJson: '{}' }), false);
  assert.equal(
    isAutoRetriedJob({ payloadJson: JSON.stringify(retryPayload), resultJson: null }),
    true,
  );
  assert.equal(
    isAutoRetriedJob({ payloadJson: null, resultJson: JSON.stringify({ autoRetried: true }) }),
    true,
  );
});

