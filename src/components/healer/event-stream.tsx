'use client';

import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CircleCheck, Zap, ShieldAlert, Undo2 } from 'lucide-react';
import { statusStyle, type EventRow } from './ui-types';

const STATUS_ICON: Record<string, React.ReactNode> = {
  PASSTHROUGH: <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />,
  HEALED_COLD: <Zap className="h-3.5 w-3.5 shrink-0 text-foreground" />,
  HEALED_CACHED: <Zap className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />,
  REFUSED: <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />,
  ROLLED_BACK: <Undo2 className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />,
  ERROR: <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />,
};

const STATUS_TEXT_COLOR: Record<string, string> = {
  PASSTHROUGH: 'text-emerald-700 dark:text-emerald-400',
  HEALED_COLD: 'text-foreground',
  HEALED_CACHED: 'text-emerald-700 dark:text-emerald-400',
  REFUSED: 'text-rose-700 dark:text-rose-400',
  ROLLED_BACK: 'text-amber-700 dark:text-amber-400',
  ERROR: 'text-rose-700 dark:text-rose-400',
};

export function EventStream({
  events,
  selectedId,
  onSelect,
}: {
  events: EventRow[];
  selectedId?: string | null;
  onSelect: (e: EventRow) => void;
}) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Requests</h3>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {events.length}
        </span>
      </div>

      <ScrollArea className="h-[460px] flex-1">
        <div className="divide-y divide-border/60">
          {events.length === 0 && (
            <p className="px-4 py-12 text-center text-xs text-muted-foreground">
              No requests recorded yet.
            </p>
          )}
          {events.map((e, idx) => {
            const st = statusStyle(e.status);
            const selected = selectedId && e.eventId === selectedId;
            return (
              <button
                key={e.eventId ?? `${e.signature}-${idx}`}
                onClick={() => onSelect(e)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/60',
                  selected && 'bg-accent hover:bg-accent',
                )}
              >
                {STATUS_ICON[e.status] ?? STATUS_ICON.ERROR}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-foreground">
                      {e.contractName}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 whitespace-nowrap font-mono text-[11px] font-medium',
                        STATUS_TEXT_COLOR[e.status] ?? 'text-muted-foreground',
                      )}
                    >
                      {st.label}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                    <span>{e.driftType}</span>
                    <span aria-hidden="true">·</span>
                    <span>{e.timing.totalMs.toFixed(1)}ms</span>
                    {e.composer !== 'none' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{e.composer}</span>
                      </>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
