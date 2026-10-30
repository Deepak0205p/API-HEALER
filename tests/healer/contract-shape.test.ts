/**
 * Regression tests for the contract "fields" input shapes.
 * Guards against the silent array-indexing bug where a flat leaf list
 * [{ path: 'orderId', ... }] was stored as garbage leaves "0","1","2".
 */
import { describe, expect, test } from 'bun:test';
import {
  flattenLeaves,
  normalizeFieldsInput,
  parseContractDef,
} from '@/lib/healer/contract';

describe('contract fields normalization', () => {
  test('flat leaf list converts to the nested tree with real paths', () => {
    const fields = normalizeFieldsInput([
      { path: 'orderId', type: 'string', mandatory: true },
      { path: 'amount', type: 'number', mandatory: true, unit: 'INR' },
      { path: 'customer.id', type: 'string' },
      { path: 'customer.tier', type: 'string' },
    ]);
    const paths = flattenLeaves(fields).map((l) => l.path);
    expect(paths).toEqual(['orderId', 'amount', 'customer.id', 'customer.tier']);
    expect(fields.customer.type).toBe('object');
    expect(flattenLeaves(fields).find((l) => l.path === 'amount')?.def.unit).toBe('INR');
  });

  test('flat list with mandatory flags preserves them', () => {
    const leaves = flattenLeaves(
      normalizeFieldsInput([
        { path: 'a', type: 'string', mandatory: true },
        { path: 'b', type: 'string' },
      ]),
    );
    expect(leaves.find((l) => l.path === 'a')?.def.mandatory).toBe(true);
    expect(leaves.find((l) => l.path === 'b')?.def.mandatory).toBeUndefined();
  });

  test('nested object shape passes through unchanged', () => {
    const nested = {
      orderId: { type: 'string', mandatory: true },
      customer: { type: 'object', fields: { id: { type: 'string' } } },
    };
    expect(normalizeFieldsInput(nested)).toEqual(nested);
  });

  test('parseContractDef normalizes a stored flat-list schemaJson', () => {
    const def = parseContractDef(
      JSON.stringify({
        fields: [{ path: 'tracking_id', type: 'string', mandatory: true }],
      }),
    );
    expect(flattenLeaves(def.fields).map((l) => l.path)).toEqual(['tracking_id']);
  });

  test('array item without path is a hard error (no silent indexing)', () => {
    expect(() =>
      normalizeFieldsInput([{ type: 'string', mandatory: true }]),
    ).toThrow(/missing a non-empty "path"/);
  });

  test('array item with unknown type is a hard error', () => {
    expect(() =>
      normalizeFieldsInput([{ path: 'x', type: 'varchar' }]),
    ).toThrow(/type must be one of/);
  });

  test('duplicate paths are rejected', () => {
    expect(() =>
      normalizeFieldsInput([
        { path: 'a', type: 'string' },
        { path: 'a', type: 'string' },
      ]),
    ).toThrow(/duplicate path/);
  });

  test('leaf/object conflict on the same segment is rejected', () => {
    expect(() =>
      normalizeFieldsInput([
        { path: 'customer', type: 'string' },
        { path: 'customer.id', type: 'string' },
      ]),
    ).toThrow(/conflicts with an existing leaf/);
  });

  test('garbage input (string) is a hard error', () => {
    expect(() => normalizeFieldsInput('orderId')).toThrow(/must be an object keyed by field name/);
  });
});
