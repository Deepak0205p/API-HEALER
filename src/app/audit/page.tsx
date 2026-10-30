import { ControlPlaneApp } from '@/components/healer/control-plane-app';

export const metadata = {
  title: 'Audit Log · API Healer Control Plane',
  description: 'Chronological Firestore audit trail of all system actions, configuration updates, and job retries',
};

export default function AuditRoutePage() {
  return <ControlPlaneApp initialPage="audit" />;
}
