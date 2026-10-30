import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { listHotPatches, purgeContractMemory } from '@/lib/healer/memory';
import { invalidateContractCache } from '@/lib/healer/contract-cache';
import {
  flattenLeaves,
  parseContractDef,
} from '@/lib/healer/contract';
import type { ContractDef } from '@/lib/healer/types';

const LEGACY_DEMO_ENDPOINTS = [
  'https://gateway.partner-api.in/v2/checkout',
  'https://einvoice.gstportal.gov.in/v1/einvoice',
  'https://webhooks.shiprocket.in/v1/status',
];

let demoCleaned = false;

async function purgeLegacyDemoData() {
  if (demoCleaned) return;
  demoCleaned = true;
  try {
    const demoContracts = await db.contract.findMany({
      where: { endpoint: { in: LEGACY_DEMO_ENDPOINTS } },
      select: { id: true },
    });
    if (demoContracts.length > 0) {
      for (const c of demoContracts) {
        purgeContractMemory(c.id);
        invalidateContractCache(c.id);
      }
      await db.contract.deleteMany({
        where: { endpoint: { in: LEGACY_DEMO_ENDPOINTS } },
      });
    }
  } catch {
    // ignore cleanup errors
  }
}

export async function GET() {
  await purgeLegacyDemoData();

  const rows = await db.contract.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { driftEvents: true, fingerprints: true, pullRequests: true } },
    },
  });
  const hot = listHotPatches();
  const contracts = rows.map((c) => {
    let leaves: { path: string; mandatory: boolean; type: string; unit?: string }[] = [];
    let historySize = 0;
    try {
      const def = parseContractDef(c.schemaJson);
      leaves = flattenLeaves(def.fields).map((l) => ({
        path: l.path,
        mandatory: !!l.def.mandatory,
        type: l.def.type ?? 'unknown',
        unit: l.def.unit,
      }));
      historySize = Object.values(JSON.parse(c.historyJson) as Record<string, number[]>).reduce(
        (s, v) => s + v.length,
        0,
      );
    } catch {
      // corrupt contract row — surface as-is
    }
    return {
      id: c.id,
      name: c.name,
      endpoint: c.endpoint,
      method: c.method,
      enabled: c.enabled,
      mandatory: JSON.parse(c.mandatoryJson) as string[],
      defaults: JSON.parse(c.defaultsJson) as Record<string, unknown>,
      historySize,
      leaves,
      counts: c._count,
      hotPatches: hot.filter((h) => h.contractId === c.id).length,
      updatedAt: c.updatedAt,
    };
  });
  return NextResponse.json({ contracts });
}

function mandatoryPathsOf(def: ContractDef): string[] {
  return flattenLeaves(def.fields)
    .filter((l) => l.def.mandatory)
    .map((l) => l.path);
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | {
        name?: string;
        endpoint?: string;
        method?: string;
        fields?: unknown;
        schemaJson?: string;
        defaults?: Record<string, unknown>;
      }
    | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const schemaJson =
    body.schemaJson ?? (body.fields ? JSON.stringify({ fields: body.fields }) : undefined);
  if (!body.name || !body.endpoint || !schemaJson) {
    return NextResponse.json(
      { error: 'name, endpoint and fields (or schemaJson) are required' },
      { status: 400 },
    );
  }
  if (!/^https?:\/\/.+/.test(body.endpoint) && !body.endpoint.startsWith('/')) {
    return NextResponse.json(
      { error: 'endpoint must be an http(s) URL or a route path' },
      { status: 422 },
    );
  }

  let def: ContractDef;
  try {
    def = parseContractDef(schemaJson);
    const leaves = flattenLeaves(def.fields);
    if (leaves.length === 0) throw new Error('at least one field is required');
    if (leaves.length > 256) throw new Error('max 256 fields per contract');
  } catch (e) {
    return NextResponse.json(
      { error: `invalid contract definition: ${(e as Error).message}` },
      { status: 422 },
    );
  }

  const existing = await db.contract.findUnique({ where: { endpoint: body.endpoint } });
  if (existing) {
    return NextResponse.json({ error: 'this endpoint is already protected' }, { status: 409 });
  }

  const row = await db.contract.create({
    data: {
      name: body.name.slice(0, 80),
      endpoint: body.endpoint,
      method: (body.method ?? 'POST').toUpperCase(),
      schemaJson: JSON.stringify(def),
      mandatoryJson: JSON.stringify(mandatoryPathsOf(def)),
      defaultsJson: JSON.stringify(body.defaults ?? {}),
    },
  });
  invalidateContractCache(row.id);
  void db.notification.create({
    data: {
      category: 'SYSTEM',
      severity: 'SUCCESS',
      title: `Contract Registered: ${row.name}`,
      description: `Protecting ${row.method} ${row.endpoint}`,
      source: 'contracts-registry',
      metadataJson: JSON.stringify({ contractId: row.id, endpoint: row.endpoint }),
    },
  });
  return NextResponse.json({ ok: true, id: row.id });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { id?: string; enabled?: boolean; resetHistory?: boolean }
    | null;
  if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
  if (body.resetHistory) data.historyJson = '{}';
  const row = await db.contract.update({ where: { id: body.id }, data });
  invalidateContractCache(row.id);
  return NextResponse.json({ ok: true, id: row.id, enabled: row.enabled });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await db.contract.delete({ where: { id } });
  purgeContractMemory(id);
  invalidateContractCache(id);
  return NextResponse.json({ ok: true });
}
