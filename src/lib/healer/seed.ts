/**
 * API-HEALER · Seed: install the three protected contracts + warm baselines
 */
import { db } from '@/lib/db';
import {
  CHECKOUT_DEF,
  CHECKOUT_BASE,
  CHECKOUT_HISTORY,
  EINVOICE_DEF,
  EINVOICE_BASE,
  EINVOICE_HISTORY,
  LOGISTICS_DEF,
  LOGISTICS_BASE,
  LOGISTICS_HISTORY,
} from './scenarios';
import type { ContractKey } from './scenarios';

function mandatoryPaths(def: unknown): string[] {
  const out: string[] = [];
  const walk = (fields: Record<string, { mandatory?: boolean; fields?: Record<string, unknown> }>, prefix: string) => {
    for (const [k, f] of Object.entries(fields)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (f.mandatory) out.push(path);
      if (f.fields) walk(f.fields as never, path);
    }
  };
  walk((def as { fields: never }).fields, '');
  return out;
}

export const CONTRACT_KEYS: Record<ContractKey, string> = {
  checkout: 'D2C Checkout · Payments API',
  einvoice: 'GSTN E-Invoice · Tax Portal',
  logistics: 'Shiprocket · Logistics Webhook',
};

export interface SeedReport {
  contracts: { key: string; id: string; name: string; endpoint: string }[];
  warmup: { key: string; status: string; totalMs: number }[];
}

export async function seedContracts(): Promise<SeedReport> {
  const defs: { key: ContractKey; name: string; endpoint: string; def: unknown; base: Record<string, unknown>; history: Record<string, number[]>; defaults: Record<string, unknown>; mandatory: string[] }[] = [
    {
      key: 'checkout',
      name: CONTRACT_KEYS.checkout,
      endpoint: 'https://gateway.partner-api.in/v2/checkout',
      def: CHECKOUT_DEF,
      base: CHECKOUT_BASE,
      history: CHECKOUT_HISTORY,
      defaults: { paymentMethod: 'UPI' },
      mandatory: mandatoryPaths(CHECKOUT_DEF),
    },
    {
      key: 'einvoice',
      name: CONTRACT_KEYS.einvoice,
      endpoint: 'https://einvoice.gstportal.gov.in/v1/einvoice',
      def: EINVOICE_DEF,
      base: EINVOICE_BASE,
      history: EINVOICE_HISTORY,
      defaults: {},
      mandatory: mandatoryPaths(EINVOICE_DEF),
    },
    {
      key: 'logistics',
      name: CONTRACT_KEYS.logistics,
      endpoint: 'https://webhooks.shiprocket.in/v1/status',
      def: LOGISTICS_DEF,
      base: LOGISTICS_BASE,
      history: LOGISTICS_HISTORY,
      defaults: {},
      mandatory: mandatoryPaths(LOGISTICS_DEF),
    },
  ];

  const contracts: SeedReport['contracts'] = [];
  for (const d of defs) {
    const row = await db.contract.upsert({
      where: { endpoint: d.endpoint },
      create: {
        name: d.name,
        endpoint: d.endpoint,
        method: 'POST',
        schemaJson: JSON.stringify(d.def),
        mandatoryJson: JSON.stringify(d.mandatory),
        defaultsJson: JSON.stringify(d.defaults),
        historyJson: JSON.stringify(d.history),
        enabled: true,
      },
      update: {
        name: d.name,
        schemaJson: JSON.stringify(d.def),
        mandatoryJson: JSON.stringify(d.mandatory),
        defaultsJson: JSON.stringify(d.defaults),
        historyJson: JSON.stringify(d.history),
      },
    });
    contracts.push({ key: d.key, id: row.id, name: row.name, endpoint: row.endpoint });
  }

  return { contracts, warmup: [] };
}

export async function getContractByKey(key: ContractKey) {
  const endpoints: Record<ContractKey, string> = {
    checkout: 'https://gateway.partner-api.in/v2/checkout',
    einvoice: 'https://einvoice.gstportal.gov.in/v1/einvoice',
    logistics: 'https://webhooks.shiprocket.in/v1/status',
  };
  return db.contract.findUnique({ where: { endpoint: endpoints[key] } });
}
