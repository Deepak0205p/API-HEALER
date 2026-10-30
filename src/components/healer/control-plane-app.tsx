'use client';

/**
 * API-HEALER · Control Plane Direct Dashboard Access (Demo Ready)
 */
import { HealerProvider, useHealer, type PageId } from '@/components/healer/store';
import { AppShell } from '@/components/healer/app-shell';
import { HomePage } from '@/components/healer/pages/home-page';
import { PlaygroundPage } from '@/components/healer/pages/playground-page';
import { ColdPathPage } from '@/components/healer/pages/cold-path-page';
import { ContractsPage } from '@/components/healer/pages/contracts-page';
import { WorkersPage } from '@/components/healer/pages/workers-page';
import { IntegratePage } from '@/components/healer/pages/integrate-page';
import { AuditPage } from '@/components/healer/pages/audit-page';

export function ControlPlaneApp({ initialPage = 'home' }: { initialPage?: PageId }) {
  return (
    <HealerProvider initialPage={initialPage}>
      <AppShell>
        <PageBody />
      </AppShell>
    </HealerProvider>
  );
}

/** Renders the active page — keyed by route so each page animates in fresh. */
function PageBody() {
  const { page } = useHealer();
  switch (page) {
    case 'playground':
      return <PlaygroundPage />;
    case 'cold-path':
      return <ColdPathPage />;
    case 'contracts':
      return <ContractsPage />;
    case 'workers':
      return <WorkersPage />;
    case 'integrate':
      return <IntegratePage />;
    case 'audit':
      return <AuditPage />;
    default:
      return <HomePage />;
  }
}
