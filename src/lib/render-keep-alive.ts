/**
 * Render.com Web Service Keep-Alive & Anti-Sleep Service
 * ----------------------------------------------------
 * Render free tier spins down web services after 15 minutes of inactivity.
 * This service runs a lightweight background ping every 4 minutes (240 seconds)
 * targeting the public Render external URL (or local health endpoint)
 * keeping the service continuously awake and ready for sub-millisecond traffic.
 */

export interface PingRecord {
  timestamp: string;
  url: string;
  status: 'SUCCESS' | 'FAILED';
  statusCode?: number;
  durationMs: number;
  error?: string;
}

export interface KeepAliveState {
  enabled: boolean;
  intervalMs: number;
  targetUrl: string;
  resolvedUrl: string;
  lastPingAt: string | null;
  lastPingStatus: 'SUCCESS' | 'FAILED' | 'PENDING' | 'IDLE';
  lastPingLatencyMs: number | null;
  totalPings: number;
  successfulPings: number;
  failedPings: number;
  recentPings: PingRecord[];
}

const DEFAULT_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes = 240,000 ms

const globalForKeepAlive = globalThis as unknown as {
  __renderKeepAliveTimer?: NodeJS.Timeout;
  __renderKeepAliveState?: KeepAliveState;
};

function resolveEffectiveUrl(overrideUrl?: string): string {
  if (overrideUrl && overrideUrl.trim()) {
    let clean = overrideUrl.trim();
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = `https://${clean}`;
    }
    return clean.endsWith('/api/health') ? clean : `${clean.replace(/\/+$/, '')}/api/health`;
  }

  // Render automatically injects RENDER_EXTERNAL_URL in production environment
  const renderEnvUrl = process.env.RENDER_EXTERNAL_URL?.trim();
  if (renderEnvUrl) {
    const base = renderEnvUrl.startsWith('http') ? renderEnvUrl : `https://${renderEnvUrl}`;
    return `${base.replace(/\/+$/, '')}/api/health`;
  }

  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) {
    const base = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`;
    return `${base.replace(/\/+$/, '')}/api/health`;
  }

  // Local fallback for dev/container environments
  const port = process.env.PORT || '3000';
  return `http://127.0.0.1:${port}/api/health`;
}

function getInitialState(): KeepAliveState {
  const target = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '';
  return {
    enabled: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    targetUrl: target,
    resolvedUrl: resolveEffectiveUrl(target),
    lastPingAt: null,
    lastPingStatus: 'IDLE',
    lastPingLatencyMs: null,
    totalPings: 0,
    successfulPings: 0,
    failedPings: 0,
    recentPings: [],
  };
}

export function getKeepAliveState(): KeepAliveState {
  if (!globalForKeepAlive.__renderKeepAliveState) {
    globalForKeepAlive.__renderKeepAliveState = getInitialState();
  }
  return globalForKeepAlive.__renderKeepAliveState;
}

export async function executePing(): Promise<PingRecord> {
  const state = getKeepAliveState();
  const url = resolveEffectiveUrl(state.targetUrl);
  state.resolvedUrl = url;
  const t0 = performance.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Render-AntiSleep-Agent/1.0 (+https://render.com)',
        'Cache-Control': 'no-cache',
        'X-Keep-Alive-Ping': 'true',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const durationMs = Math.round(performance.now() - t0);
    const success = res.status >= 200 && res.status < 400;

    const record: PingRecord = {
      timestamp: new Date().toISOString(),
      url,
      status: success ? 'SUCCESS' : 'FAILED',
      statusCode: res.status,
      durationMs,
    };

    state.lastPingAt = record.timestamp;
    state.lastPingStatus = record.status;
    state.lastPingLatencyMs = durationMs;
    state.totalPings += 1;
    if (success) {
      state.successfulPings += 1;
    } else {
      state.failedPings += 1;
    }

    state.recentPings = [record, ...state.recentPings.slice(0, 19)];
    return record;
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    const record: PingRecord = {
      timestamp: new Date().toISOString(),
      url,
      status: 'FAILED',
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };

    state.lastPingAt = record.timestamp;
    state.lastPingStatus = 'FAILED';
    state.lastPingLatencyMs = durationMs;
    state.totalPings += 1;
    state.failedPings += 1;
    state.recentPings = [record, ...state.recentPings.slice(0, 19)];
    return record;
  }
}

export function updateKeepAliveConfig(options: {
  targetUrl?: string;
  enabled?: boolean;
}): KeepAliveState {
  const state = getKeepAliveState();
  if (options.targetUrl !== undefined) {
    state.targetUrl = options.targetUrl.trim();
    state.resolvedUrl = resolveEffectiveUrl(state.targetUrl);
  }
  if (options.enabled !== undefined) {
    state.enabled = options.enabled;
  }

  // Reset or re-arm timer if needed
  startKeepAliveTimer();
  return state;
}

export function startKeepAliveTimer(): void {
  if (globalForKeepAlive.__renderKeepAliveTimer) {
    clearInterval(globalForKeepAlive.__renderKeepAliveTimer);
    globalForKeepAlive.__renderKeepAliveTimer = undefined;
  }

  const state = getKeepAliveState();
  if (!state.enabled) return;

  // Run ping on every interval (default 4 minutes = 240,000ms)
  const timer = setInterval(() => {
    void executePing().catch((err) => {
      console.warn('[render keep-alive ping failed]', err);
    });
  }, state.intervalMs);

  // Allow node process to exit gracefully if needed
  timer.unref?.();
  globalForKeepAlive.__renderKeepAliveTimer = timer;

  console.log(
    `[render-keep-alive] Anti-sleep ping active: cadence=4m (240s) target=${state.resolvedUrl}`,
  );
}
