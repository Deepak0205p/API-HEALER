import { randomUUID } from 'crypto';
import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { db as drizzleDb, isDatabaseConfigured } from '@/db/index';
import {
  contracts,
  driftEvents,
  fingerprints,
  jobRuns,
  notifications,
  pullRequests,
} from '@/db/schema';

function newId(prefix = 'c'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

// In-memory store used only when PostgreSQL is not configured (e.g. external preview without SQL_HOST)
const mem = {
  contracts: new Map<string, any>(),
  driftEvents: new Map<string, any>(),
  fingerprints: new Map<string, any>(),
  pullRequests: new Map<string, any>(),
  jobRuns: new Map<string, any>(),
  notifications: new Map<string, any>(),
};

function matchesWhere(item: Record<string, any>, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;
    const itemVal = item[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      const opObj = val as Record<string, unknown>;
      if ('in' in opObj && Array.isArray(opObj.in)) {
        if (!opObj.in.includes(itemVal)) return false;
      } else if ('not' in opObj && opObj.not === null) {
        if (itemVal === null || itemVal === undefined) return false;
      } else if ('lt' in opObj && opObj.lt instanceof Date) {
        if (!(itemVal instanceof Date) || itemVal >= opObj.lt) return false;
      }
    } else if (itemVal !== val) {
      return false;
    }
  }
  return true;
}

function buildWhere<T extends Record<string, unknown>>(
  table: any,
  where?: T,
): SQL | undefined {
  if (!where) return undefined;
  const conditions: SQL[] = [];
  for (const [key, val] of Object.entries(where)) {
    if (val === undefined) continue;
    const col = table[key];
    if (!col) continue;
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      const opObj = val as Record<string, unknown>;
      if ('in' in opObj && Array.isArray(opObj.in)) {
        if (opObj.in.length === 0) {
          conditions.push(sql`false`);
        } else {
          conditions.push(inArray(col, opObj.in));
        }
      } else if ('not' in opObj && opObj.not === null) {
        conditions.push(isNotNull(col));
      } else if ('lt' in opObj && opObj.lt instanceof Date) {
        conditions.push(lt(col, opObj.lt));
      }
    } else {
      conditions.push(eq(col, val));
    }
  }
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

export const db = {
  contract: {
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      include?: { _count?: { select?: { driftEvents?: boolean; fingerprints?: boolean; pullRequests?: boolean } } };
      select?: Record<string, boolean>;
    }) {
      if (!isDatabaseConfigured()) {
        const list = Array.from(mem.contracts.values()).filter((r) => matchesWhere(r, args?.where));
        list.sort((a, b) =>
          args?.orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return list.map((r) => ({
          ...r,
          _count: {
            driftEvents: Array.from(mem.driftEvents.values()).filter((e) => e.contractId === r.id).length,
            fingerprints: Array.from(mem.fingerprints.values()).filter((f) => f.contractId === r.id).length,
            pullRequests: Array.from(mem.pullRequests.values()).filter((p) => p.contractId === r.id).length,
          },
        }));
      }
      try {
        const cond = buildWhere(contracts, args?.where);
        const order =
          args?.orderBy?.createdAt === 'desc'
            ? desc(contracts.createdAt)
            : asc(contracts.createdAt);
        const rows = cond
          ? await drizzleDb.select().from(contracts).where(cond).orderBy(order)
          : await drizzleDb.select().from(contracts).orderBy(order);

        if (args?.include?._count) {
          const [evCounts, fpCounts, prCounts] = await Promise.all([
            drizzleDb
              .select({ contractId: driftEvents.contractId, c: count() })
              .from(driftEvents)
              .groupBy(driftEvents.contractId),
            drizzleDb
              .select({ contractId: fingerprints.contractId, c: count() })
              .from(fingerprints)
              .groupBy(fingerprints.contractId),
            drizzleDb
              .select({ contractId: pullRequests.contractId, c: count() })
              .from(pullRequests)
              .groupBy(pullRequests.contractId),
          ]);
          const evMap = new Map(evCounts.map((r) => [r.contractId, Number(r.c)]));
          const fpMap = new Map(fpCounts.map((r) => [r.contractId, Number(r.c)]));
          const prMap = new Map(prCounts.map((r) => [r.contractId, Number(r.c)]));
          return rows.map((r) => ({
            ...r,
            _count: {
              driftEvents: evMap.get(r.id) ?? 0,
              fingerprints: fpMap.get(r.id) ?? 0,
              pullRequests: prMap.get(r.id) ?? 0,
            },
          }));
        }

        return rows.map((r) => ({
          ...r,
          _count: { driftEvents: 0, fingerprints: 0, pullRequests: 0 },
        }));
      } catch {
        return Array.from(mem.contracts.values()).filter((r) => matchesWhere(r, args?.where));
      }
    },

    async findUnique(args: {
      where: { id?: string; endpoint?: string };
      select?: Record<string, boolean>;
    }) {
      if (!isDatabaseConfigured()) {
        for (const r of mem.contracts.values()) {
          if (args.where.id && r.id === args.where.id) return r;
          if (args.where.endpoint && r.endpoint === args.where.endpoint) return r;
        }
        return null;
      }
      try {
        const cond = args.where.id
          ? eq(contracts.id, args.where.id)
          : args.where.endpoint
            ? eq(contracts.endpoint, args.where.endpoint)
            : undefined;
        if (!cond) return null;
        const [row] = await drizzleDb.select().from(contracts).where(cond).limit(1);
        return row ?? null;
      } catch {
        return null;
      }
    },

    async create(args: {
      data: {
        id?: string;
        name: string;
        endpoint: string;
        method?: string;
        schemaJson: string;
        mandatoryJson?: string;
        defaultsJson?: string;
        historyJson?: string;
        lastGoodJson?: string | null;
        lastGoodAt?: Date | null;
        enabled?: boolean;
        ownerUid?: string | null;
      };
    }) {
      const now = new Date();
      const fallback = {
        id: args.data.id ?? newId('ctr'),
        name: args.data.name,
        endpoint: args.data.endpoint,
        method: args.data.method ?? 'POST',
        schemaJson: args.data.schemaJson,
        mandatoryJson: args.data.mandatoryJson ?? '[]',
        defaultsJson: args.data.defaultsJson ?? '{}',
        historyJson: args.data.historyJson ?? '{}',
        lastGoodJson: args.data.lastGoodJson ?? null,
        lastGoodAt: args.data.lastGoodAt ?? null,
        enabled: args.data.enabled ?? true,
        ownerUid: args.data.ownerUid ?? null,
        createdAt: now,
        updatedAt: now,
      };
      mem.contracts.set(fallback.id, fallback);
      if (!isDatabaseConfigured()) return fallback;
      try {
        const [row] = await drizzleDb
          .insert(contracts)
          .values(fallback)
          .returning();
        return row ?? fallback;
      } catch {
        return fallback;
      }
    },

    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const existing = mem.contracts.get(args.where.id);
      if (existing) {
        mem.contracts.set(args.where.id, { ...existing, ...args.data, updatedAt: new Date() });
      }
      if (!isDatabaseConfigured()) {
        return mem.contracts.get(args.where.id) ?? { id: args.where.id, ...args.data };
      }
      try {
        const [row] = await drizzleDb
          .update(contracts)
          .set({
            ...args.data,
            updatedAt: new Date(),
          })
          .where(eq(contracts.id, args.where.id))
          .returning();
        return row ?? { id: args.where.id, ...args.data };
      } catch {
        return { id: args.where.id, ...args.data };
      }
    },

    async upsert(args: {
      where: { endpoint: string };
      create: {
        name: string;
        endpoint: string;
        method?: string;
        schemaJson: string;
        mandatoryJson?: string;
        defaultsJson?: string;
        historyJson?: string;
        enabled?: boolean;
      };
      update: Record<string, unknown>;
    }) {
      const now = new Date();
      const fallback = {
        id: newId('ctr'),
        name: args.create.name,
        endpoint: args.create.endpoint,
        method: args.create.method ?? 'POST',
        schemaJson: args.create.schemaJson,
        mandatoryJson: args.create.mandatoryJson ?? '[]',
        defaultsJson: args.create.defaultsJson ?? '{}',
        historyJson: args.create.historyJson ?? '{}',
        enabled: args.create.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      mem.contracts.set(fallback.id, fallback);
      if (!isDatabaseConfigured()) return fallback;
      try {
        const [row] = await drizzleDb
          .insert(contracts)
          .values(fallback)
          .onConflictDoUpdate({
            target: contracts.endpoint,
            set: {
              ...args.update,
              updatedAt: now,
            },
          })
          .returning();
        return row ?? fallback;
      } catch {
        return fallback;
      }
    },

    async delete(args: { where: { id: string } }) {
      mem.contracts.delete(args.where.id);
      if (!isDatabaseConfigured()) return { id: args.where.id };
      try {
        const [row] = await drizzleDb
          .delete(contracts)
          .where(eq(contracts.id, args.where.id))
          .returning();
        return row ?? { id: args.where.id };
      } catch {
        return { id: args.where.id };
      }
    },

    async deleteMany(args?: { where?: Record<string, unknown> }) {
      if (!args?.where) {
        const count = mem.contracts.size;
        mem.contracts.clear();
        if (!isDatabaseConfigured()) return { count };
      }
      if (!isDatabaseConfigured()) return { count: 0 };
      try {
        const cond = buildWhere(contracts, args?.where);
        const deleted = cond
          ? await drizzleDb.delete(contracts).where(cond).returning({ id: contracts.id })
          : await drizzleDb.delete(contracts).returning({ id: contracts.id });
        return { count: deleted.length };
      } catch {
        return { count: 0 };
      }
    },
  },

  driftEvent: {
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      take?: number;
      include?: { contract?: { select?: { name?: boolean; endpoint?: boolean } } };
      select?: Record<string, boolean>;
    }) {
      if (!isDatabaseConfigured()) {
        const list = Array.from(mem.driftEvents.values()).filter((r) => matchesWhere(r, args?.where));
        list.sort((a, b) =>
          args?.orderBy?.createdAt === 'asc'
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        const sliced = list.slice(0, args?.take ?? 100);
        if (args?.include?.contract) {
          return sliced.map((r) => ({
            ...r,
            contract: mem.contracts.get(r.contractId) ?? { name: '—', endpoint: '' },
          }));
        }
        return sliced;
      }
      try {
        const cond = buildWhere(driftEvents, args?.where);
        const order =
          args?.orderBy?.createdAt === 'asc'
            ? asc(driftEvents.createdAt)
            : desc(driftEvents.createdAt);
        const query = cond
          ? drizzleDb
              .select()
              .from(driftEvents)
              .where(cond)
              .orderBy(order)
              .limit(args?.take ?? 100)
          : drizzleDb
              .select()
              .from(driftEvents)
              .orderBy(order)
              .limit(args?.take ?? 100);
        const rows = await query;

        if (args?.include?.contract) {
          const allContracts = await drizzleDb
            .select({ id: contracts.id, name: contracts.name, endpoint: contracts.endpoint })
            .from(contracts);
          const cMap = new Map(allContracts.map((c) => [c.id, c]));
          return rows.map((r) => ({
            ...r,
            contract: cMap.get(r.contractId) ?? { name: '—', endpoint: '' },
          }));
        }

        return rows;
      } catch {
        return [];
      }
    },

    async findUnique(args: {
      where: { id: string };
      include?: { contract?: { select?: { name?: boolean; endpoint?: boolean } } };
    }) {
      if (!isDatabaseConfigured()) {
        const row = mem.driftEvents.get(args.where.id);
        if (!row) return null;
        if (args.include?.contract) {
          return { ...row, contract: mem.contracts.get(row.contractId) ?? { name: '—', endpoint: '' } };
        }
        return row;
      }
      try {
        const [row] = await drizzleDb
          .select()
          .from(driftEvents)
          .where(eq(driftEvents.id, args.where.id))
          .limit(1);
        if (!row) return null;
        if (args.include?.contract) {
          const [c] = await drizzleDb
            .select({ name: contracts.name, endpoint: contracts.endpoint })
            .from(contracts)
            .where(eq(contracts.id, row.contractId))
            .limit(1);
          return { ...row, contract: c ?? { name: '—', endpoint: '' } };
        }
        return row;
      } catch {
        return null;
      }
    },

    async findFirst(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      select?: Record<string, boolean>;
    }) {
      if (!isDatabaseConfigured()) {
        const list = Array.from(mem.driftEvents.values()).filter((r) => matchesWhere(r, args?.where));
        list.sort((a, b) =>
          args?.orderBy?.createdAt === 'asc'
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return list[0] ?? null;
      }
      try {
        const cond = buildWhere(driftEvents, args?.where);
        const order =
          args?.orderBy?.createdAt === 'asc'
            ? asc(driftEvents.createdAt)
            : desc(driftEvents.createdAt);
        const [row] = cond
          ? await drizzleDb.select().from(driftEvents).where(cond).orderBy(order).limit(1)
          : await drizzleDb.select().from(driftEvents).orderBy(order).limit(1);
        return row ?? null;
      } catch {
        return null;
      }
    },

    async create(args: {
      data: {
        id?: string;
        contractId: string;
        signature?: string;
        driftType?: string;
        callsite?: string | null;
        classificationJson?: string;
        rawPayloadJson?: string;
        healedPayloadJson?: string | null;
        planJson?: string | null;
        gatesJson?: string | null;
        status?: string;
        composer?: string;
        confidence?: number;
        classifyMs?: number;
        composeMs?: number;
        gatesMs?: number;
        totalMs?: number;
        canaryPassed?: boolean | null;
        prId?: string | null;
      };
    }) {
      const fallback = {
        id: args.data.id ?? newId('ev'),
        contractId: args.data.contractId,
        signature: args.data.signature ?? '',
        driftType: args.data.driftType ?? 'NONE',
        callsite: args.data.callsite ?? null,
        classificationJson: args.data.classificationJson ?? '{}',
        rawPayloadJson: args.data.rawPayloadJson ?? '{}',
        healedPayloadJson: args.data.healedPayloadJson ?? null,
        planJson: args.data.planJson ?? null,
        gatesJson: args.data.gatesJson ?? null,
        status: args.data.status ?? 'PASSTHROUGH',
        composer: args.data.composer ?? 'deterministic',
        confidence: args.data.confidence ?? 1,
        classifyMs: args.data.classifyMs ?? 0,
        composeMs: args.data.composeMs ?? 0,
        gatesMs: args.data.gatesMs ?? 0,
        totalMs: args.data.totalMs ?? 0,
        canaryPassed: args.data.canaryPassed ?? null,
        prId: args.data.prId ?? null,
        createdAt: new Date(),
      };
      mem.driftEvents.set(fallback.id, fallback);
      if (!isDatabaseConfigured()) return fallback;
      try {
        const [row] = await drizzleDb
          .insert(driftEvents)
          .values(fallback)
          .returning();
        return row ?? fallback;
      } catch {
        return fallback;
      }
    },

    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const existing = mem.driftEvents.get(args.where.id);
      if (existing) {
        mem.driftEvents.set(args.where.id, { ...existing, ...args.data });
      }
      if (!isDatabaseConfigured()) return { id: args.where.id, ...args.data };
      try {
        const [row] = await drizzleDb
          .update(driftEvents)
          .set(args.data)
          .where(eq(driftEvents.id, args.where.id))
          .returning();
        return row ?? { id: args.where.id, ...args.data };
      } catch {
        return { id: args.where.id, ...args.data };
      }
    },

    async deleteMany(args?: { where?: Record<string, unknown> }) {
      if (!args?.where) {
        const count = mem.driftEvents.size;
        mem.driftEvents.clear();
        if (!isDatabaseConfigured()) return { count };
      }
      if (!isDatabaseConfigured()) return { count: 0 };
      try {
        const cond = buildWhere(driftEvents, args?.where);
        const deleted = cond
          ? await drizzleDb.delete(driftEvents).where(cond).returning({ id: driftEvents.id })
          : await drizzleDb.delete(driftEvents).returning({ id: driftEvents.id });
        return { count: deleted.length };
      } catch {
        return { count: 0 };
      }
    },

    async count(args?: { where?: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) {
        return Array.from(mem.driftEvents.values()).filter((r) => matchesWhere(r, args?.where)).length;
      }
      try {
        const cond = buildWhere(driftEvents, args?.where);
        const [res] = cond
          ? await drizzleDb.select({ c: count() }).from(driftEvents).where(cond)
          : await drizzleDb.select({ c: count() }).from(driftEvents);
        return Number(res?.c ?? 0);
      } catch {
        return 0;
      }
    },

    async aggregate(args: {
      where?: Record<string, unknown>;
      _avg?: { totalMs?: boolean; classifyMs?: boolean; gatesMs?: boolean };
      _count?: { _all?: boolean };
    }) {
      if (!isDatabaseConfigured()) {
        return {
          _avg: { totalMs: null, classifyMs: null, gatesMs: null },
          _count: { _all: Array.from(mem.driftEvents.values()).filter((r) => matchesWhere(r, args.where)).length },
        };
      }
      try {
        const cond = buildWhere(driftEvents, args.where);
        const [res] = cond
          ? await drizzleDb
              .select({
                totalMs: avg(driftEvents.totalMs),
                classifyMs: avg(driftEvents.classifyMs),
                gatesMs: avg(driftEvents.gatesMs),
                allCount: count(),
              })
              .from(driftEvents)
              .where(cond)
          : await drizzleDb
              .select({
                totalMs: avg(driftEvents.totalMs),
                classifyMs: avg(driftEvents.classifyMs),
                gatesMs: avg(driftEvents.gatesMs),
                allCount: count(),
              })
              .from(driftEvents);
        return {
          _avg: {
            totalMs: res?.totalMs ? Number(res.totalMs) : null,
            classifyMs: res?.classifyMs ? Number(res.classifyMs) : null,
            gatesMs: res?.gatesMs ? Number(res.gatesMs) : null,
          },
          _count: {
            _all: Number(res?.allCount ?? 0),
          },
        };
      } catch {
        return {
          _avg: { totalMs: null, classifyMs: null, gatesMs: null },
          _count: { _all: 0 },
        };
      }
    },
  },

  fingerprint: {
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      take?: number;
      include?: { contract?: { select?: { name?: boolean } } };
    }) {
      if (!isDatabaseConfigured()) {
        const list = Array.from(mem.fingerprints.values()).filter((r) => matchesWhere(r, args?.where));
        return list.slice(0, args?.take ?? 50);
      }
      try {
        const cond = buildWhere(fingerprints, args?.where);
        const order =
          args?.orderBy?.createdAt === 'asc'
            ? asc(fingerprints.createdAt)
            : desc(fingerprints.createdAt);
        const rows = cond
          ? await drizzleDb
              .select()
              .from(fingerprints)
              .where(cond)
              .orderBy(order)
              .limit(args?.take ?? 50)
          : await drizzleDb
              .select()
              .from(fingerprints)
              .orderBy(order)
              .limit(args?.take ?? 50);

        if (args?.include?.contract) {
          const allContracts = await drizzleDb
            .select({ id: contracts.id, name: contracts.name })
            .from(contracts);
          const cMap = new Map(allContracts.map((c) => [c.id, c]));
          return rows.map((r) => ({
            ...r,
            contract: cMap.get(r.contractId) ?? { name: '—' },
          }));
        }
        return rows;
      } catch {
        return [];
      }
    },

    async findFirst(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
    }) {
      const rows = await this.findMany({
        where: args?.where,
        orderBy: args?.orderBy,
        take: 1,
      });
      return rows[0] ?? null;
    },

    async findUnique(args: {
      where: { id?: string; signature?: string };
      select?: Record<string, boolean>;
    }) {
      if (!isDatabaseConfigured()) {
        for (const r of mem.fingerprints.values()) {
          if (args.where.id && r.id === args.where.id) return r;
          if (args.where.signature && r.signature === args.where.signature) return r;
        }
        return null;
      }
      try {
        const cond = args.where.id
          ? eq(fingerprints.id, args.where.id)
          : args.where.signature
            ? eq(fingerprints.signature, args.where.signature)
            : undefined;
        if (!cond) return null;
        const [row] = await drizzleDb.select().from(fingerprints).where(cond).limit(1);
        return row ?? null;
      } catch {
        return null;
      }
    },

    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) return { id: args.where.id, ...args.data };
      try {
        const setPayload: Record<string, unknown> = { ...args.data };
        if (
          setPayload.hits &&
          typeof setPayload.hits === 'object' &&
          'increment' in (setPayload.hits as Record<string, unknown>)
        ) {
          const inc = Number((setPayload.hits as { increment: number }).increment ?? 1);
          setPayload.hits = sql`${fingerprints.hits} + ${inc}`;
        }
        const [row] = await drizzleDb
          .update(fingerprints)
          .set(setPayload)
          .where(eq(fingerprints.id, args.where.id))
          .returning();
        return row ?? { id: args.where.id, ...args.data };
      } catch {
        return { id: args.where.id, ...args.data };
      }
    },

    async upsert(args: {
      where: { signature: string };
      create: {
        contractId: string;
        signature: string;
        planJson: string;
        opsSummary?: string;
        confidence?: number;
        ttlAt: Date;
        status?: string;
      };
      update: Record<string, unknown>;
    }) {
      const fallback = {
        id: newId('fp'),
        contractId: args.create.contractId,
        signature: args.create.signature,
        planJson: args.create.planJson,
        opsSummary: args.create.opsSummary ?? '',
        confidence: args.create.confidence ?? 1,
        ttlAt: args.create.ttlAt,
        status: args.create.status ?? 'ACTIVE',
        hits: 1,
        createdAt: new Date(),
      };
      mem.fingerprints.set(fallback.id, fallback);
      if (!isDatabaseConfigured()) return fallback;
      try {
        const [row] = await drizzleDb
          .insert(fingerprints)
          .values(fallback)
          .onConflictDoUpdate({
            target: fingerprints.signature,
            set: args.update,
          })
          .returning();
        return row ?? fallback;
      } catch {
        return fallback;
      }
    },

    async updateMany(args: { where?: Record<string, unknown>; data: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) return { count: 0 };
      try {
        const cond = buildWhere(fingerprints, args.where);
        const updated = cond
          ? await drizzleDb
              .update(fingerprints)
              .set(args.data)
              .where(cond)
              .returning({ id: fingerprints.id })
          : await drizzleDb
              .update(fingerprints)
              .set(args.data)
              .returning({ id: fingerprints.id });
        return { count: updated.length };
      } catch {
        return { count: 0 };
      }
    },

    async deleteMany(args?: { where?: Record<string, unknown> }) {
      if (!args?.where) {
        const count = mem.fingerprints.size;
        mem.fingerprints.clear();
        if (!isDatabaseConfigured()) return { count };
      }
      if (!isDatabaseConfigured()) return { count: 0 };
      try {
        const cond = buildWhere(fingerprints, args?.where);
        const deleted = cond
          ? await drizzleDb.delete(fingerprints).where(cond).returning({ id: fingerprints.id })
          : await drizzleDb.delete(fingerprints).returning({ id: fingerprints.id });
        return { count: deleted.length };
      } catch {
        return { count: 0 };
      }
    },

    async count(args?: { where?: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) {
        return Array.from(mem.fingerprints.values()).filter((r) => matchesWhere(r, args?.where)).length;
      }
      try {
        const cond = buildWhere(fingerprints, args?.where);
        const [res] = cond
          ? await drizzleDb.select({ c: count() }).from(fingerprints).where(cond)
          : await drizzleDb.select({ c: count() }).from(fingerprints);
        return Number(res?.c ?? 0);
      } catch {
        return 0;
      }
    },

    async aggregate(_args: { _sum: { hits: boolean } }) {
      if (!isDatabaseConfigured()) {
        return { _sum: { hits: 0 } };
      }
      try {
        const [res] = await drizzleDb
          .select({ totalHits: sum(fingerprints.hits) })
          .from(fingerprints);
        return {
          _sum: {
            hits: res?.totalHits ? Number(res.totalHits) : 0,
          },
        };
      } catch {
        return { _sum: { hits: 0 } };
      }
    },
  },

  pullRequest: {
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      take?: number;
      include?: { contract?: { select?: { name?: boolean; endpoint?: boolean } } };
    }) {
      if (!isDatabaseConfigured()) {
        return Array.from(mem.pullRequests.values())
          .filter((r) => matchesWhere(r, args?.where))
          .slice(0, args?.take ?? 30);
      }
      try {
        const cond = buildWhere(pullRequests, args?.where);
        const order =
          args?.orderBy?.createdAt === 'asc'
            ? asc(pullRequests.createdAt)
            : desc(pullRequests.createdAt);
        const rows = cond
          ? await drizzleDb
              .select()
              .from(pullRequests)
              .where(cond)
              .orderBy(order)
              .limit(args?.take ?? 30)
          : await drizzleDb
              .select()
              .from(pullRequests)
              .orderBy(order)
              .limit(args?.take ?? 30);

        if (args?.include?.contract) {
          const allContracts = await drizzleDb
            .select({ id: contracts.id, name: contracts.name, endpoint: contracts.endpoint })
            .from(contracts);
          const cMap = new Map(allContracts.map((c) => [c.id, c]));
          return rows.map((r) => ({
            ...r,
            contract: cMap.get(r.contractId) ?? { name: '—', endpoint: '' },
          }));
        }
        return rows;
      } catch {
        return [];
      }
    },

    async findFirst(args?: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
    }) {
      const rows = await this.findMany({
        where: args?.where,
        orderBy: args?.orderBy,
        take: 1,
      });
      return rows[0] ?? null;
    },

    async findUnique(args: {
      where: { id: string };
      include?: { contract?: { select?: { name?: boolean; endpoint?: boolean } } };
    }) {
      if (!isDatabaseConfigured()) {
        return mem.pullRequests.get(args.where.id) ?? null;
      }
      try {
        const [row] = await drizzleDb
          .select()
          .from(pullRequests)
          .where(eq(pullRequests.id, args.where.id))
          .limit(1);
        if (!row) return null;
        if (args.include?.contract) {
          const [c] = await drizzleDb
            .select({ name: contracts.name, endpoint: contracts.endpoint })
            .from(contracts)
            .where(eq(contracts.id, row.contractId))
            .limit(1);
          return { ...row, contract: c ?? { name: '—', endpoint: '' } };
        }
        return row;
      } catch {
        return null;
      }
    },

    async create(args: {
      data: {
        id?: string;
        contractId: string;
        driftEventId?: string | null;
        number: number;
        branch: string;
        title: string;
        body?: string;
        diffText?: string;
        planJson?: string;
        canaryLogJson?: string;
        status?: string;
        mode?: string;
        url?: string | null;
      };
    }) {
      const fallback = {
        id: args.data.id ?? newId('pr'),
        contractId: args.data.contractId,
        driftEventId: args.data.driftEventId ?? null,
        number: args.data.number,
        branch: args.data.branch,
        title: args.data.title,
        body: args.data.body ?? '',
        diffText: args.data.diffText ?? '',
        planJson: args.data.planJson ?? '{}',
        canaryLogJson: args.data.canaryLogJson ?? '[]',
        status: args.data.status ?? 'OPEN',
        mode: args.data.mode ?? 'DRY_RUN',
        url: args.data.url ?? null,
        createdAt: new Date(),
      };
      mem.pullRequests.set(fallback.id, fallback);
      if (!isDatabaseConfigured()) return fallback;
      try {
        const [row] = await drizzleDb
          .insert(pullRequests)
          .values(fallback)
          .returning();
        return row ?? fallback;
      } catch {
        return fallback;
      }
    },

    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const existing = mem.pullRequests.get(args.where.id);
      if (existing) {
        mem.pullRequests.set(args.where.id, { ...existing, ...args.data });
      }
      if (!isDatabaseConfigured()) return { id: args.where.id, ...args.data };
      try {
        const [row] = await drizzleDb
          .update(pullRequests)
          .set(args.data)
          .where(eq(pullRequests.id, args.where.id))
          .returning();
        return row ?? { id: args.where.id, ...args.data };
      } catch {
        return { id: args.where.id, ...args.data };
      }
    },

    async deleteMany(args?: { where?: Record<string, unknown> }) {
      if (!args?.where) {
        const count = mem.pullRequests.size;
        mem.pullRequests.clear();
        if (!isDatabaseConfigured()) return { count };
      }
      if (!isDatabaseConfigured()) return { count: 0 };
      try {
        const cond = buildWhere(pullRequests, args?.where);
        const deleted = cond
          ? await drizzleDb.delete(pullRequests).where(cond).returning({ id: pullRequests.id })
          : await drizzleDb.delete(pullRequests).returning({ id: pullRequests.id });
        return { count: deleted.length };
      } catch {
        return { count: 0 };
      }
    },

    async count(args?: { where?: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) {
        return Array.from(mem.pullRequests.values()).filter((r) => matchesWhere(r, args?.where)).length;
      }
      try {
        const cond = buildWhere(pullRequests, args?.where);
        const [res] = cond
          ? await drizzleDb.select({ c: count() }).from(pullRequests).where(cond)
          : await drizzleDb.select({ c: count() }).from(pullRequests);
        return Number(res?.c ?? 0);
      } catch {
        return 0;
      }
    },
  },

  jobRun: {
    async count(args?: { where?: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) {
        return Array.from(mem.jobRuns.values()).filter((r) => matchesWhere(r, args?.where)).length;
      }
      try {
        const cond = buildWhere(jobRuns, args?.where);
        const [res] = cond
          ? await drizzleDb.select({ c: count() }).from(jobRuns).where(cond)
          : await drizzleDb.select({ c: count() }).from(jobRuns);
        return Number(res?.c ?? 0);
      } catch {
        return Array.from(mem.jobRuns.values()).filter((r) => matchesWhere(r, args?.where)).length;
      }
    },
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[];
      take?: number;
    }) {
      if (!isDatabaseConfigured()) {
        const list = Array.from(mem.jobRuns.values()).filter((r) => matchesWhere(r, args?.where));
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return list.slice(0, args?.take ?? 150);
      }
      try {
        const cond = buildWhere(jobRuns, args?.where);
        const orderList: SQL[] = [];
        const rawOrder = Array.isArray(args?.orderBy)
          ? args.orderBy
          : args?.orderBy
            ? [args.orderBy]
            : [{ createdAt: 'desc' as const }];
        for (const item of rawOrder) {
          if (item.priority) {
            orderList.push(item.priority === 'asc' ? asc(jobRuns.priority) : desc(jobRuns.priority));
          }
          if (item.createdAt) {
            orderList.push(
              item.createdAt === 'asc' ? asc(jobRuns.createdAt) : desc(jobRuns.createdAt),
            );
          }
        }
        if (orderList.length === 0) orderList.push(desc(jobRuns.createdAt));

        const rows = cond
          ? await drizzleDb
              .select()
              .from(jobRuns)
              .where(cond)
              .orderBy(...orderList)
              .limit(args?.take ?? 150)
          : await drizzleDb
              .select()
              .from(jobRuns)
              .orderBy(...orderList)
              .limit(args?.take ?? 150);
        return rows;
      } catch {
        return Array.from(mem.jobRuns.values())
          .filter((r) => matchesWhere(r, args?.where))
          .slice(0, args?.take ?? 150);
      }
    },

    async findUnique(args: { where: { id: string } }) {
      if (!isDatabaseConfigured()) {
        return mem.jobRuns.get(args.where.id) ?? null;
      }
      try {
        const [row] = await drizzleDb
          .select()
          .from(jobRuns)
          .where(eq(jobRuns.id, args.where.id))
          .limit(1);
        return row ?? null;
      } catch {
        return mem.jobRuns.get(args.where.id) ?? null;
      }
    },

    async create(args: {
      data: {
        id?: string;
        type: string;
        status?: string;
        priority?: number;
        payloadJson?: string;
        resultJson?: string | null;
        ms?: number | null;
        attempts?: number;
        error?: string | null;
        finishedAt?: Date | null;
      };
    }) {
      const fallback = {
        id: args.data.id ?? newId('job'),
        type: args.data.type,
        status: args.data.status ?? 'QUEUED',
        priority: args.data.priority ?? 5,
        payloadJson: args.data.payloadJson ?? '{}',
        resultJson: args.data.resultJson ?? null,
        ms: args.data.ms ?? null,
        attempts: args.data.attempts ?? 0,
        error: args.data.error ?? null,
        createdAt: new Date(),
        finishedAt: args.data.finishedAt ?? null,
      };
      mem.jobRuns.set(fallback.id, fallback);
      if (!isDatabaseConfigured()) return fallback;
      try {
        const [row] = await drizzleDb
          .insert(jobRuns)
          .values(fallback)
          .returning();
        return row ?? fallback;
      } catch {
        return fallback;
      }
    },

    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const existing = mem.jobRuns.get(args.where.id);
      if (existing) {
        const next = { ...existing, ...args.data };
        if (
          args.data.attempts &&
          typeof args.data.attempts === 'object' &&
          'increment' in (args.data.attempts as Record<string, unknown>)
        ) {
          next.attempts =
            (existing.attempts ?? 0) +
            Number((args.data.attempts as { increment: number }).increment ?? 1);
        }
        mem.jobRuns.set(args.where.id, next);
      }
      if (!isDatabaseConfigured()) {
        return mem.jobRuns.get(args.where.id) ?? { id: args.where.id, ...args.data };
      }
      try {
        const setPayload: Record<string, unknown> = { ...args.data };
        if (
          setPayload.attempts &&
          typeof setPayload.attempts === 'object' &&
          'increment' in (setPayload.attempts as Record<string, unknown>)
        ) {
          const inc = Number((setPayload.attempts as { increment: number }).increment ?? 1);
          setPayload.attempts = sql`${jobRuns.attempts} + ${inc}`;
        }
        const [row] = await drizzleDb
          .update(jobRuns)
          .set(setPayload)
          .where(eq(jobRuns.id, args.where.id))
          .returning();
        return row ?? { id: args.where.id, ...args.data };
      } catch {
        return { id: args.where.id, ...args.data };
      }
    },

    async updateMany(args: { where?: Record<string, unknown>; data: Record<string, unknown> }) {
      if (!isDatabaseConfigured()) {
        let updatedCount = 0;
        for (const [id, job] of mem.jobRuns.entries()) {
          if (matchesWhere(job, args.where)) {
            mem.jobRuns.set(id, { ...job, ...args.data });
            updatedCount++;
          }
        }
        return { count: updatedCount };
      }
      try {
        const cond = buildWhere(jobRuns, args.where);
        const setPayload: Record<string, unknown> = { ...args.data };
        if (
          setPayload.attempts &&
          typeof setPayload.attempts === 'object' &&
          'increment' in (setPayload.attempts as Record<string, unknown>)
        ) {
          const inc = Number((setPayload.attempts as { increment: number }).increment ?? 1);
          setPayload.attempts = sql`${jobRuns.attempts} + ${inc}`;
        }
        const updated = cond
          ? await drizzleDb
              .update(jobRuns)
              .set(setPayload)
              .where(cond)
              .returning({ id: jobRuns.id })
          : await drizzleDb.update(jobRuns).set(setPayload).returning({ id: jobRuns.id });
        return { count: updated.length };
      } catch {
        return { count: 0 };
      }
    },

    async deleteMany(args?: { where?: Record<string, unknown> }) {
      if (!args?.where) {
        const count = mem.jobRuns.size;
        mem.jobRuns.clear();
        if (!isDatabaseConfigured()) return { count };
      }
      if (!isDatabaseConfigured()) return { count: 0 };
      try {
        const cond = buildWhere(jobRuns, args?.where);
        const deleted = cond
          ? await drizzleDb.delete(jobRuns).where(cond).returning({ id: jobRuns.id })
          : await drizzleDb.delete(jobRuns).returning({ id: jobRuns.id });
        return { count: deleted.length };
      } catch {
        return { count: 0 };
      }
    },

    async groupBy(args: { by: ('status' | 'type')[]; _count: { status: boolean } }) {
      if (!isDatabaseConfigured()) return [];
      try {
        if (args.by.includes('type') && args.by.includes('status')) {
          const rows = await drizzleDb
            .select({
              type: jobRuns.type,
              status: jobRuns.status,
              c: count(),
            })
            .from(jobRuns)
            .groupBy(jobRuns.type, jobRuns.status);
          return rows.map((r) => ({
            type: r.type,
            status: r.status,
            _count: { status: Number(r.c) },
          }));
        }
        const rows = await drizzleDb
          .select({
            status: jobRuns.status,
            c: count(),
          })
          .from(jobRuns)
          .groupBy(jobRuns.status);
        return rows.map((r) => ({
          type: '',
          status: r.status,
          _count: { status: Number(r.c) },
        }));
      } catch {
        return [];
      }
    },
  },

  notification: {
    async findMany(args?: { take?: number }) {
      if (!isDatabaseConfigured()) {
        return Array.from(mem.notifications.values())
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args?.take ?? 100);
      }
      try {
        return await drizzleDb
          .select()
          .from(notifications)
          .orderBy(desc(notifications.createdAt))
          .limit(args?.take ?? 100);
      } catch {
        return [];
      }
    },

    async create(args: {
      data: {
        id?: string;
        category?: string;
        severity?: string;
        title: string;
        description?: string;
        source?: string;
        read?: boolean;
        metadataJson?: string;
      };
    }) {
      const item = {
        id: args.data.id ?? newId('ntf'),
        category: args.data.category ?? 'SYSTEM',
        severity: args.data.severity ?? 'INFO',
        title: args.data.title,
        description: args.data.description ?? '',
        source: args.data.source ?? 'runtime',
        read: args.data.read ?? false,
        metadataJson: args.data.metadataJson ?? '{}',
        createdAt: new Date(),
      };
      mem.notifications.set(item.id, item);
      if (!isDatabaseConfigured()) return item;
      try {
        const [row] = await drizzleDb
          .insert(notifications)
          .values(item)
          .returning();
        return row;
      } catch {
        return item;
      }
    },

    async markAllRead() {
      for (const [id, n] of mem.notifications.entries()) {
        mem.notifications.set(id, { ...n, read: true });
      }
      if (!isDatabaseConfigured()) return;
      try {
        await drizzleDb.update(notifications).set({ read: true });
      } catch {
        // Ignore
      }
    },

    async markRead(id: string) {
      const existing = mem.notifications.get(id);
      if (existing) mem.notifications.set(id, { ...existing, read: true });
      if (!isDatabaseConfigured()) return;
      try {
        await drizzleDb
          .update(notifications)
          .set({ read: true })
          .where(eq(notifications.id, id));
      } catch {
        // Ignore
      }
    },

    async deleteMany() {
      mem.notifications.clear();
      if (!isDatabaseConfigured()) return;
      try {
        await drizzleDb.delete(notifications);
      } catch {
        // Ignore
      }
    },
  },
};