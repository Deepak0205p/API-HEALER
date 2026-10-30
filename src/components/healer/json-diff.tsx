'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';

type Json = Record<string, unknown>;

type DiffKind = 'same' | 'added' | 'removed' | 'changed';

interface Line {
  indent: number;
  key: string;
  value: string;
  kind: DiffKind;
  isLeaf: boolean;
  comma: boolean;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (v === undefined) return 'undefined';
  return JSON.stringify(v);
}

function flatten(
  obj: Json,
  prefix = '',
  out: Map<string, unknown> = new Map(),
): Map<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.set(path, '__object__');
      flatten(v as Json, path, out);
    } else {
      out.set(path, v);
    }
  }
  return out;
}

function buildLines(raw: Json, served: Json): Line[] {
  const a = flatten(raw);
  const b = flatten(served);
  const paths = [...new Set([...a.keys(), ...b.keys()])];

  const ordered: string[] = [];
  const seen = new Set<string>();
  const walkOrder = (o: Json, prefix: string) => {
    for (const k of Object.keys(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (seen.has(path)) continue;
      seen.add(path);
      ordered.push(path);
      const v = o[k];
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walkOrder(v as Json, path);
      }
    }
  };
  walkOrder(raw, '');
  for (const p of paths) if (!seen.has(p)) ordered.push(p);

  const lines: Line[] = [];

  for (const path of ordered) {
    const inA = a.has(path);
    const inB = b.has(path);
    const va = a.get(path);
    const vb = b.get(path);
    const key = path.split('.').pop() ?? path;
    const indent = path.split('.').length - 1;

    let kind: DiffKind = 'same';
    if (!inA) kind = 'added';
    else if (!inB) kind = 'removed';
    else if (va === '__object__' && vb === '__object__') kind = 'same';
    else if (typeOf(va) !== typeOf(vb)) kind = 'changed';
    else if (JSON.stringify(va) !== JSON.stringify(vb)) kind = 'changed';

    if (va === '__object__' || vb === '__object__') {
      lines.push({
        indent,
        key,
        value: '{…}',
        kind: 'same',
        isLeaf: false,
        comma: false,
      });
    } else {
      lines.push({
        indent,
        key,
        value: fmt(inB ? vb : va),
        kind,
        isLeaf: true,
        comma: true,
      });
    }
  }
  return lines;
}

const KIND_STYLES: Record<DiffKind, string> = {
  same: 'text-muted-foreground',
  added: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/50',
  removed: 'text-rose-600 bg-rose-50 line-through decoration-rose-400 dark:text-rose-300 dark:bg-rose-950/50',
  changed: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/50',
};

export function JsonDiff({
  raw,
  served,
  className,
}: {
  raw: Json;
  served: Json;
  className?: string;
}) {
  const lines = useMemo(() => buildLines(raw, served), [raw, served]);
  const identical = useMemo(
    () => JSON.stringify(raw) === JSON.stringify(served),
    [raw, served],
  );

  return (
    <div className={cn('rounded-lg border border-border bg-muted/40 font-mono text-xs leading-5', className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Payload Diff</span>
        {identical ? (
          <span className="text-emerald-700 dark:text-emerald-400">Identical</span>
        ) : (
          <span className="flex gap-2.5 text-[10px]">
            <span className="text-emerald-700 dark:text-emerald-400">+added</span>
            <span className="text-amber-700 dark:text-amber-400">~changed</span>
            <span className="text-rose-600 dark:text-rose-400">-removed</span>
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto p-3">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn('whitespace-pre rounded px-1', KIND_STYLES[l.kind])}
            style={{ paddingLeft: `${l.indent * 14 + 4}px` }}
          >
            <span className="text-foreground">{l.key}</span>
            <span className="text-muted-foreground">: </span>
            <span>{l.value}</span>
            {l.comma ? ',' : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
