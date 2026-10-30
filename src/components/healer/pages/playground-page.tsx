'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useHealer } from '../store';
import { Playground } from '../playground';
import { PageHeader } from '../app-shell';

export function PlaygroundPage() {
  const {
    loading,
    contracts,
    allowLlm,
    setAllowLlm,
    selected,
    selectEvent,
    refreshContracts,
    openConnect,
    navigate,
  } = useHealer();

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-14 w-full rounded-lg" />
        <div className="grid gap-6 lg:grid-cols-12">
          <Skeleton className="h-[540px] rounded-lg lg:col-span-5" />
          <Skeleton className="h-[540px] rounded-lg lg:col-span-7" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader />

      <Playground
        contracts={contracts}
        allowLlm={allowLlm}
        onAllowLlmChange={setAllowLlm}
        onOpenConnect={openConnect}
        selectedEvent={selected}
        onNavigateColdPath={() => navigate('cold-path')}
        onResult={(r) => {
          selectEvent(r);
          void refreshContracts();
        }}
      />
    </div>
  );
}
