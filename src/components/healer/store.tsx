'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { toast } from 'sonner';
import { auth, googleProvider } from '@/lib/firebase';
import { recordAuditLog } from '@/lib/audit';
import { useHealerBus } from '@/hooks/use-healer-bus';
import { ConnectModal } from '@/components/healer/connect-modal';
import type {
  AuthUserInfo,
  ContractRow,
  EventRow,
  FingerprintRow,
  HotPatchRow,
  JobQueueStats,
  JobRow,
  MetricsData,
  NotificationCategory,
  NotificationRow,
  NotificationSeverity,
  PrRow,
} from '@/components/healer/ui-types';
import {
  computeSystemHealth,
  DEFAULT_WORKER_ALERT_CONFIG,
  evaluateWorkerAlerts,
  normalizeWorkerAlertConfig,
  type CoreWorkerType,
  type WorkerAlertConfig,
} from '@/lib/healer/system-health';
import {
  PAGES,
  pageToPath,
  resolvePageFromUrl,
  type PageId,
} from '@/lib/healer/route-utils';
import { resilientClientFetch } from '@/lib/healer/http-resilience';

export { PAGES, pageToPath, type PageId };

const ALERT_STORAGE_KEY = 'healer:worker-alert-config';
const THEME_STORAGE_KEY = 'healer:theme';

export type ThemeMode = 'light' | 'dark';

export const PAGE_META: Record<
  PageId,
  { title: string; shortTitle: string; subtitle: string; section: string; path: string }
> = {
  home: {
    title: 'Runtime Control Plane',
    shortTitle: 'Overview',
    subtitle:
      'Sub-millisecond Loop-1 payload sanitization, 3-Gate statistical anomaly vetoes, and live worker telemetry.',
    section: 'Operations',
    path: '/',
  },
  playground: {
    title: 'Resilience & Swarm Workbench',
    shortTitle: 'Playground',
    subtitle:
      'Simulate visible HTTP 4xx/5xx faults, silent 200 OK crash traps, and schema drift to verify Loop-1 shielding and Loop-2 Multi-Agent PR synthesis.',
    section: 'Operations',
    path: '/playground',
  },
  'cold-path': {
    title: 'Cold Path & Pull Requests',
    shortTitle: 'Cold Path',
    subtitle:
      'Inspect active 24h hot-patch bridges, durable schema fingerprints, and atomic multi-file GitHub pull requests.',
    section: 'Operations',
    path: '/cold-path',
  },
  contracts: {
    title: 'Endpoint Contracts',
    shortTitle: 'Contracts',
    subtitle:
      'Manage registered API endpoint schemas, mandatory GSTN/compliance fields, and statistical baseline histories.',
    section: 'Governance',
    path: '/contracts',
  },
  workers: {
    title: 'Background Workers & Latency',
    shortTitle: 'Workers',
    subtitle:
      'Monitor Canary verification, PR generation, TTL sweepers, and 24-hour percentile latency trends.',
    section: 'Governance',
    path: '/workers',
  },
  integrate: {
    title: 'SDK & Gateway Integration',
    shortTitle: 'Integration',
    subtitle:
      'Connect upstream endpoints in one click, download the pre-configured TypeScript interceptor, and manage keep-alive probes.',
    section: 'Governance',
    path: '/integrate',
  },
  audit: {
    title: 'Immutable Audit Trail',
    shortTitle: 'Audit Log',
    subtitle:
      'Real-time cryptographic ledger of operator actions, worker retries, and threshold policy updates.',
    section: 'Governance',
    path: '/audit',
  },
};

const ROUTE_EVENT = 'healer:route';

function parseBrowserRoute(): PageId {
  if (typeof window === 'undefined') return 'home';
  return resolvePageFromUrl(window.location.pathname, window.location.search).page;
}

function subscribeRoute(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(ROUTE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(ROUTE_EVENT, onChange);
  };
}

function useRoute(initialPage: PageId = 'home'): PageId {
  return useSyncExternalStore(subscribeRoute, parseBrowserRoute, () => initialPage);
}

interface HealerStore {
  page: PageId;
  navigate: (page: PageId) => void;
  theme: ThemeMode;
  toggleTheme: () => void;
  loading: boolean;
  connected: boolean;
  events: EventRow[];
  selected: EventRow | null;
  selectEvent: (e: EventRow) => void;
  metrics: MetricsData | null;
  hotPatches: HotPatchRow[];
  fingerprints: FingerprintRow[];
  prs: PrRow[];
  jobs: JobRow[];
  jobStats: JobQueueStats | null;
  alertConfig: WorkerAlertConfig;
  contracts: ContractRow[];
  notifications: NotificationRow[];
  unreadNotificationsCount: number;
  addNotification: (params: {
    category: NotificationCategory;
    severity: NotificationSeverity;
    title: string;
    description?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  clearNotifications: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  authUser: AuthUserInfo | null;
  authToken: string | null;
  authBusy: boolean;
  authLoading: boolean;
  authModalOpen: boolean;
  setAuthModalOpen: (open: boolean) => void;
  authModalMode: 'signin' | 'signup';
  setAuthModalMode: (mode: 'signin' | 'signup') => void;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, pass: string) => Promise<boolean>;
  signUpWithEmail: (email: string, pass: string, name?: string) => Promise<boolean>;
  instantDemoLogin: () => Promise<boolean>;
  signOutUser: () => Promise<void>;
  allowLlm: boolean;
  setAllowLlm: (v: boolean) => void;
  refreshMetrics: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  refreshFingerprints: () => Promise<void>;
  refreshPrs: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  triggerWorker: (type: 'TTL_SWEEP' | 'METRICS') => Promise<void>;
  simulateWorkerFailure: (type: CoreWorkerType, errorReason?: string) => Promise<void>;
  retryJob: (jobId: string, autoRetry?: boolean) => Promise<boolean>;
  clearWorkerFailures: (type?: CoreWorkerType) => Promise<void>;
  updateAlertConfig: (next: WorkerAlertConfig) => void;
  refreshContracts: () => Promise<void>;
  resetAll: () => Promise<void>;
  revokeFingerprint: (id: string) => Promise<void>;
  openConnect: () => void;
  hasContracts: boolean;
}

const Ctx = createContext<HealerStore | null>(null);

export function useHealer(): HealerStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHealer must be used inside <HealerProvider>');
  return v;
}

export function HealerProvider({
  children,
  initialPage = 'home',
}: {
  children: ReactNode;
  initialPage?: PageId;
}) {
  const page = useRoute(initialPage);

  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    if (document.documentElement.classList.contains('dark')) return 'dark';
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // ignore storage errors
    }
    return 'light';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isDark = theme === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const resolved = resolvePageFromUrl(window.location.pathname, window.location.search);
    if (resolved.needsCanonicalReplace) {
      window.history.replaceState(null, '', resolved.canonicalPath);
      window.dispatchEvent(new Event(ROUTE_EVENT));
    }
  }, []);

  const navigate = useCallback((next: PageId) => {
    const targetPath = pageToPath(next);
    if (window.location.pathname !== targetPath || window.location.search !== '') {
      window.history.pushState(null, '', targetPath);
    }
    window.dispatchEvent(new Event(ROUTE_EVENT));
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [hotPatches, setHotPatches] = useState<HotPatchRow[]>([]);
  const [fingerprints, setFingerprints] = useState<FingerprintRow[]>([]);
  const [prs, setPrs] = useState<PrRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobStats, setJobStats] = useState<JobQueueStats | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [authUser, setAuthUser] = useState<AuthUserInfo | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<'signin' | 'signup'>('signin');

  const [alertConfig, setAlertConfig] = useState<WorkerAlertConfig>(() => {
    if (typeof window === 'undefined') return DEFAULT_WORKER_ALERT_CONFIG;
    try {
      const saved = window.localStorage.getItem(ALERT_STORAGE_KEY);
      if (saved) {
        return normalizeWorkerAlertConfig(JSON.parse(saved));
      }
    } catch {
      // ignore storage errors
    }
    return DEFAULT_WORKER_ALERT_CONFIG;
  });
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [allowLlm, setAllowLlm] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const eventsEndRef = useRef(false);
  const notifiedAlertSignaturesRef = useRef<Set<string>>(new Set());

  // Firebase Auth listener + Cloud SQL PostgreSQL user sync (token in memory only)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthLoading(false);
      if (!user) {
        setAuthUser(null);
        setAuthToken(null);
        return;
      }
      try {
        const token = await user.getIdToken();
        setAuthToken(token);
        setAuthUser({
          uid: user.uid,
          email: user.email ?? '',
          displayName: user.displayName,
          photoURL: user.photoURL,
        });
        const syncRes = await resilientClientFetch(
          '/api/auth/sync',
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
            },
          },
          {
            maxRetries: 1,
            onUnauthorized: async () => {
              const refreshed = await user.getIdToken(true);
              setAuthToken(refreshed);
              return refreshed;
            },
          },
        );
        void syncRes;
      } catch {
        // non-blocking auth sync
      }
    });
    return () => unsub();
  }, []);

  const refreshNotifications = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/notifications?limit=80', undefined, { maxRetries: 1 });
      if (!r.ok) return;
      const d = (await r.json()) as { notifications?: NotificationRow[] };
      if (Array.isArray(d.notifications)) {
        setNotifications(
          d.notifications.map((n) => ({
            ...n,
            createdAt: typeof n.createdAt === 'string' ? n.createdAt : new Date(n.createdAt).toISOString(),
          })),
        );
      }
    } catch {
      // ignore fetch errors
    }
  }, []);

  const addNotification = useCallback(
    async (params: {
      category: NotificationCategory;
      severity: NotificationSeverity;
      title: string;
      description?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    }) => {
      const optimistic: NotificationRow = {
        id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        category: params.category,
        severity: params.severity,
        title: params.title,
        description: params.description ?? '',
        source: params.source ?? 'runtime',
        read: false,
        metadataJson: JSON.stringify(params.metadata ?? {}),
        createdAt: new Date().toISOString(),
      };
      setNotifications((prev) => [optimistic, ...prev].slice(0, 100));
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: optimistic.id,
            category: params.category,
            severity: params.severity,
            title: params.title,
            description: params.description ?? '',
            source: params.source ?? 'runtime',
            metadata: params.metadata ?? {},
          }),
        });
      } catch {
        // optimistic notification remains in memory
      }
    },
    [],
  );

  const markNotificationRead = useCallback(async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      // ignore
    }
  }, []);

  const markAllNotificationsRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markAllRead: true }),
      });
    } catch {
      // ignore
    }
  }, []);

  const clearNotifications = useCallback(async () => {
    setNotifications([]);
    try {
      await fetch('/api/notifications', { method: 'DELETE' });
    } catch {
      // ignore
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthBusy(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const token = await cred.user.getIdToken();
      setAuthToken(token);
      setAuthUser({
        uid: cred.user.uid,
        email: cred.user.email ?? '',
        displayName: cred.user.displayName,
        photoURL: cred.user.photoURL,
      });
      await resilientClientFetch(
        '/api/auth/sync',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        },
        {
          maxRetries: 1,
          onUnauthorized: async () => {
            const refreshed = await cred.user.getIdToken(true);
            setAuthToken(refreshed);
            return refreshed;
          },
        },
      );
      toast.success(`Signed in as ${cred.user.email ?? cred.user.displayName ?? 'User'}`);
      void addNotification({
        category: 'SYSTEM',
        severity: 'SUCCESS',
        title: 'Authenticated with Google',
        description: `User profile ${cred.user.email ?? cred.user.uid} synced to Cloud SQL PostgreSQL.`,
        source: 'firebase-auth',
      });
      setAuthModalOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Google Sign-In failed');
    } finally {
      setAuthBusy(false);
    }
  }, [addNotification]);

  const signInWithEmail = useCallback(
    async (email: string, pass: string): Promise<boolean> => {
      setAuthBusy(true);
      try {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), pass);
        const token = await cred.user.getIdToken();
        setAuthToken(token);
        setAuthUser({
          uid: cred.user.uid,
          email: cred.user.email ?? '',
          displayName: cred.user.displayName,
          photoURL: cred.user.photoURL,
        });
        await resilientClientFetch('/api/auth/sync', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        toast.success(`Signed in as ${cred.user.email}!`);
        void addNotification({
          category: 'SYSTEM',
          severity: 'SUCCESS',
          title: 'Email Sign-In Verified',
          description: `User ${cred.user.email} synced to Cloud SQL PostgreSQL.`,
          source: 'firebase-auth',
        });
        setAuthModalOpen(false);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Email Sign-In failed');
        return false;
      } finally {
        setAuthBusy(false);
      }
    },
    [addNotification],
  );

  const signUpWithEmail = useCallback(
    async (email: string, pass: string, name?: string): Promise<boolean> => {
      setAuthBusy(true);
      try {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), pass);
        if (name?.trim()) {
          try {
            await updateProfile(cred.user, { displayName: name.trim() });
          } catch {
            // non-fatal
          }
        }
        const token = await cred.user.getIdToken();
        setAuthToken(token);
        setAuthUser({
          uid: cred.user.uid,
          email: cred.user.email ?? '',
          displayName: name?.trim() || cred.user.displayName,
          photoURL: cred.user.photoURL,
        });
        await resilientClientFetch('/api/auth/sync', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        toast.success(`Account created successfully!`);
        void addNotification({
          category: 'SYSTEM',
          severity: 'SUCCESS',
          title: 'New Account Created',
          description: `User ${cred.user.email} provisioned in Cloud SQL PostgreSQL.`,
          source: 'firebase-auth',
        });
        setAuthModalOpen(false);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Registration failed');
        return false;
      } finally {
        setAuthBusy(false);
      }
    },
    [addNotification],
  );

  const instantDemoLogin = useCallback(async (): Promise<boolean> => {
    setAuthBusy(true);
    try {
      const demoToken = `demo_judge_token_${Date.now()}`;
      const demoUser: AuthUserInfo = {
        uid: 'demo_judge_uid',
        email: 'judge.demo@apihealer.internal',
        displayName: 'Hackathon Judge Demo',
        photoURL: null,
      };
      setAuthToken(demoToken);
      setAuthUser(demoUser);
      await resilientClientFetch('/api/auth/sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${demoToken}` },
      });
      toast.success('Signed in as Hackathon Judge Demo!');
      void addNotification({
        category: 'SYSTEM',
        severity: 'SUCCESS',
        title: 'Judge Demo Session Active',
        description: 'Profile recorded in Cloud SQL PostgreSQL.',
        source: 'demo-auth',
      });
      setAuthModalOpen(false);
      return true;
    } catch {
      toast.error('Instant Demo login failed');
      return false;
    } finally {
      setAuthBusy(false);
    }
  }, [addNotification]);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
    setAuthUser(null);
    setAuthToken(null);
    toast.info('Signed out');
  }, []);

  const refreshMetrics = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/metrics', undefined, { maxRetries: 2 });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.metrics) setMetrics(d.metrics);
      if (Array.isArray(d?.hotPatches)) setHotPatches(d.hotPatches);
    } catch {
      // keep previous metrics on transient error
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/events?limit=50', undefined, { maxRetries: 2 });
      if (!r.ok) return;
      const d = await r.json();
      const rows = (d.events ?? []).map((e: Record<string, unknown>) => mapDbEvent(e));
      setEvents(rows);
      setSelected((sel) => {
        if (rows.length === 0) return null;
        return sel && rows.some((row: EventRow) => row.eventId === sel.eventId) ? sel : rows[0];
      });
    } catch {
      // keep existing events on transient error
    }
  }, []);

  const refreshFingerprints = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/fingerprints', undefined, { maxRetries: 2 });
      if (!r.ok) return;
      const d = await r.json();
      setFingerprints(d.fingerprints ?? []);
    } catch {
      // keep existing fingerprints on transient error
    }
  }, []);

  const refreshPrs = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/prs', undefined, { maxRetries: 2 });
      if (!r.ok) return;
      const d = await r.json();
      setPrs(d.prs ?? []);
    } catch {
      // keep existing PRs on transient error
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/jobs?limit=150', undefined, { maxRetries: 2 });
      if (!r.ok) return;
      const d = await r.json();
      setJobs(d.recent ?? []);
      setJobStats(d.stats ?? null);
    } catch {
      // keep existing jobs on transient error
    }
  }, []);

  const refreshContracts = useCallback(async () => {
    try {
      const r = await resilientClientFetch('/api/contracts', undefined, { maxRetries: 2 });
      if (!r.ok) return;
      const d = await r.json();
      setContracts(d.contracts ?? []);
    } catch {
      // keep existing contracts on transient error
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refreshContracts();
        await Promise.all([
          refreshMetrics(),
          refreshEvents(),
          refreshFingerprints(),
          refreshPrs(),
          refreshJobs(),
          refreshNotifications(),
        ]);
      } finally {
        setLoading(false);
      }
    })();
  }, [
    refreshContracts,
    refreshMetrics,
    refreshEvents,
    refreshFingerprints,
    refreshPrs,
    refreshJobs,
    refreshNotifications,
  ]);

  const jobRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFrame = useCallback(
    ({ channel, data }: { channel: string; data: unknown }) => {
      if (channel === 'heal:event') {
        const ev = mapHealResult(data as Record<string, unknown>);
        setEvents((prev) => [ev, ...prev].slice(0, 80));
        setSelected((sel) => (sel === null || eventsEndRef.current ? ev : sel));
        if (ev.status === 'REFUSED' || ev.status === 'ROLLED_BACK') {
          void addNotification({
            category: 'ALERT',
            severity: ev.status === 'REFUSED' ? 'CRITICAL' : 'WARNING',
            title: `${ev.status}: ${ev.contractName}`,
            description: ev.message || `Drift (${ev.driftType}) triggered ${ev.status} on ${ev.endpoint}`,
            source: 'hot-path-gate',
          });
        } else if (ev.status === 'HEALED_COLD') {
          void addNotification({
            category: 'DRIFT',
            severity: 'INFO',
            title: `Novel Drift Healed: ${ev.contractName}`,
            description: `${ev.driftType} drift healed cold in ${ev.timing.totalMs.toFixed(1)}ms.`,
            source: 'hot-path',
          });
        }
        void refreshMetrics();
        void refreshFingerprints();
      } else if (channel === 'heal:canary') {
        const d = data as { eventId?: string; passed: boolean; signature?: string };
        if (d.eventId) {
          setEvents((prev) =>
            prev.map((e): EventRow => (e.eventId === d.eventId ? { ...e, canaryPassed: d.passed } : e)),
          );
          setSelected((sel) =>
            sel && sel.eventId === d.eventId ? { ...sel, canaryPassed: d.passed } : sel,
          );
        }
        if (!d.passed) {
          void addNotification({
            category: 'ALERT',
            severity: 'CRITICAL',
            title: 'Canary Verification Failed',
            description: `Hot patch revoked for signature ${String(d.signature ?? '').slice(0, 10)}.`,
            source: 'canary-worker',
          });
        }
        void refreshMetrics();
      } else if (channel === 'heal:pr') {
        void refreshPrs();
        void refreshMetrics();
        const d = data as { number: number; title: string; mode: string };
        toast.info(`PR #${d.number} raised (${d.mode})`, { description: d.title });
        void addNotification({
          category: 'SYSTEM',
          severity: 'SUCCESS',
          title: `Remediation PR #${d.number} Created (${d.mode})`,
          description: d.title,
          source: 'cold-path-pr',
        });
      } else if (channel === 'heal:alert') {
        const d = data as { kind?: string; message?: string; url?: string };
        void addNotification({
          category: 'ALERT',
          severity: 'WARNING',
          title: `Upstream Alert · ${d.kind ?? 'DEGRADED'}`,
          description: d.message ?? `Attention required on ${d.url ?? 'upstream'}`,
          source: 'alert-worker',
        });
      } else if (channel === 'heal:metrics') {
        setMetrics(data as MetricsData);
      } else if (channel === 'jobs:update') {
        if (jobRefreshTimer.current) clearTimeout(jobRefreshTimer.current);
        jobRefreshTimer.current = setTimeout(() => void refreshJobs(), 400);
      }
    },
    [refreshMetrics, refreshFingerprints, refreshPrs, refreshJobs, addNotification],
  );
  const { connected } = useHealerBus(onFrame);

  useEffect(() => {
    if (connected) return;
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refreshMetrics();
      void refreshEvents();
      void refreshJobs();
    }, 1000);
    return () => clearInterval(interval);
  }, [connected, refreshMetrics, refreshEvents, refreshJobs]);

  const selectEvent = useCallback((e: EventRow) => {
    eventsEndRef.current = true;
    setSelected(e);
    setTimeout(() => {
      eventsEndRef.current = false;
    }, 15000);
  }, []);

  const resetAll = useCallback(async () => {
    await fetch('/api/reset', { method: 'POST' });
    await Promise.all([refreshEvents(), refreshMetrics(), refreshFingerprints(), refreshPrs(), refreshJobs()]);
    setSelected(null);
    toast.success('Runtime state reset');
    void addNotification({
      category: 'SYSTEM',
      severity: 'INFO',
      title: 'Runtime State Reset',
      description: 'Events, fingerprints, PRs, and job ledger cleared by operator.',
      source: 'system-control',
    });
  }, [refreshEvents, refreshMetrics, refreshFingerprints, refreshPrs, refreshJobs, addNotification]);

  const revokeFingerprint = useCallback(
    async (id: string) => {
      await fetch(`/api/fingerprints?id=${id}`, { method: 'DELETE' });
      void refreshFingerprints();
      void refreshMetrics();
      toast.success('Fingerprint revoked');
      void addNotification({
        category: 'SYSTEM',
        severity: 'WARNING',
        title: 'Fingerprint Revoked',
        description: `Hot plan fingerprint ${id.slice(0, 12)} manually revoked by operator.`,
        source: 'memory-tier',
      });
      void recordAuditLog({
        action: 'REVOKE_FINGERPRINT',
        category: 'SYSTEM_ACTION',
        target: `fingerprint:${id.slice(0, 16)}`,
        status: 'SUCCESS',
        details: `Operator revoked hot plan fingerprint ${id.slice(0, 16)}. In-memory hot route evicted.`,
        performedByUid: authUser?.uid,
        performedByEmail: authUser?.email,
      }).catch(() => undefined);
    },
    [refreshFingerprints, refreshMetrics, addNotification, authUser],
  );

  const triggerWorker = useCallback(
    async (type: 'TTL_SWEEP' | 'METRICS') => {
      const r = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      if (!r.ok) {
        toast.error(`Failed to trigger ${type}`);
        return;
      }
      const d = await r.json();
      setJobs(d.recent ?? []);
      setJobStats(d.stats ?? null);
      void refreshMetrics();
      toast.success(`${type} worker cycle completed`);
      void addNotification({
        category: 'SYSTEM',
        severity: 'INFO',
        title: `${type} Worker Cycle Completed`,
        description: `On-demand ${type} background worker finished execution.`,
        source: 'worker-queue',
      });
    },
    [refreshMetrics, addNotification],
  );

  useEffect(() => {
    if (loading) return;
    const overview = computeSystemHealth(jobs, jobStats);
    const { newBreaches } = evaluateWorkerAlerts(
      overview.workers,
      jobs,
      alertConfig,
      notifiedAlertSignaturesRef.current,
    );
    for (const breach of newBreaches) {
      notifiedAlertSignaturesRef.current.add(breach.signature);
      toast.error(breach.headline, {
        description: breach.description,
        duration: 6000,
      });
      void addNotification({
        category: 'ALERT',
        severity: breach.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        title: breach.headline,
        description: breach.description,
        source: `worker:${breach.workerType.toLowerCase()}`,
      });
    }
  }, [loading, jobs, jobStats, alertConfig, addNotification]);

  const updateAlertConfig = useCallback(
    (next: WorkerAlertConfig) => {
      const normalized = normalizeWorkerAlertConfig(next);
      notifiedAlertSignaturesRef.current.clear();
      setAlertConfig(normalized);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(normalized));
        } catch {
          // ignore storage errors
        }
      }
      toast.success('Worker failure alert thresholds saved');
      void addNotification({
        category: 'SYSTEM',
        severity: 'INFO',
        title: 'Worker Alert Thresholds Updated',
        description: `Warning threshold=${normalized.warningFailureThreshold}, Critical threshold=${normalized.criticalFailureThreshold}.`,
        source: 'alert-config',
      });
      void recordAuditLog({
        action: 'UPDATE_CONFIG',
        category: 'CONFIG_CHANGE',
        target: 'config:worker_alerts',
        status: 'SUCCESS',
        details: `Updated worker alert thresholds: Warning=${normalized.warningFailureThreshold}, Critical=${normalized.criticalFailureThreshold}.`,
        performedByUid: authUser?.uid,
        performedByEmail: authUser?.email,
        metadata: {
          warningThreshold: normalized.warningFailureThreshold,
          criticalThreshold: normalized.criticalFailureThreshold,
        },
      }).catch(() => undefined);
    },
    [addNotification, authUser],
  );

  const simulateWorkerFailure = useCallback(
    async (type: CoreWorkerType, errorReason?: string) => {
      const r = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          simulateFailure: true,
          errorReason,
        }),
      });
      if (!r.ok) {
        toast.error(`Failed to simulate ${type} fault`);
        return;
      }
      const d = await r.json();
      setJobs(d.recent ?? []);
      setJobStats(d.stats ?? null);
      void refreshMetrics();
    },
    [refreshMetrics],
  );

  const retryJob = useCallback(
    async (jobId: string, autoRetry = true): Promise<boolean> => {
      try {
        const r = await fetch('/api/jobs', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId, autoRetry }),
        });
        if (!r.ok) {
          toast.error('Failed to queue Auto-Retry attempt');
          return false;
        }
        const d = await r.json();
        setJobs(d.recent ?? []);
        setJobStats(d.stats ?? null);
        void refreshMetrics();
        void refreshNotifications();

        const updatedStatus = d.job?.status ?? 'DONE';
        const jobType = d.job?.type ?? 'Worker';
        if (updatedStatus === 'DONE') {
          toast.success(`Auto-Retry recovered ${jobType} job`, {
            description: `Job ${jobId.slice(0, 8)} completed on attempt #${d.job?.attempts ?? 1}`,
          });
        } else {
          toast.info(`Auto-Retry queued for ${jobType} job ${jobId.slice(0, 8)}`);
        }
        return true;
      } catch {
        toast.error('Failed to execute Auto-Retry');
        return false;
      }
    },
    [refreshMetrics, refreshNotifications],
  );

  const clearWorkerFailures = useCallback(
    async (type?: CoreWorkerType) => {
      const qs = type ? `?type=${encodeURIComponent(type)}` : '';
      const r = await fetch(`/api/jobs${qs}`, { method: 'DELETE' });
      if (!r.ok) {
        toast.error('Failed to clear worker failures');
        return;
      }
      const d = await r.json();
      notifiedAlertSignaturesRef.current.clear();
      setJobs(d.recent ?? []);
      setJobStats(d.stats ?? null);
      void refreshMetrics();
      toast.success(
        type ? `Cleared ${type} failure history` : 'Cleared all worker failure history',
      );
      void addNotification({
        category: 'SYSTEM',
        severity: 'SUCCESS',
        title: type ? `Cleared ${type} Worker Failures` : 'Cleared All Worker Failures',
        description: 'Worker failure counters and alert triggers reset.',
        source: 'worker-queue',
      });
    },
    [refreshMetrics, addNotification],
  );

  const openConnect = useCallback(() => setConnectOpen(true), []);

  const hasContracts = contracts.length > 0;
  const unreadNotificationsCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const value: HealerStore = {
    page,
    navigate,
    theme,
    toggleTheme,
    loading,
    connected,
    events,
    selected,
    selectEvent,
    metrics,
    hotPatches,
    fingerprints,
    prs,
    jobs,
    jobStats,
    alertConfig,
    contracts,
    notifications,
    unreadNotificationsCount,
    addNotification,
    markNotificationRead,
    markAllNotificationsRead,
    clearNotifications,
    refreshNotifications,
    authUser,
    authToken,
    authBusy,
    authLoading,
    authModalOpen,
    setAuthModalOpen,
    authModalMode,
    setAuthModalMode,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    instantDemoLogin,
    signOutUser,
    allowLlm,
    setAllowLlm,
    refreshMetrics,
    refreshEvents,
    refreshFingerprints,
    refreshPrs,
    refreshJobs,
    triggerWorker,
    simulateWorkerFailure,
    retryJob,
    clearWorkerFailures,
    updateAlertConfig,
    refreshContracts,
    resetAll,
    revokeFingerprint,
    openConnect,
    hasContracts,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <ConnectModal
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onCreated={() => {
          void refreshContracts();
          void refreshNotifications();
          void refreshEvents();
          void refreshMetrics();
        }}
      />
    </Ctx.Provider>
  );
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export function mapDbEvent(e: Record<string, unknown>): EventRow {
  const timing = {
    classifyMs: Number(e.classifyMs ?? 0),
    composeMs: Number(e.composeMs ?? 0),
    gatesMs: Number(e.gatesMs ?? 0),
    totalMs: Number(e.totalMs ?? 0),
  };
  return {
    status: String(e.status) as EventRow['status'],
    contractId: String(e.contractId),
    contractName: (e.contract as { name?: string } | undefined)?.name ?? '—',
    endpoint: (e.contract as { endpoint?: string } | undefined)?.endpoint ?? '',
    servedPayload: e.healedPayloadJson ? safeJsonParse(e.healedPayloadJson, null) : null,
    rawPayload: safeJsonParse(e.rawPayloadJson ?? '{}', {}),
    plan: e.planJson ? safeJsonParse(e.planJson, null) : null,
    classification: e.classificationJson ? safeJsonParse(e.classificationJson, null) : null,
    gates: e.gatesJson ? safeJsonParse(e.gatesJson, null) : null,
    signature: String(e.signature ?? ''),
    timing,
    driftType: String(e.driftType ?? 'NONE'),
    composer: String(e.composer ?? 'none') as EventRow['composer'],
    confidence: Number(e.confidence ?? 0),
    canaryPassed: (e.canaryPassed as boolean | null | undefined) ?? null,
    callsite: (e.callsite as string | null) ?? null,
    jobsQueued: [],
    message: '',
    eventId: String(e.id),
    createdAt: String(e.createdAt ?? ''),
  };
}

export function mapHealResult(d: Record<string, unknown>): EventRow {
  return {
    status: String(d.status) as EventRow['status'],
    contractId: String(d.contractId ?? ''),
    contractName: String(d.contractName ?? '—'),
    endpoint: String(d.endpoint ?? ''),
    servedPayload: (d.servedPayload as Record<string, unknown> | null) ?? null,
    rawPayload: (d.rawPayload as Record<string, unknown>) ?? {},
    plan: (d.plan as EventRow['plan']) ?? null,
    classification: (d.classification as EventRow['classification']) ?? null,
    gates: (d.gates as EventRow['gates']) ?? null,
    signature: String(d.signature ?? ''),
    timing: (d.timing as EventRow['timing']) ?? {
      classifyMs: 0,
      composeMs: 0,
      gatesMs: 0,
      totalMs: 0,
    },
    driftType: String(
      (d.classification as { driftType?: string } | undefined)?.driftType ?? 'NONE',
    ),
    composer: String(d.composer ?? 'none') as EventRow['composer'],
    confidence: Number(d.confidence ?? 0),
    canaryPassed: (d.canaryPassed as boolean | null | undefined) ?? null,
    callsite: (d.callsite as string | null) ?? null,
    jobsQueued: (d.jobsQueued as string[]) ?? [],
    message: String(d.message ?? ''),
    eventId: d.eventId ? String(d.eventId) : `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
}
