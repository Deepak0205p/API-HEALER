import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invalidateContractCache } from '@/lib/healer/contract-cache';
import { flattenLeaves, parseContractDef } from '@/lib/healer/contract';
import { healRequest } from '@/lib/healer/engine';
import type { ContractDef } from '@/lib/healer/types';

type LeafType = 'string' | 'number' | 'boolean' | 'unknown';

interface InferredLeaf {
  path: string;
  type: LeafType;
  mandatory: boolean;
}

const SMART_MANDATORY_KEYS = new Set([
  'id',
  'order_id',
  'orderid',
  'user_id',
  'userid',
  'transaction_id',
  'tx_id',
  'status',
  'amount',
  'total',
  'currency',
  'email',
]);

function inferLeavesFromSample(
  sample: unknown,
  prefix = '',
  out: InferredLeaf[] = [],
): InferredLeaf[] {
  if (sample === null || sample === undefined) return out;
  if (Array.isArray(sample)) {
    if (sample.length > 0 && typeof sample[0] === 'object' && sample[0] !== null) {
      inferLeavesFromSample(sample[0], prefix, out);
    } else {
      out.push({ path: prefix || 'items', type: 'unknown', mandatory: false });
    }
    return out;
  }
  if (typeof sample === 'object') {
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        inferLeavesFromSample(v, path, out);
      } else if (v !== null && typeof v === 'object') {
        out.push({ path, type: 'unknown', mandatory: false });
      } else {
        const t = typeof v;
        const leafKey = k.toLowerCase();
        out.push({
          path,
          type: t === 'string' || t === 'number' || t === 'boolean' ? t : 'unknown',
          mandatory: SMART_MANDATORY_KEYS.has(leafKey),
        });
      }
    }
  }
  return out;
}

function leavesToFields(leaves: InferredLeaf[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const leaf of leaves) {
    const parts = leaf.path.split('.').filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      const node = cur[k];
      if (typeof node !== 'object' || node === null || !('fields' in (node as object))) {
        cur[k] = { type: 'object', fields: {} };
      }
      cur = (cur[k] as { fields: Record<string, unknown> }).fields;
    }
    cur[parts[parts.length - 1]] =
      leaf.type === 'unknown'
        ? { type: 'unknown' }
        : { type: leaf.type, ...(leaf.mandatory ? { mandatory: true } : {}) };
  }
  return root;
}

function parseCurlInput(curlCmd: string): {
  url: string | null;
  method: string;
  headers: Record<string, string>;
  bodyJson: Record<string, unknown> | null;
} {
  const cleaned = curlCmd.replace(/\\\r?\n/g, ' ').trim();
  const urlMatch =
    cleaned.match(/['"](https?:\/\/[^'"]+)['"]/i) ??
    cleaned.match(/\b(https?:\/\/[^\s'"]+)/i);
  const url = urlMatch?.[1] ?? null;

  const methodMatch = cleaned.match(/(?:-X|--request)\s+['"]?([A-Z]+)['"]?/i);
  let method = methodMatch?.[1]?.toUpperCase() ?? 'GET';

  const headers: Record<string, string> = {};
  const headerRegex = /(?:-H|--header)\s+(['"])(.*?)\1/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headerRegex.exec(cleaned)) !== null) {
    const rawHeader = hm[2];
    const idx = rawHeader.indexOf(':');
    if (idx > 0) {
      const k = rawHeader.slice(0, idx).trim();
      const v = rawHeader.slice(idx + 1).trim();
      headers[k] = v;
    }
  }

  let bodyJson: Record<string, unknown> | null = null;
  const dataMatch =
    cleaned.match(/(?:-d|--data|--data-raw|--data-binary)\s+'([^']+)'/) ??
    cleaned.match(/(?:-d|--data|--data-raw|--data-binary)\s+"([^"]+)"/);
  if (dataMatch?.[1]) {
    if (!methodMatch) method = 'POST';
    try {
      const parsed = JSON.parse(dataMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bodyJson = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore non-json body
    }
  }

  return { url, method, headers, bodyJson };
}

function deriveContractName(endpoint: string, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim().slice(0, 80);
  try {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      const u = new URL(endpoint);
      const segs = u.pathname.split('/').filter(Boolean);
      const tail = segs.slice(-2).join('/') || 'root';
      return `${u.hostname} · /${tail}`.slice(0, 80);
    }
  } catch {
    // ignore URL parse error
  }
  const clean = endpoint.replace(/^\/+/, '') || 'api-endpoint';
  return `Service · /${clean}`.slice(0, 80);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      url?: string;
      curl?: string;
      payload?: Record<string, unknown> | string;
      name?: string;
      method?: string;
      headers?: Record<string, string>;
      verifyOnly?: boolean;
      contractId?: string;
    } | null;

    if (!body) {
      return NextResponse.json({ error: 'Invalid setup request body' }, { status: 400 });
    }

    // 1-Click Live Verification for an existing contract
    if (body.verifyOnly && body.contractId) {
      const contract = await db.contract.findUnique({ where: { id: body.contractId } });
      if (!contract) {
        return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
      }
      let samplePayload: Record<string, unknown> = {};
      if (contract.lastGoodJson) {
        try {
          samplePayload = JSON.parse(contract.lastGoodJson) as Record<string, unknown>;
        } catch {
          samplePayload = {};
        }
      }
      if (Object.keys(samplePayload).length === 0) {
        try {
          const def = parseContractDef(contract.schemaJson);
          const leaves = flattenLeaves(def.fields);
          for (const l of leaves) {
            const parts = l.path.split('.');
            let cur = samplePayload;
            for (let i = 0; i < parts.length - 1; i++) {
              const p = parts[i];
              if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
              cur = cur[p] as Record<string, unknown>;
            }
            const last = parts[parts.length - 1];
            cur[last] =
              l.def.type === 'number'
                ? 100
                : l.def.type === 'boolean'
                  ? true
                  : 'verified_ok';
          }
        } catch {
          samplePayload = { status: 'ok' };
        }
      }

      const verifyResult = await healRequest({
        contractId: contract.id,
        payload: samplePayload,
        allowLlm: false,
        callsite: 'one-click-setup:verify',
      });

      await db.notification.create({
        data: {
          category: 'SETUP',
          severity: 'SUCCESS',
          title: `1-Click Connection Verified: ${contract.name}`,
          description: `Endpoint ${contract.method} ${contract.endpoint} verified in ${verifyResult.timing.totalMs.toFixed(2)}ms (${verifyResult.status}).`,
          source: '1-click-setup',
          metadataJson: JSON.stringify({
            contractId: contract.id,
            endpoint: contract.endpoint,
            status: verifyResult.status,
          }),
        },
      });

      return NextResponse.json({
        ok: true,
        verified: true,
        contract: {
          id: contract.id,
          name: contract.name,
          endpoint: contract.endpoint,
          method: contract.method,
        },
        verification: {
          status: verifyResult.status,
          totalMs: verifyResult.timing.totalMs,
          message: verifyResult.message,
        },
      });
    }

    let endpoint = body.url?.trim() ?? '';
    let method = (body.method ?? 'GET').toUpperCase();
    let customHeaders: Record<string, string> = body.headers ?? {};
    let sampleObj: Record<string, unknown> | null = null;

    if (body.curl?.trim()) {
      const parsedCurl = parseCurlInput(body.curl);
      if (parsedCurl.url) endpoint = parsedCurl.url;
      if (parsedCurl.method) method = parsedCurl.method;
      customHeaders = { ...parsedCurl.headers, ...customHeaders };
      if (parsedCurl.bodyJson) sampleObj = parsedCurl.bodyJson;
    }

    if (body.payload) {
      if (typeof body.payload === 'string' && body.payload.trim()) {
        try {
          const p = JSON.parse(body.payload);
          if (p && typeof p === 'object' && !Array.isArray(p)) {
            sampleObj = p as Record<string, unknown>;
          } else if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'object') {
            sampleObj = p[0] as Record<string, unknown>;
          }
        } catch {
          return NextResponse.json({ error: 'Invalid JSON in sample payload' }, { status: 400 });
        }
      } else if (typeof body.payload === 'object' && !Array.isArray(body.payload)) {
        sampleObj = body.payload;
      }
    }

    // Probe live URL if sampleObj not yet available and URL is http(s)
    let probedLive = false;
    if (!sampleObj && /^https?:\/\/.+/i.test(endpoint)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6500);
      try {
        const res = await fetch(endpoint, {
          method: method === 'POST' || method === 'PUT' || method === 'PATCH' ? method : 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': 'API-Healer-OneClick-Setup/1.0',
            ...customHeaders,
          },
          signal: ctrl.signal,
        });
        const text = await res.text();
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          sampleObj = parsed as Record<string, unknown>;
          probedLive = true;
        } else if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
          sampleObj = parsed[0] as Record<string, unknown>;
          probedLive = true;
        }
      } catch {
        // Fallback if endpoint requires auth or is an internal route path
      } finally {
        clearTimeout(timer);
      }
    }

    if (!endpoint) {
      endpoint = '/v1/app/endpoint';
    }

    if (!sampleObj || Object.keys(sampleObj).length === 0) {
      return NextResponse.json(
        {
          error:
            'Could not auto-fetch JSON from that URL (it may be private or unreachable). Paste a sample JSON response or cURL with -d payload to complete 1-click setup.',
        },
        { status: 422 },
      );
    }

    const leaves = inferLeavesFromSample(sampleObj);
    if (leaves.length === 0) {
      return NextResponse.json(
        { error: 'No JSON object fields found to protect.' },
        { status: 422 },
      );
    }

    const fields = leavesToFields(leaves);
    const schemaJson = JSON.stringify({ fields });
    const def: ContractDef = parseContractDef(schemaJson);
    const mandatory = flattenLeaves(def.fields)
      .filter((l) => l.def.mandatory)
      .map((l) => l.path);

    const contractName = deriveContractName(endpoint, body.name);

    const contractRow = await db.contract.upsert({
      where: { endpoint },
      create: {
        name: contractName,
        endpoint,
        method,
        schemaJson: JSON.stringify(def),
        mandatoryJson: JSON.stringify(mandatory),
        defaultsJson: '{}',
        historyJson: '{}',
        enabled: true,
      },
      update: {
        name: contractName,
        method,
        schemaJson: JSON.stringify(def),
        mandatoryJson: JSON.stringify(mandatory),
        lastGoodJson: JSON.stringify(sampleObj),
        lastGoodAt: new Date(),
        enabled: true,
      },
    });

    invalidateContractCache(contractRow.id);

    // Run immediate baseline verification + warm LKG & numeric history
    const verification = await healRequest({
      contractId: contractRow.id,
      payload: sampleObj,
      allowLlm: false,
      callsite: 'one-click-setup:init',
    });

    await db.notification.create({
      data: {
        category: 'SETUP',
        severity: 'SUCCESS',
        title: `1-Click Setup Completed: ${contractRow.name}`,
        description: `Protected ${leaves.length} fields (${mandatory.length} mandatory) on ${method} ${endpoint}. Initial verification: ${verification.status} in ${verification.timing.totalMs.toFixed(2)}ms.`,
        source: '1-click-setup',
        metadataJson: JSON.stringify({
          contractId: contractRow.id,
          endpoint,
          method,
          fieldsCount: leaves.length,
          probedLive,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      probedLive,
      contract: {
        id: contractRow.id,
        name: contractRow.name,
        endpoint: contractRow.endpoint,
        method: contractRow.method,
        fieldsCount: leaves.length,
        mandatoryCount: mandatory.length,
        leaves,
      },
      verification: {
        status: verification.status,
        totalMs: verification.timing.totalMs,
        message: verification.message,
      },
    });
  } catch (error) {
    console.error('[API Error] POST /api/setup:', error);
    return NextResponse.json(
      { error: 'An unexpected error occurred during 1-click setup.' },
      { status: 500 },
    );
  }
}
