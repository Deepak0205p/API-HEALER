'use client';

import { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
} from 'firebase/firestore';
import {
  ScrollText,
  Search,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Copy,
  Check,
  Download,
  PlusCircle,
  Database,
  User,
  Bot,
  AlertCircle,
} from 'lucide-react';
import { db } from '@/lib/firebase';
import {
  recordAuditLog,
  handleFirestoreError,
  type AuditLogEntry,
  type AuditCategory,
  type AuditStatus,
} from '@/lib/audit';
import { useHealer } from '../store';
import { PageHeader } from '../app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import firebaseConfig from '../../../../firebase-applet-config.json';

export function AuditPage() {
  const { authUser } = useHealer();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<AuditCategory | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<AuditStatus | 'ALL'>('ALL');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [inspectLog, setInspectLog] = useState<AuditLogEntry | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isTestModalOpen, setIsTestModalOpen] = useState(false);
  const [isSubmittingTest, setIsSubmittingTest] = useState(false);

  // Form state for creating test audit entries
  const [testAction, setTestAction] = useState('CUSTOM_OPERATOR_ACTION');
  const [testCategory, setTestCategory] = useState<AuditCategory>('SYSTEM_ACTION');
  const [testTarget, setTestTarget] = useState('system:gateway');
  const [testDetails, setTestDetails] = useState('Manual verification audit entry dispatched from UI');
  const [testStatus, setTestStatus] = useState<AuditStatus>('SUCCESS');

  // Real-time Firestore subscription
  useEffect(() => {
    const q = query(
      collection(db, 'audit_logs'),
      orderBy('createdAt', sortOrder),
      limit(200),
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items: AuditLogEntry[] = [];
        snapshot.forEach((doc) => {
          items.push({
            id: doc.id,
            ...(doc.data() as Omit<AuditLogEntry, 'id'>),
          });
        });
        setLogs(items);
        setLoading(false);
        setErrorInfo(null);
      },
      (err) => {
        const formatted = handleFirestoreError(err, 'audit_logs listener');
        setErrorInfo(formatted.message);
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, [sortOrder]);

  const handleManualRefresh = async () => {
    try {
      setLoading(true);
      const q = query(
        collection(db, 'audit_logs'),
        orderBy('createdAt', sortOrder),
        limit(200),
      );
      const snap = await getDocs(q);
      const items: AuditLogEntry[] = [];
      snap.forEach((doc) => {
        items.push({
          id: doc.id,
          ...(doc.data() as Omit<AuditLogEntry, 'id'>),
        });
      });
      setLogs(items);
      setErrorInfo(null);
      toast.success('Audit trail refreshed from Firestore');
    } catch (err) {
      const formatted = handleFirestoreError(err, 'Manual Refresh');
      setErrorInfo(formatted.message);
      toast.error('Failed to sync Firestore audit logs');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTestEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testAction.trim() || !testDetails.trim()) {
      toast.error('Action and Details are required');
      return;
    }
    setIsSubmittingTest(true);
    try {
      await recordAuditLog({
        action: testAction.trim(),
        category: testCategory,
        details: testDetails.trim(),
        target: testTarget.trim() || 'system:manual',
        status: testStatus,
        performedByUid: authUser?.uid || 'operator-ui',
        performedByEmail: authUser?.email || 'operator@api-healer.internal',
        metadata: {
          clientTimestamp: new Date().toISOString(),
          environment: 'production-cloud',
          source: 'audit-console-ui',
        },
      });
      toast.success('Audit log entry created and persisted to Firestore');
      setIsTestModalOpen(false);
    } catch (err) {
      const formatted = handleFirestoreError(err, 'Create Audit Entry');
      toast.error(`Audit logging failed: ${formatted.message}`);
    } finally {
      setIsSubmittingTest(false);
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    toast.success('Copied to clipboard');
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(filteredLogs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `audit_logs_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    toast.success(`Exported ${filteredLogs.length} audit records`);
  };

  // Filtered and searched logs
  const filteredLogs = logs.filter((log) => {
    if (categoryFilter !== 'ALL' && log.category !== categoryFilter) return false;
    if (statusFilter !== 'ALL' && log.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchesAction = log.action.toLowerCase().includes(q);
      const matchesDetails = log.details.toLowerCase().includes(q);
      const matchesTarget = (log.target || '').toLowerCase().includes(q);
      const matchesActor = (log.performedByEmail || '').toLowerCase().includes(q);
      if (!matchesAction && !matchesDetails && !matchesTarget && !matchesActor) {
        return false;
      }
    }
    return true;
  });

  // Metric counts
  const counts = {
    total: logs.length,
    retries: logs.filter((l) => l.category === 'JOB_RETRY').length,
    configs: logs.filter((l) => l.category === 'CONFIG_CHANGE').length,
    actions: logs.filter((l) => l.category === 'SYSTEM_ACTION').length,
  };

  const getCategoryLabel = (category: AuditCategory) => {
    switch (category) {
      case 'JOB_RETRY':
        return (
          <span className="font-mono text-[11px] font-medium text-sky-600 dark:text-sky-400">
            Job Retry
          </span>
        );
      case 'CONFIG_CHANGE':
        return (
          <span className="font-mono text-[11px] font-medium text-purple-600 dark:text-purple-400">
            Config Change
          </span>
        );
      case 'SYSTEM_ACTION':
      default:
        return (
          <span className="font-mono text-[11px] font-medium text-amber-600 dark:text-amber-400">
            System Action
          </span>
        );
    }
  };

  const getStatusIcon = (status: AuditStatus) => {
    switch (status) {
      case 'SUCCESS':
        return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />;
      case 'FAILED':
        return <XCircle className="h-4 w-4 text-rose-500 shrink-0" />;
      case 'PENDING':
      default:
        return <Clock className="h-4 w-4 text-amber-500 shrink-0" />;
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* Firestore Connection & Quick Stats Strip */}
      <section
        aria-label="Audit Telemetry Summary"
        className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4"
      >
        <div className="p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Firestore Ledger</span>
            <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
              Connected · Immutable
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground shrink-0" />
            <span
              className="truncate font-mono text-sm font-semibold text-foreground"
              title={firebaseConfig.firestoreDatabaseId}
            >
              {firebaseConfig.firestoreDatabaseId || '(default)'}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            Collection: audit_logs
          </div>
        </div>

        <div className="p-4">
          <div className="text-xs font-medium text-muted-foreground">Total Audit Records</div>
          <div className="mt-1 font-mono text-xl font-bold tracking-tight tabular-nums text-foreground">
            {counts.total}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            Chronological stream
          </div>
        </div>

        <div className="p-4">
          <div className="text-xs font-medium text-muted-foreground">Job Retries</div>
          <div className="mt-1 font-mono text-xl font-bold tracking-tight tabular-nums text-sky-600 dark:text-sky-400">
            {counts.retries}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            Auto &amp; manual recovery
          </div>
        </div>

        <div className="p-4">
          <div className="text-xs font-medium text-muted-foreground">Policy &amp; System Events</div>
          <div className="mt-1 font-mono text-xl font-bold tracking-tight tabular-nums text-foreground">
            {counts.configs + counts.actions}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            Thresholds &amp; operator actions
          </div>
        </div>
      </section>

      {/* Error Banner if Firestore reports failure */}
      {errorInfo && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">Firestore Audit Connection Issue</p>
            <p className="text-xs mt-1 text-destructive/90">{errorInfo}</p>
          </div>
          <Button size="sm" variant="outline" onClick={handleManualRefresh} className="h-8 text-xs border-destructive/40 hover:bg-destructive/20">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      )}

      {/* Main Filter & Action Toolbar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search actions, targets, details, or user email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs bg-background"
            />
          </div>

          {/* Category Filter */}
          <div className="flex items-center gap-1 border border-border rounded-md p-0.5 bg-muted/40">
            {(['ALL', 'JOB_RETRY', 'CONFIG_CHANGE', 'SYSTEM_ACTION'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
                  categoryFilter === cat
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {cat === 'ALL'
                  ? 'All Categories'
                  : cat === 'JOB_RETRY'
                  ? 'Retries'
                  : cat === 'CONFIG_CHANGE'
                  ? 'Configs'
                  : 'Actions'}
              </button>
            ))}
          </div>

          {/* Status Filter */}
          <div className="hidden sm:flex items-center gap-1 border border-border rounded-md p-0.5 bg-muted/40">
            {(['ALL', 'SUCCESS', 'FAILED'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
                  statusFilter === st
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {st === 'ALL' ? 'All' : st}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
            className="h-9 text-xs"
            title="Toggle chronological sort order"
          >
            <Clock className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
            {sortOrder === 'desc' ? 'Newest First' : 'Oldest First'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredLogs.length === 0}
            className="h-9 text-xs"
          >
            <Download className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
            Export JSON
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            className="h-9 text-xs"
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            Sync
          </Button>

          <Button
            size="sm"
            onClick={() => setIsTestModalOpen(true)}
            className="h-9 text-xs font-medium"
          >
            <PlusCircle className="mr-1.5 h-3.5 w-3.5" />
            Log Action
          </Button>
        </div>
      </div>

      {/* Chronological Audit Log List */}
      <Card className="border-border bg-card">
        <CardHeader className="py-3 px-4 border-b border-border flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-primary" />
              Chronological Audit Trail
            </CardTitle>
            <CardDescription className="text-xs">
              Real-time Firestore stream of all system actions, configuration updates, and job retries.
            </CardDescription>
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {filteredLogs.length} of {logs.length} entries
          </span>
        </CardHeader>

        <CardContent className="p-0 divide-y divide-border">
          {loading && logs.length === 0 ? (
            <div className="p-6 space-y-4">
              <Skeleton className="h-14 w-full rounded-md" />
              <Skeleton className="h-14 w-full rounded-md" />
              <Skeleton className="h-14 w-full rounded-md" />
              <Skeleton className="h-14 w-full rounded-md" />
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <ScrollText className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">No audit entries found</h3>
              <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
                {searchQuery || categoryFilter !== 'ALL' || statusFilter !== 'ALL'
                  ? 'No audit log records match the current filter parameters.'
                  : 'Audit events will stream here automatically whenever job retries, config changes, or system actions occur.'}
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button size="sm" onClick={() => setIsTestModalOpen(true)} className="text-xs">
                  <PlusCircle className="mr-1.5 h-3.5 w-3.5" /> Log Test Entry
                </Button>
              </div>
            </div>
          ) : (
            filteredLogs.map((entry) => {
              const formattedDate = new Date(entry.createdAt).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });
              const isRobot =
                entry.performedByEmail?.includes('system') ||
                entry.performedByEmail?.includes('worker') ||
                !entry.performedByEmail;

              return (
                <div
                  key={entry.id}
                  className="p-4 hover:bg-muted/40 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="mt-0.5">{getStatusIcon(entry.status)}</div>

                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-foreground text-xs">
                          {entry.action}
                        </span>
                        <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                        {getCategoryLabel(entry.category)}
                        {entry.target && (
                          <>
                            <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {entry.target}
                            </span>
                          </>
                        )}
                      </div>

                      <p className="text-xs text-foreground/90 font-normal leading-relaxed line-clamp-2">
                        {entry.details}
                      </p>

                      <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1 font-mono">
                          <Clock className="h-3 w-3" />
                          {formattedDate}
                        </span>

                        <span className="flex items-center gap-1">
                          {isRobot ? <Bot className="h-3 w-3 text-muted-foreground" /> : <User className="h-3 w-3 text-primary" />}
                          <span className="font-mono">{entry.performedByEmail || 'system'}</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setInspectLog(entry)}
                      className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Inspect
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopy(JSON.stringify(entry, null, 2), entry.id)}
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                      title="Copy JSON record"
                    >
                      {copiedId === entry.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Detail / Payload Inspector Modal */}
      <Dialog open={!!inspectLog} onOpenChange={(open) => !open && setInspectLog(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-mono">
              <ScrollText className="h-4 w-4 text-primary" />
              {inspectLog?.action}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Firestore Audit Record ID: <code className="font-mono text-foreground">{inspectLog?.id}</code>
            </DialogDescription>
          </DialogHeader>

          {inspectLog && (
            <div className="flex-1 overflow-y-auto space-y-4 py-2 text-xs">
              <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-muted/40 border border-border">
                <div>
                  <span className="text-[11px] text-muted-foreground block">Category</span>
                  <div className="mt-1">{getCategoryLabel(inspectLog.category)}</div>
                </div>
                <div>
                  <span className="text-[11px] text-muted-foreground block">Status</span>
                  <div className="mt-1 flex items-center gap-1.5 font-semibold text-foreground">
                    {getStatusIcon(inspectLog.status)}
                    <span>{inspectLog.status}</span>
                  </div>
                </div>
                <div>
                  <span className="text-[11px] text-muted-foreground block">Target Resource</span>
                  <code className="text-foreground font-mono mt-1 block">{inspectLog.target || 'None'}</code>
                </div>
                <div>
                  <span className="text-[11px] text-muted-foreground block">Timestamp</span>
                  <span className="text-foreground font-mono mt-1 block">{new Date(inspectLog.createdAt).toISOString()}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-[11px] text-muted-foreground block">Actor (UID / Email)</span>
                  <span className="text-foreground font-mono mt-1 block">{inspectLog.performedByEmail || inspectLog.performedByUid || 'system'}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-[11px] text-muted-foreground block">Summary Description</span>
                  <p className="text-foreground mt-1 text-xs">{inspectLog.details}</p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between pb-1.5">
                  <span className="font-semibold text-xs text-foreground">Payload & Metadata</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px] px-2"
                    onClick={() => handleCopy(JSON.stringify(inspectLog, null, 2), inspectLog.id)}
                  >
                    <Copy className="mr-1 h-3 w-3" /> Copy Payload
                  </Button>
                </div>
                <pre className="p-3 rounded-md bg-muted font-mono text-[11px] text-foreground overflow-x-auto border border-border">
                  {JSON.stringify(inspectLog, null, 2)}
                </pre>
              </div>
            </div>
          )}

          <DialogFooter className="border-t border-border pt-3">
            <Button variant="outline" size="sm" onClick={() => setInspectLog(null)} className="text-xs">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manual / Test Entry Creation Modal */}
      <Dialog open={isTestModalOpen} onOpenChange={setIsTestModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <PlusCircle className="h-4 w-4 text-primary" />
              Log System Action to Firestore
            </DialogTitle>
            <DialogDescription className="text-xs">
              Record a custom immutable audit log entry into the Firestore audit collection.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateTestEntry} className="space-y-4 py-2 text-xs">
            <div className="space-y-1.5">
              <label className="font-semibold text-foreground">Action Name</label>
              <Input
                value={testAction}
                onChange={(e) => setTestAction(e.target.value)}
                placeholder="e.g. RETRY_JOB, UPDATE_CONFIG, TOGGLE_BREAKER"
                className="font-mono text-xs"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="font-semibold text-foreground">Category</label>
                <Select
                  value={testCategory}
                  onValueChange={(val) => setTestCategory(val as AuditCategory)}
                >
                  <SelectTrigger className="h-9 w-full border-input bg-background text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SYSTEM_ACTION" className="text-xs">SYSTEM_ACTION</SelectItem>
                    <SelectItem value="CONFIG_CHANGE" className="text-xs">CONFIG_CHANGE</SelectItem>
                    <SelectItem value="JOB_RETRY" className="text-xs">JOB_RETRY</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-foreground">Status</label>
                <Select
                  value={testStatus}
                  onValueChange={(val) => setTestStatus(val as AuditStatus)}
                >
                  <SelectTrigger className="h-9 w-full border-input bg-background text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SUCCESS" className="text-xs">SUCCESS</SelectItem>
                    <SelectItem value="FAILED" className="text-xs">FAILED</SelectItem>
                    <SelectItem value="PENDING" className="text-xs">PENDING</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-foreground">Target Resource</label>
              <Input
                value={testTarget}
                onChange={(e) => setTestTarget(e.target.value)}
                placeholder="e.g. job:canary-01, config:rate-limit"
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-foreground">Action Details</label>
              <textarea
                value={testDetails}
                onChange={(e) => setTestDetails(e.target.value)}
                rows={3}
                placeholder="Describe what action was executed and why..."
                className="w-full rounded-md border border-input bg-background p-2.5 text-xs text-foreground resize-none"
                required
              />
            </div>

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsTestModalOpen(false)}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmittingTest} className="text-xs">
                {isSubmittingTest ? 'Writing to Firestore...' : 'Record Audit Entry'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
