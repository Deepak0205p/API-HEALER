'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus } from 'lucide-react';
import { useHealer } from '../store';
import { ContractsPanel } from '../contracts-panel';
import { PageHeader } from '../app-shell';

export function ContractsPage() {
  const { loading, contracts, refreshContracts, openConnect } = useHealer();

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-48 rounded-lg" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          contracts.length > 0 ? (
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
              onClick={openConnect}
            >
              <Plus className="h-3.5 w-3.5" /> New Contract
            </Button>
          ) : undefined
        }
      />

      {contracts.length === 0 ? (
        <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No contracts registered</p>
          <div className="mt-4">
            <Button
              size="sm"
              className="h-8 gap-1.5 bg-primary px-3.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              onClick={openConnect}
            >
              <Plus className="h-3.5 w-3.5" /> New Contract
            </Button>
          </div>
        </div>
      ) : (
        <ContractsPanel contracts={contracts} onRefresh={() => void refreshContracts()} />
      )}
    </div>
  );
}
