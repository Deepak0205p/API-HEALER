'use client';

/**
 * Shared UI types + status styling for the Command Center.
 * Engine types are imported type-only (zero runtime coupling client-side).
 */
import type { HealResult } from '@/lib/healer/types';
import type { Scenario } from '@/lib/healer/scenarios';

export type { HealResult };
export type ScenarioRow = Scenario;

export interface EventRow extends HealResult {
  eventId?: string;
  createdAt?: string;
  driftType?: string;
}

export interface ContractRow {
  id: string;
  name: string;
  endpoint: string;
  method: string;
  enabled: boolean;
  mandatory: string[];
  defaults: Record<string, unknown>;
  historySize: number;
  leaves: { path: string; mandatory: boolean; type: string; unit?: string }[];
  counts: { driftEvents: number; fingerprints: number; pullRequests: number };
  hotPatches: number;
  updatedAt: string;
}

export interface FingerprintRow {
  id: string;
  contractId: string;
  signature: string;
  planJson: string;
  opsSummary: string;
  hits: number;
  confidence: number;
  ttlAt: string;
  status: string;
  createdAt: string;
  contract?: { name: string };
}

export interface PrRow {
  id: string;
  number: number;
  title: string;
  branch: string;
  status: string;
  mode: string;
  url: string | null;
  diffText: string;
  canaryLogJson: string;
  createdAt: string;
  contract?: { name: string };
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  ms: number | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  payloadJson?: string | null;
  resultJson?: string | null;
}

export interface JobQueueStats {
  byStatus?: Record<string, number>;
  byType?: { type: string; status: string; count: number }[];
}

export interface MetricsData {
  totals: {
    events: number;
    passthrough: number;
    healedCold: number;
    healedCached: number;
    refused: number;
    rolledBack: number;
    errors: number;
  };
  repairRatePct: number;
  mttdMs: number;
  mtmMs: number;
  mttiMs: number;
  cacheHitRatePct: number;
  avgGatesMs: number;
  llmComposed: number;
  fingerprints: { active: number; expired: number; totalHits: number };
  prs: { open: number; github: number; dryRun: number };
  jobs: Record<string, number>;
  canaryPassed: number;
  canaryFailed: number;
  breakers: {
    open: number;
    halfOpen: number;
    closed: number;
    list: { contractId: string; state: string; failures: number; reason: string | null; cooldownRemainingMs: number }[];
  };
}

export interface HotPatchRow {
  signature: string;
  contractId: string;
  opsSummary: number;
  hits: number;
  ttlRemainingMs: number;
  composer: string;
  confidence: number;
}

export type NotificationCategory = 'ALERT' | 'SYSTEM' | 'SETUP' | 'DRIFT';
export type NotificationSeverity = 'CRITICAL' | 'WARNING' | 'INFO' | 'SUCCESS';

export interface NotificationRow {
  id: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  description: string;
  source: string;
  read: boolean;
  metadataJson?: string;
  createdAt: string;
}

export interface AuthUserInfo {
  uid: string;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
}

export const STATUS_STYLES: Record<
  string,
  { label: string; badge: string; dot: string }
> = {
  PASSTHROUGH: {
    label: 'PASSTHROUGH',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
  },
  HEALED_COLD: {
    label: 'HEALED · COLD',
    badge: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    dot: 'bg-cyan-500',
  },
  HEALED_CACHED: {
    label: 'HEALED · CACHED',
    badge: 'bg-teal-50 text-teal-700 border-teal-200',
    dot: 'bg-teal-500',
  },
  REFUSED: {
    label: 'REFUSED',
    badge: 'bg-rose-50 text-rose-700 border-rose-200',
    dot: 'bg-rose-500',
  },
  ROLLED_BACK: {
    label: 'ROLLED BACK',
    badge: 'bg-amber-50 text-amber-700 border-amber-200',
    dot: 'bg-amber-500',
  },
  ERROR: {
    label: 'ERROR',
    badge: 'bg-red-50 text-red-700 border-red-200',
    dot: 'bg-red-500',
  },
  FALLBACK_STALE: {
    label: 'FALLBACK · STALE',
    badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    dot: 'bg-indigo-500',
  },
  DEGRADED: {
    label: 'DEGRADED · 503',
    badge: 'bg-orange-50 text-orange-700 border-orange-200',
    dot: 'bg-orange-500',
  },
  OUTBOUND_ADAPTED: {
    label: 'OUTBOUND · ADAPTED',
    badge: 'bg-sky-50 text-sky-700 border-sky-200',
    dot: 'bg-sky-500',
  },
  AUTH_REFRESHED: {
    label: 'AUTH · REFRESHED',
    badge: 'bg-violet-50 text-violet-700 border-violet-200',
    dot: 'bg-violet-500',
  },
  ENDPOINT_REMAPPED: {
    label: 'ROUTE · REMAPPED',
    badge: 'bg-blue-50 text-blue-700 border-blue-200',
    dot: 'bg-blue-500',
  },
  METHOD_CORRECTED: {
    label: 'METHOD · CORRECTED',
    badge: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    dot: 'bg-cyan-500',
  },
  CONFLICT_RESOLVED: {
    label: 'CONFLICT · RESOLVED',
    badge: 'bg-teal-50 text-teal-700 border-teal-200',
    dot: 'bg-teal-500',
  },
  RETRIED_TRANSIENT: {
    label: 'RETRIED · RECOVERED',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
  },
};

export function statusStyle(status: string) {
  return STATUS_STYLES[status] ?? STATUS_STYLES.ERROR;
}
