'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { ContractRow } from './ui-types';

export function ContractsPanel({
  contracts,
  onRefresh,
}: {
  contracts: ContractRow[];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const patch = async (id: string, data: Record<string, unknown>, okMsg: string) => {
    setBusy(id);
    try {
      await fetch('/api/contracts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...data }),
      });
      toast.success(okMsg);
      onRefresh();
    } catch {
      toast.error('Update failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, name: string) => {
    setBusy(id);
    try {
      await fetch(`/api/contracts?id=${id}`, { method: 'DELETE' });
      toast.success(`Deleted ${name}`);
      setConfirmDelete(null);
      onRefresh();
    } catch {
      toast.error('Delete failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {contracts.map((c) => (
        <div
          key={c.id}
          className="flex min-w-0 flex-col justify-between rounded-lg border border-border bg-card p-4"
        >
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-foreground">{c.name}</h4>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {c.method} {c.endpoint.replace(/^https?:\/\//, '')}
                </p>
              </div>
              <Switch
                checked={c.enabled}
                disabled={busy === c.id}
                onCheckedChange={(v) =>
                  patch(c.id, { enabled: v }, v ? 'Contract enabled' : 'Contract paused')
                }
              />
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Fields ({c.leaves.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {c.leaves.slice(0, 10).map((l) => (
                    <span
                      key={l.path}
                      className={cn(
                        'rounded border px-1.5 py-0.5 font-mono text-[11px]',
                        l.mandatory
                          ? 'border-border bg-accent font-medium text-foreground'
                          : 'border-border/70 bg-muted/40 text-muted-foreground',
                      )}
                    >
                      {l.path}
                      {l.mandatory ? '*' : ''}
                    </span>
                  ))}
                  {c.leaves.length > 10 && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      +{c.leaves.length - 10}
                    </span>
                  )}
                </div>
              </div>

              {Object.keys(c.defaults).length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Defaults</p>
                  <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-muted-foreground">
                    {Object.entries(c.defaults).map(([k, v]) => (
                      <span key={k} className="rounded border border-border bg-muted/40 px-1.5 py-0.5">
                        {k}={JSON.stringify(v)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2 border-t border-border/60 pt-3 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span>{c.counts.driftEvents} events</span>
            <span aria-hidden="true">·</span>
            <span>{c.counts.fingerprints} hashes</span>
            <span aria-hidden="true">·</span>
            <span>{c.counts.pullRequests} PRs</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              disabled={busy === c.id}
              onClick={() => patch(c.id, { resetHistory: true }, 'Baseline reset')}
            >
              <RotateCcw className="h-3 w-3" /> Reset
            </Button>
            {confirmDelete === c.id ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 bg-rose-500/10 px-2 text-[11px] text-rose-600 hover:bg-rose-500/20 dark:text-rose-400"
                disabled={busy === c.id}
                onClick={() => void remove(c.id, c.name)}
              >
                Confirm
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                disabled={busy === c.id}
                onClick={() => {
                  setConfirmDelete(c.id);
                  setTimeout(() => setConfirmDelete((d) => (d === c.id ? null : d)), 3000);
                }}
                aria-label={`Delete ${c.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
