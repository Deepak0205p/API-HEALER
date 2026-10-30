'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Bell,
  AlertTriangle,
  ShieldAlert,
  CheckCircle2,
  Info,
  CheckCheck,
  Trash2,
  Zap,
  Cpu,
} from 'lucide-react';
import { useHealer } from './store';
import type { NotificationRow, NotificationSeverity } from './ui-types';

type FilterTab = 'ALL' | 'ALERT' | 'SYSTEM';

const SEVERITY_META: Record<
  NotificationSeverity,
  {
    icon: React.ComponentType<{ className?: string }>;
    badgeClass: string;
    iconClass: string;
  }
> = {
  CRITICAL: {
    icon: ShieldAlert,
    badgeClass: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    iconClass: 'text-rose-500',
  },
  WARNING: {
    icon: AlertTriangle,
    badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    iconClass: 'text-amber-500',
  },
  SUCCESS: {
    icon: CheckCircle2,
    badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    iconClass: 'text-emerald-500',
  },
  INFO: {
    icon: Info,
    badgeClass: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    iconClass: 'text-sky-500',
  },
};

function formatRelativeTime(isoString: string): string {
  if (!isoString) return 'Just now';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Just now';
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function NotificationsCenter() {
  const {
    notifications,
    unreadNotificationsCount,
    markNotificationRead,
    markAllNotificationsRead,
    clearNotifications,
  } = useHealer();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<FilterTab>('ALL');

  const filtered = useMemo(() => {
    if (tab === 'ALL') return notifications;
    if (tab === 'ALERT') {
      return notifications.filter(
        (n) =>
          n.category === 'ALERT' ||
          n.category === 'DRIFT' ||
          n.severity === 'CRITICAL' ||
          n.severity === 'WARNING',
      );
    }
    return notifications.filter((n) => n.category === 'SYSTEM' || n.category === 'SETUP');
  }, [notifications, tab]);

  const alertCount = useMemo(
    () =>
      notifications.filter(
        (n) =>
          n.category === 'ALERT' ||
          n.category === 'DRIFT' ||
          n.severity === 'CRITICAL' ||
          n.severity === 'WARNING',
      ).length,
    [notifications],
  );

  const systemCount = useMemo(
    () => notifications.filter((n) => n.category === 'SYSTEM' || n.category === 'SETUP').length,
    [notifications],
  );

  const hasCriticalUnread = useMemo(
    () => notifications.some((n) => !n.read && (n.severity === 'CRITICAL' || n.severity === 'WARNING')),
    [notifications],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="notifications-trigger"
          aria-label={`Notifications (${unreadNotificationsCount} unread)`}
          className="relative h-8 gap-1.5 border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent"
        >
          <Bell className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Notifications</span>
          {unreadNotificationsCount > 0 && (
            <span
              data-testid="notifications-unread-badge"
              className={cn(
                'ml-0.5 font-mono text-[11px] font-semibold tabular-nums',
                hasCriticalUnread ? 'text-rose-600 dark:text-rose-400' : 'text-primary',
              )}
            >
              ({unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount})
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        data-testid="notifications-panel"
        className="w-[360px] max-w-[92vw] border-border bg-card p-0 text-foreground shadow-lg sm:w-[420px]"
      >
        <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">Notifications</span>
            <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {notifications.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={unreadNotificationsCount === 0}
              onClick={() => void markAllNotificationsRead()}
              data-testid="notifications-mark-all-read"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <CheckCheck className="h-3 w-3" />
              Mark read
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={notifications.length === 0}
              onClick={() => void clearNotifications()}
              data-testid="notifications-clear-all"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-rose-500 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2.5 py-1.5">
          {(
            [
              { id: 'ALL', label: 'All', count: notifications.length },
              { id: 'ALERT', label: 'Alert Triggers', count: alertCount },
              { id: 'SYSTEM', label: 'System Events', count: systemCount },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              data-testid={`notifications-tab-${item.id.toLowerCase()}`}
              className={cn(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                tab === item.id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span>{item.label}</span>
              <span className="font-mono text-[10px] opacity-75">{item.count}</span>
            </button>
          ))}
        </div>

        <div className="max-h-[380px] divide-y divide-border overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
              <Bell className="mb-2 h-6 w-6 text-muted-foreground/50" />
              <p className="text-xs font-medium text-foreground">No notifications recorded</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Historical alert triggers and system status events will appear here automatically.
              </p>
            </div>
          ) : (
            filtered.map((item: NotificationRow) => {
              const sev = SEVERITY_META[item.severity] ?? SEVERITY_META.INFO;
              const Icon = sev.icon;
              return (
                <div
                  key={item.id}
                  data-testid="notification-item"
                  onClick={() => {
                    if (!item.read) void markNotificationRead(item.id);
                  }}
                  className={cn(
                    'group flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-accent/50',
                    !item.read && 'bg-primary/[0.03]',
                  )}
                >
                  <div className="mt-0.5 shrink-0">
                    <Icon className={cn('h-4 w-4', sev.iconClass)} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {!item.read && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            aria-label="Unread"
                          />
                        )}
                        <span className="truncate text-xs font-medium text-foreground">
                          {item.title}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </div>

                    {item.description && (
                      <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    )}

                    <div className="flex items-center gap-1.5 pt-0.5">
                      <span
                        className={cn(
                          'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase',
                          sev.badgeClass,
                        )}
                      >
                        {item.severity}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                        {item.category === 'ALERT' || item.category === 'DRIFT' ? (
                          <Zap className="h-2.5 w-2.5" />
                        ) : (
                          <Cpu className="h-2.5 w-2.5" />
                        )}
                        {item.category}
                      </span>
                      {item.source && (
                        <span className="truncate font-mono text-[9px] text-muted-foreground">
                          {item.source}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
