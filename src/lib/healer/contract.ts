/**
 * API-HEALER · Contract system (Zod-backed)
 * ------------------------------------------
 * Converts the declarative ContractDef JSON into a strict Zod schema used for
 * live interception (healerFetch) and canary verification (Loop 2).
 * Also flattens leaf paths for the structural differ and sigma gate.
 */
import { z } from 'zod';
import type { ContractDef, FieldDef } from './types';

/** Leaf paths of the contract, e.g. "order.amount" → FieldDef */
export interface LeafEntry {
  path: string;
  def: FieldDef;
}

/** Flatten nested FieldDef tree into leaf path list (objects recurse). */
export function flattenLeaves(
  fields: Record<string, FieldDef>,
  prefix = '',
): LeafEntry[] {
  const out: LeafEntry[] = [];
  for (const [key, def] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (def.type === 'object' && def.fields) {
      out.push(...flattenLeaves(def.fields, path));
    } else {
      out.push({ path, def });
    }
  }
  return out;
}

const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'object', 'unknown']);

/**
 * Accept every documented "fields" shape and return the canonical nested tree.
 *  1. nested object — { orderId: { type: 'string' }, customer: { type: 'object', fields: {...} } }
 *  2. flat leaf list — [{ path: 'orderId', type: 'string' }, { path: 'customer.id', type: 'string' }]
 * Anything else is a hard error — arrays must NEVER be silently indexed into
 * "0","1","2" garbage leaves (that class of bug heals nothing and lies loudly).
 */
export function normalizeFieldsInput(raw: unknown): Record<string, FieldDef> {
  if (Array.isArray(raw)) {
    const root: Record<string, FieldDef> = {};
    raw.forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`fields[${i}] must be an object like { path, type, mandatory? }`);
      }
      const { path, type, mandatory, unit, fields } = item as Record<string, unknown>;
      if (typeof path !== 'string' || !path.trim()) {
        throw new Error(`fields[${i}] is missing a non-empty "path"`);
      }
      if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
        throw new Error(
          `fields[${i}] ("${path}"): type must be one of string | number | boolean | object | unknown`,
        );
      }
      const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) throw new Error(`fields[${i}]: "path" cannot be empty`);
      let cur = root;
      for (const part of parts.slice(0, -1)) {
        const node = cur[part];
        if (node && (node.type !== 'object' || !node.fields)) {
          throw new Error(`fields[${i}]: "${part}" in "${path}" conflicts with an existing leaf`);
        }
        if (!node) cur[part] = { type: 'object', fields: {} };
        cur = (cur[part] as { fields: Record<string, FieldDef> }).fields;
      }
      const leaf: FieldDef = { type: type as FieldDef['type'] };
      if (mandatory === true) leaf.mandatory = true;
      if (typeof unit === 'string' && unit) leaf.unit = unit;
      if (type === 'object' && fields && typeof fields === 'object' && !Array.isArray(fields)) {
        leaf.fields = normalizeFieldsInput(fields);
      }
      const last = parts[parts.length - 1];
      if (cur[last]) throw new Error(`fields[${i}]: duplicate path "${path}"`);
      cur[last] = leaf;
    });
    return root;
  }
  if (raw && typeof raw === 'object') return raw as Record<string, FieldDef>;
  throw new Error(
    '"fields" must be an object keyed by field name, or an array of { path, type, mandatory? }',
  );
}

/** Parse a ContractDef JSON string with hard validation. */
export function parseContractDef(schemaJson: string): ContractDef {
  const parsed = JSON.parse(schemaJson) as { fields?: unknown };
  if (!parsed || typeof parsed !== 'object' || !('fields' in parsed)) {
    throw new Error('Invalid contract definition: missing "fields"');
  }
  return { fields: normalizeFieldsInput(parsed.fields) };
}

/**
 * Build a strict Zod object schema from a ContractDef.
 * MEMOIZED per ContractDef identity: the runtime contract cache hands every
 * heal the SAME def object, so the schema is constructed once per contract
 * and reused across all traffic (hot-path budget: cached re-heals must not
 * pay schema construction per call).
 */
const zodSchemaCache = new WeakMap<ContractDef, z.ZodType<Record<string, unknown>>>();

export function buildZodSchema(def: ContractDef): z.ZodType<Record<string, unknown>> {
  const cached = zodSchemaCache.get(def);
  if (cached) return cached;
  const schema = buildZodFromFields(def.fields);
  zodSchemaCache.set(def, schema);
  return schema;
}

function buildZodFromFields(fields: Record<string, FieldDef>): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(fields)) {
    shape[key] = buildFieldSchema(field);
  }
  return z.object(shape);
}

function buildFieldSchema(field: FieldDef): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.type) {
    case 'string':
      base = z.string();
      break;
    case 'number':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'object':
      base = field.fields
        ? buildZodFromFields(field.fields)
        : z.record(z.string(), z.unknown());
      break;
    default:
      base = z.unknown();
  }
  return field.mandatory ? base : base.optional();
}

/** Read a nested path "a.b.c" from a JSON object. Returns undefined if absent. */
export function readPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Immutably set a nested path; creates intermediate objects as needed. */
export function setPath<T extends Record<string, unknown>>(
  obj: T,
  path: string,
  value: unknown,
): T {
  const parts = path.split('.');
  const clone = structuredClone(obj) as T;
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = cur[p];
    if (next === null || typeof next !== 'object') {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
}

/** Immutably delete a nested path; returns false when the path was absent. */
export function deletePath(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  const cloneRef = obj;
  let cur: Record<string, unknown> | undefined = cloneRef;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur?.[parts[i]];
    if (next === null || typeof next !== 'object') return false;
    cur = next as Record<string, unknown>;
  }
  if (!cur || !(parts[parts.length - 1] in cur)) return false;
  delete cur[parts[parts.length - 1]];
  return true;
}

/**
 * Canonical numeric coercion used by COERCE — deliberately strict:
 * numeric strings like "499", "499.00", " 499 " coerce; garbage refuses.
 */
export function coerceValue(value: unknown, cast: 'string' | 'number' | 'boolean'): unknown {
  switch (cast) {
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const t = value.trim();
        if (t !== '' && Number.isFinite(Number(t))) return Number(t);
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      return undefined;
    }
    case 'string': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return String(value);
      return undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      return undefined;
    }
  }
}

/** List all numeric leaf paths of a payload (used by history + sigma gate). */
export function numericLeaves(obj: unknown, prefix = ''): { path: string; value: number }[] {
  const out: { path: string; value: number }[] = [];
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number' && Number.isFinite(obj)) {
    if (prefix) out.push({ path: prefix, value: obj });
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out.push(...numericLeaves(v, prefix ? `${prefix}.${k}` : k));
    }
  }
  return out;
}
