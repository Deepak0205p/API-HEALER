import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

function buildPreconfiguredSdk(origin: string, contractId: string, endpoint: string): string {
  return `/**
 * ─────────────────────────────────────────────────────────────────────────────
 * API-HEALER · Pre-Configured 1-Click SDK Client
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-bound to:
 *   Server      : ${origin}
 *   Contract ID : ${contractId}
 *   Endpoint    : ${endpoint}
 *
 * 1-Line Auto-Setup (intercepts matching global fetch calls automatically):
 *   import { enableAutoHeal } from './api-healer-client';
 *   enableAutoHeal();
 *
 * Or wrap specific calls:
 *   import { healerFetch, healPayload } from './api-healer-client';
 *   const res = await healerFetch('${endpoint}', { method: 'POST', body: JSON.stringify(data) });
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface HealerClientConfig {
  server: string;
  defaultContractId?: string;
  defaultEndpoint?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

let config: HealerClientConfig = {
  server: (typeof process !== 'undefined' && process.env?.API_HEALER_URL) || '${origin}',
  defaultContractId: '${contractId}',
  defaultEndpoint: '${endpoint}',
  timeoutMs: 5000,
};

export function configureHealer(cfg: Partial<HealerClientConfig>): void {
  config = { ...config, ...cfg };
}

export interface HealOutcome {
  status: string;
  drift: string;
  timeMs: number;
  message: string;
}

export interface HealOptions {
  contract?: string;
  allowLlm?: boolean;
  throwOnRefusal?: boolean;
}

let originalFetch: typeof globalThis.fetch | null = null;

/**
 * 1-Click Zero-Code-Change Auto-Interceptor:
 * Automatically heals JSON responses from your protected endpoint(s).
 */
export function enableAutoHeal(opts?: {
  contract?: string;
  matchUrls?: (string | RegExp)[];
  allowLlm?: boolean;
}): () => void {
  if (typeof globalThis.fetch !== 'function') return () => {};
  if (!originalFetch) {
    originalFetch = globalThis.fetch.bind(globalThis);
  }
  const baseFetch = originalFetch;
  const targetContract = opts?.contract ?? config.defaultContractId ?? '${contractId}';
  const matchers = opts?.matchUrls ?? ['${endpoint}'];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Never intercept calls to the API Healer server itself
    if (urlStr.includes('/api/heal')) {
      return baseFetch(input, init);
    }

    const shouldIntercept = matchers.some((m) =>
      typeof m === 'string' ? urlStr.includes(m) : m.test(urlStr),
    );

    if (!shouldIntercept) {
      return baseFetch(input, init);
    }

    const raw = await baseFetch(input, init);
    const contentType = raw.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return raw;

    try {
      const cloned = raw.clone();
      const rawBody = await cloned.json();
      const healed = await healPayload(targetContract, rawBody, {
        allowLlm: opts?.allowLlm ?? true,
      });
      return new Response(JSON.stringify(healed.body), {
        status: raw.status,
        headers: {
          'content-type': 'application/json',
          'x-api-healer-status': healed.meta.status,
          'x-api-healer-drift': healed.meta.drift,
          'x-api-healer-time': String(healed.meta.timeMs),
        },
      });
    } catch {
      return raw;
    }
  };

  return () => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  };
}

export async function healerFetch(
  url: string,
  init: RequestInit = {},
  opts: HealOptions = {},
): Promise<Response> {
  const baseFetch = originalFetch ?? globalThis.fetch.bind(globalThis);
  const raw = await baseFetch(url, init);
  const contentType = raw.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return raw;
  const rawBody = await raw.json();

  const contractId = opts.contract ?? config.defaultContractId ?? '${contractId}';
  const healed = await healPayload(contractId, rawBody, {
    allowLlm: opts.allowLlm,
    throwOnRefusal: opts.throwOnRefusal,
  });

  return new Response(JSON.stringify(healed.body), {
    status: raw.status,
    headers: {
      'content-type': 'application/json',
      'x-api-healer-status': healed.meta.status,
      'x-api-healer-drift': healed.meta.drift,
      'x-api-healer-time': String(healed.meta.timeMs),
    },
  });
}

export async function healPayload(
  contract: string = config.defaultContractId ?? '${contractId}',
  payload: unknown,
  opts: { allowLlm?: boolean; throwOnRefusal?: boolean } = {},
): Promise<{ body: Record<string, unknown>; meta: HealOutcome }> {
  const baseFetch = originalFetch ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 5000);
  let res: Response;
  try {
    res = await baseFetch(\`\${config.server.replace(/\\/$/, '')}/api/heal\`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({
        contractId: contract,
        payload,
        allowLlm: opts.allowLlm ?? true,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = (await res.json()) as Record<string, unknown> & {
    error?: string;
    status?: string;
    message?: string;
    servedPayload?: Record<string, unknown> | null;
    rawPayload?: Record<string, unknown>;
    timing?: { totalMs?: number };
    classification?: { driftType?: string };
  };
  if (data.error) throw new Error(\`API-HEALER: \${data.error}\`);

  const meta: HealOutcome = {
    status: data.status ?? 'ERROR',
    drift: data.classification?.driftType ?? 'NONE',
    timeMs: data.timing?.totalMs ?? -1,
    message: data.message ?? '',
  };

  const refused = meta.status === 'REFUSED' || meta.status === 'ROLLED_BACK';
  const body =
    data.servedPayload ??
    (refused ? (data.rawPayload as Record<string, unknown>) : (payload as Record<string, unknown>));
  return { body, meta };
}
`;
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url);
  const contractIdParam = searchParams.get('contractId');
  const format = searchParams.get('format') ?? 'sh';

  let contractId = contractIdParam ?? '<contract-id>';
  let endpoint = 'https://api.example.com/v1/resource';

  if (contractIdParam && contractIdParam !== '<contract-id>') {
    const row = await db.contract.findUnique({ where: { id: contractIdParam } });
    if (row) {
      contractId = row.id;
      endpoint = row.endpoint;
    }
  } else {
    const rows = await db.contract.findMany({ orderBy: { createdAt: 'desc' } });
    if (rows[0]) {
      contractId = rows[0].id;
      endpoint = rows[0].endpoint;
    }
  }

  const tsContent = buildPreconfiguredSdk(origin, contractId, endpoint);

  if (format === 'ts') {
    return new NextResponse(tsContent, {
      headers: {
        'content-type': 'text/typescript; charset=utf-8',
        'content-disposition': 'attachment; filename="api-healer-client.ts"',
      },
    });
  }

  const shellScript = `#!/usr/bin/env sh
set -e

TARGET_DIR="."
if [ -d "src/lib" ]; then
  TARGET_DIR="src/lib"
elif [ -d "lib" ]; then
  TARGET_DIR="lib"
elif [ -d "src" ]; then
  TARGET_DIR="src"
fi

TARGET_FILE="$TARGET_DIR/api-healer-client.ts"

echo "Installing API Healer 1-Click SDK into $TARGET_FILE..."
curl -fsSL "${origin}/api/setup/script?contractId=${contractId}&format=ts" -o "$TARGET_FILE"

echo ""
echo "✓ API Healer SDK installed at $TARGET_FILE"
echo "✓ Pre-configured for Contract: ${contractId} (${endpoint})"
echo ""
echo "Add this 1 line to your app entrypoint to auto-heal responses:"
echo "  import { enableAutoHeal } from './\${TARGET_FILE#./}';"
echo "  enableAutoHeal();"
`;

  return new NextResponse(shellScript, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
    },
  });
}
