'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ExternalLink, ShieldCheck, ShieldX } from 'lucide-react';
import type { FingerprintRow, HotPatchRow, PrRow } from './ui-types';

function ttlLabel(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ColdPath({
  hotPatches,
  fingerprints,
  prs,
  onRevoke,
}: {
  hotPatches: HotPatchRow[];
  fingerprints: FingerprintRow[];
  prs: PrRow[];
  onRevoke: (id: string) => void;
}) {
  const [openPr, setOpenPr] = useState<string | null>(null);
  const selectedPr = prs.find((p) => p.id === openPr);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card">
      <Tabs defaultValue="hot" className="flex flex-1 flex-col gap-0">
        <div className="flex items-center justify-between overflow-x-auto border-b border-border px-4 py-2.5">
          <TabsList className="h-8 bg-muted p-0.5">
            <TabsTrigger value="hot" className="h-7 px-3 text-xs data-[state=active]:bg-card">
              Hot Patches ({hotPatches.length})
            </TabsTrigger>
            <TabsTrigger value="fp" className="h-7 px-3 text-xs data-[state=active]:bg-card">
              Fingerprints ({fingerprints.length})
            </TabsTrigger>
            <TabsTrigger value="pr" className="h-7 px-3 text-xs data-[state=active]:bg-card">
              Pull Requests ({prs.length})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="hot" className="mt-0 flex-1">
          <ScrollArea className="h-[440px]">
            <div className="divide-y divide-border/60">
              {hotPatches.length === 0 && (
                <p className="px-4 py-12 text-center text-xs text-muted-foreground">
                  No active hot patches.
                </p>
              )}
              {hotPatches.map((h) => (
                <div
                  key={h.signature}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-xs hover:bg-accent/50"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-foreground">
                      {h.signature.slice(0, 16)}…
                    </span>
                    <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                      <span>{h.opsSummary} ops</span>
                      <span aria-hidden="true">·</span>
                      <span>{h.hits} hits</span>
                      <span aria-hidden="true">·</span>
                      <span>{h.composer}</span>
                    </div>
                  </div>
                  <div className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                    <div>TTL {ttlLabel(h.ttlRemainingMs)}</div>
                    <div className="text-muted-foreground/80">{(h.confidence * 100).toFixed(0)}%</div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="fp" className="mt-0 flex-1">
          <ScrollArea className="h-[440px]">
            <div className="divide-y divide-border/60">
              {fingerprints.length === 0 && (
                <p className="px-4 py-12 text-center text-xs text-muted-foreground">
                  No fingerprints recorded.
                </p>
              )}
              {fingerprints.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-xs hover:bg-accent/50"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-foreground">
                        {f.signature.slice(0, 16)}…
                      </span>
                      <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                      <span className="truncate text-muted-foreground">{f.contract?.name}</span>
                    </div>
                    {f.opsSummary && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {f.opsSummary}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
                    <span>{f.hits} hits</span>
                    <span>{f.status}</span>
                    {f.status === 'ACTIVE' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
                        onClick={() => onRevoke(f.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="pr" className="mt-0 flex-1">
          <ScrollArea className="h-[440px]">
            <div className="divide-y divide-border/60">
              {prs.length === 0 && (
                <p className="px-4 py-12 text-center text-xs text-muted-foreground">
                  No pull requests generated yet.
                </p>
              )}
              {prs.map((p) => (
                <div key={p.id} className="transition-colors hover:bg-accent/50">
                  <button
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                    onClick={() => setOpenPr(openPr === p.id ? null : p.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-foreground">
                        #{p.number} {p.title}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {p.contract?.name} · {p.branch}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {p.mode}
                    </span>
                  </button>
                  {openPr === p.id && (
                    <div className="border-t border-border bg-muted/30 px-4 py-3">
                      <pre className="max-h-52 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
                        {p.diffText}
                      </pre>
                      {p.url && (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> Open on GitHub
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {selectedPr && (
        <div className="border-t border-border px-4 py-2.5">
          <div className="space-y-1">
            {(JSON.parse(selectedPr.canaryLogJson) as { check: string; passed: boolean; detail: string }[]).map(
              (c) => (
                <div key={c.check} className="flex items-center gap-2 text-xs">
                  {c.passed ? (
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <ShieldX className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />
                  )}
                  <span className="font-mono text-foreground">{c.check}</span>
                  <span className="truncate text-muted-foreground">{c.detail}</span>
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
