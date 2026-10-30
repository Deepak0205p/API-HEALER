import {
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  orderBy,
  limit,
} from 'firebase/firestore';
import { db } from './firebase';

export type AuditCategory = 'SYSTEM_ACTION' | 'CONFIG_CHANGE' | 'JOB_RETRY';
export type AuditStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface AuditLogEntry {
  id: string;
  action: string;
  category: AuditCategory;
  details: string;
  target?: string;
  status: AuditStatus;
  performedByUid?: string;
  performedByEmail?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NewAuditLogInput {
  action: string;
  category: AuditCategory;
  details: string;
  target?: string;
  status?: AuditStatus;
  performedByUid?: string;
  performedByEmail?: string;
  metadata?: Record<string, unknown>;
}

export function handleFirestoreError(error: unknown, operation: string) {
  const err = error as { code?: string; message?: string };
  const code = err?.code || 'UNKNOWN';
  const rawMessage = err?.message || 'Operation failed';

  let userFriendly = 'An unexpected Firestore error occurred.';
  if (code === 'permission-denied') {
    userFriendly = 'Permission denied: Please ensure you are authenticated and rules permit this action.';
  } else if (code === 'unavailable') {
    userFriendly = 'Firestore service is currently unreachable or offline. Checking connection...';
  } else if (code === 'not-found') {
    userFriendly = 'Requested document or collection was not found.';
  }

  console.error(`[Firestore Error] ${operation} (${code}):`, rawMessage);

  return {
    error: true,
    code,
    message: userFriendly,
    raw: rawMessage,
  };
}

/**
 * Record an immutable audit log entry into Firestore.
 * Always sets strict schema fields with createdAt timestamp.
 */
export async function recordAuditLog(input: NewAuditLogInput): Promise<AuditLogEntry> {
  const logRef = doc(collection(db, 'audit_logs'));
  const entry: AuditLogEntry = {
    id: logRef.id,
    action: input.action.trim(),
    category: input.category,
    details: input.details.trim(),
    target: input.target || 'system',
    status: input.status || 'SUCCESS',
    performedByUid: input.performedByUid || 'system',
    performedByEmail: input.performedByEmail || 'system@api-healer.internal',
    metadata: input.metadata || {},
    createdAt: new Date().toISOString(),
  };

  try {
    await setDoc(logRef, entry);
    return entry;
  } catch (error) {
    handleFirestoreError(error, 'recordAuditLog');
    throw error;
  }
}

/**
 * Fetch initial / snapshot audit logs from Firestore.
 */
export async function fetchRecentAuditLogs(max = 100): Promise<AuditLogEntry[]> {
  try {
    const q = query(
      collection(db, 'audit_logs'),
      orderBy('createdAt', 'desc'),
      limit(max),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<AuditLogEntry, 'id'>),
    }));
  } catch (error) {
    handleFirestoreError(error, 'fetchRecentAuditLogs');
    return [];
  }
}
