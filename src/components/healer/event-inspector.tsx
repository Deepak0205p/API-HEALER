'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { ShieldCheck, ShieldX, FileDiff } from 'lucide-react';
import { statusStyle, type EventRow } from './ui-types';
import { JsonDiff } from './json-diff';

function opLabel(op: Record<string, unknown>): string {
  switch (op.op) {
    case 'RENAME':
      return `RENAME ${op.from} → ${op.to}`;
    case 'MOVE':
      return `MOVE ${op.from} → ${op.to}`;
    case 'COERCE':
      return `COERCE ${op.path} : ${op.cast}`;
    case 'DEFAULT':
      return `DEFAULT ${op.path} = ${JSON.stringify(op.value)}`;
    default:
      return JSON.stringify(op);
  }
}

export function EventInspector({ event }: { event: EventRow | null }) {
  if (!event) {
    return (
      <div className="flex h-full min-h-[460px] flex-col items-center justify-center rounded-lg border border-border bg-card text-center">
        <FileDiff className="mb-2.5 h-6 w-6 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">Select a request to inspect</p>
      </div>
    );
  }

  const st = statusStyle(event.status);
  const raw = event.rawPayload ?? {};
  const served = event.servedPayload ?? {};
  const timing = event.timing;
  const maxPhase = Math.max(timing.classifyMs, timing.composeMs, timing.gatesMs, 0.001);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {event.contractName}
          </span>
          <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">·</span>
          <span className="shrink-0 whitespace-nowrap font-mono text-xs font-medium text-foreground/80">
            {st.label}
          </span>
          {event.endpoint && (
            <>
              <span className="hidden shrink-0 text-muted-foreground/40 sm:inline" aria-hidden="true">·</span>
              <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
                {event.endpoint}
              </span>
            </>
          )}
        </div>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
          {timing.totalMs.toFixed(2)}ms
        </span>
      </div>

      <ScrollArea className="max-h-[540px] flex-1">
        <div className="space-y-5 p-4">
          {event.message && (
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {event.message}
            </p>
          )}

          {event.plan && event.plan.ops.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-foreground">Transformation Plan</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {event.plan.composer} · {(event.plan.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {event.plan.ops.map((op, i) => (
                  <span
                    key={i}
                    className="rounded border border-border bg-muted/60 px-2.5 py-1 font-mono text-xs text-foreground"
                  >
                    {opLabel(op as Record<string, unknown>)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <JsonDiff raw={raw} served={served} />

          {event.gates && (
            <div>
              <div className="mb-2 text-xs font-semibold text-foreground">
                Validation Gates
              </div>
              <div className="divide-y divide-border rounded-md border border-border">
                {event.gates.results.map((g) => (
                  <div
                    key={g.gate}
                    className="flex items-start gap-2.5 px-3 py-2.5"
                  >
                    {g.passed ? (
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <ShieldX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-foreground">{g.gate}</span>
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {g.ms}ms
                        </span>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {g.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-semibold text-foreground">Execution Timing</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {timing.totalMs.toFixed(2)}ms
              </span>
            </div>
            <div className="space-y-2">
              {(
                [
                  ['Classify', timing.classifyMs],
                  [event.composer === 'cache' ? 'Cache Lookup' : 'Compose Plan', timing.composeMs],
                  ['Gates', timing.gatesMs],
                ] as const
              ).map(([label, ms]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, (ms / maxPhase) * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {ms.toFixed(2)}ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
