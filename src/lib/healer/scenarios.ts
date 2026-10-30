/**
 * API-HEALER · Scenario library
 * ------------------------------
 * Deterministic "upstream partner drift" mutators mirroring the three
 * high-stakes Indian case studies plus op-by-op demos. Each scenario takes
 * the contract's healthy base payload and returns the drifted payload the
 * firewall will intercept.
 */
import type { ContractDef } from './types';

// ─── Contract definitions (seeded) ─────────────────────────────────────────

export const CHECKOUT_DEF: ContractDef = {
  fields: {
    orderId: { type: 'string', mandatory: true },
    amount: { type: 'number', mandatory: true, unit: '₹ Rupees' },
    currency: { type: 'string', mandatory: true },
    paymentMethod: { type: 'string' },
  },
};

export const CHECKOUT_BASE = {
  orderId: 'ORD-2026-8841',
  amount: 499,
  currency: 'INR',
  paymentMethod: 'UPI',
};

export const EINVOICE_DEF: ContractDef = {
  fields: {
    invoiceNo: { type: 'string', mandatory: true },
    ShipDtls: {
      type: 'object',
      mandatory: true,
      fields: {
        Gstin: { type: 'string', mandatory: true, unit: 'GSTIN' },
        LegalName: { type: 'string', mandatory: true },
        Pincode: { type: 'number' },
      },
    },
    TotalInvoiceValue: { type: 'number', mandatory: true, unit: '₹ Rupees' },
  },
};

export const EINVOICE_BASE = {
  invoiceNo: 'INV-GSTN-77031',
  ShipDtls: {
    Gstin: '29AAECM1234F1Z5',
    LegalName: 'Mega Minds Retail Pvt Ltd',
    Pincode: 560001,
  },
  TotalInvoiceValue: 12499,
};

export const LOGISTICS_DEF: ContractDef = {
  fields: {
    awb: { type: 'string', mandatory: true },
    status: { type: 'string', mandatory: true },
    logistics: {
      type: 'object',
      fields: {
        current_status: { type: 'string' },
        carrier: { type: 'string' },
      },
    },
  },
};

export const LOGISTICS_BASE = {
  awb: 'SR-118-22945',
  status: 'IN_TRANSIT',
  logistics: {},
};

/** Rolling numeric history seeds — simulates weeks of healthy traffic. */
export const CHECKOUT_HISTORY = {
  amount: [429, 499, 549, 649, 399, 799, 459, 899, 499, 599, 529, 479],
};

export const EINVOICE_HISTORY = {
  TotalInvoiceValue: [9800, 12499, 11050, 14300, 8999, 12999, 10250, 15200],
  'ShipDtls.Pincode': [560001, 400001, 110001, 600001, 500001, 560034],
};

export const LOGISTICS_HISTORY = {};

// ─── Scenarios ─────────────────────────────────────────────────────────────

export type ContractKey = 'checkout' | 'einvoice' | 'logistics';

export interface Scenario {
  id: string;
  contractKey: ContractKey;
  name: string;
  /** The DSL/drift class being demonstrated */
  tag: string;
  description: string;
  expected: string;
  mutate: (base: Record<string, unknown>) => Record<string, unknown>;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'healthy',
    contractKey: 'checkout',
    name: 'Healthy Checkout',
    tag: 'PASSTHROUGH',
    description: 'Baseline D2C checkout payload from the payment gateway.',
    expected: 'Validated & served untouched — classify only (~1ms)',
    mutate: (b) => ({ ...b }),
  },
  {
    id: 'paise-spike',
    contractKey: 'checkout',
    name: 'Diwali Paise Spike',
    tag: '4.5σ SPIKE',
    description:
      'Diwali 2 AM rush: gateway returns Paise (49900) instead of Rupees (499) — the 100× unit bug.',
    expected: '4.5σ Z-Gate vetoes → 2ms auto-rollback to last-known-good. ₹10L+ saved.',
    mutate: (b) => ({ ...b, amount: 49900 }),
  },
  {
    id: 'type-drift',
    contractKey: 'checkout',
    name: 'Amount Type Drift',
    tag: 'COERCE',
    description: 'Gateway starts sending amount as a string ("499") after a framework upgrade.',
    expected: 'COERCE amount:number heals in <650ms; repeat breaks hit the 0.8ms fingerprint cache.',
    mutate: (b) => ({ ...b, amount: String(b.amount) }),
  },
  {
    id: 'key-rename',
    contractKey: 'checkout',
    name: 'Silent Key Rename',
    tag: 'RENAME',
    description: 'Partner renames orderId → order_id in a "non-breaking" API v2 release.',
    expected: 'Deterministic classifier matches fuzzy key → RENAME heals sub-second.',
    mutate: (b) => {
      const { orderId, ...rest } = b as { orderId: string };
      return { ...rest, order_id: orderId };
    },
  },
  {
    id: 'optional-default',
    contractKey: 'checkout',
    name: 'Optional Field Gap',
    tag: 'DEFAULT',
    description: 'paymentMethod disappears from the payload; contract has a whitelisted safe default.',
    expected: 'DEFAULT fills the optional gap — mandatory fields would be refused instead.',
    mutate: (b) => {
      const { paymentMethod, ...rest } = b as { paymentMethod?: string };
      return rest;
    },
  },
  {
    id: 'gstn-missing',
    contractKey: 'einvoice',
    name: 'GSTN E-Invoice Missing Gstin',
    tag: 'REFUSAL',
    description:
      'GST portal advisory drops ShipDtls.Gstin. Mandatory field — hallucinating tax data is forbidden.',
    expected: 'Missing-Data Refusal Gate blocks heal → last-known-good served + engineer alert + PR.',
    mutate: (b) => ({
      ...b,
      ShipDtls: Object.fromEntries(
        Object.entries((b as { ShipDtls: Record<string, unknown> }).ShipDtls).filter(
          ([k]) => k !== 'Gstin',
        ),
      ),
    }),
  },
  {
    id: 'webhook-move',
    contractKey: 'logistics',
    name: 'Shiprocket Webhook Drift',
    tag: 'MOVE',
    description:
      'Webhook schema drift: status relocated to logistics.current_status inside the carrier payload.',
    expected: 'MOVE extracts the nested field cold; sibling routes re-heal in 0.8ms via SQLite.',
    mutate: (b) => {
      const { status, ...rest } = b as { status: string; logistics: Record<string, unknown> };
      return { ...rest, logistics: { ...(rest.logistics ?? {}), current_status: status } };
    },
  },
  {
    id: 'ambiguous-drift',
    contractKey: 'logistics',
    name: 'Novel Ambiguous Drift (LLM tier)',
    tag: 'LLM',
    description:
      'Three similar keys appear at once (statusDetail, status_code, latest_status). Deterministic confidence < 85% — escalates to the LLM composer, whose plan still faces all 3 gates.',
    expected: 'LLM disambiguation under gate supervision — or a safe refusal if it cannot prove ≥85%.',
    mutate: (b) => {
      const { status, ...rest } = b as { status: string };
      return {
        ...rest,
        statusDetail: `shipment ${status.toLowerCase()}`,
        status_code: status.slice(0, 3),
        latest_status: status,
      };
    },
  },
];
