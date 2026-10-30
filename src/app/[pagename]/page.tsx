import { notFound, redirect } from 'next/navigation';
import { ControlPlaneApp } from '@/components/healer/control-plane-app';
import { isValidPageId } from '@/lib/healer/route-utils';

export default async function DynamicControlPlanePage({
  params,
}: {
  params: Promise<{ pagename: string }>;
}) {
  const { pagename } = await params;
  const normalized = pagename.toLowerCase();

  if (normalized === 'home') {
    redirect('/');
  }

  if (!isValidPageId(normalized)) {
    notFound();
  }

  return <ControlPlaneApp initialPage={normalized} />;
}
