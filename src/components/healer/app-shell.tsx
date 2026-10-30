'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  ShieldCheck,
  LayoutDashboard,
  FlaskConical,
  GitPullRequest,
  FileCode2,
  Cpu,
  Plug,
  ScrollText,
  RotateCcw,
  Menu,
  Sun,
  Moon,
  Zap,
  LogIn,
  LogOut,
  UserCheck,
} from 'lucide-react';
import { PAGE_META, useHealer, type PageId } from './store';
import { NotificationsCenter } from './notifications-center';
import { AuthModal } from './auth-modal';

const NAV_GROUPS: {
  label: string;
  items: {
    id: PageId;
    icon: React.ComponentType<{ className?: string }>;
    count?: (s: ReturnType<typeof useHealer>) => number | null;
  }[];
}[] = [
  {
    label: 'Runtime Operations',
    items: [
      { id: 'home', icon: LayoutDashboard, count: (s) => s.events.length || null },
      { id: 'playground', icon: FlaskConical },
      {
        id: 'cold-path',
        icon: GitPullRequest,
        count: (s) => s.prs.length + s.fingerprints.length || null,
      },
    ],
  },
  {
    label: 'Governance & Infra',
    items: [
      { id: 'contracts', icon: FileCode2, count: (s) => s.contracts.length || null },
      { id: 'workers', icon: Cpu },
      { id: 'integrate', icon: Plug },
      { id: 'audit', icon: ScrollText },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const store = useHealer();
  const {
    page,
    navigate,
    theme,
    toggleTheme,
    resetAll,
    openConnect,
    authUser,
    authBusy,
    signInWithGoogle,
    signOutUser,
  } = store;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleNavClick = (id: PageId, e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(id);
    setMobileMenuOpen(false);
  };

  const currentMeta = PAGE_META[page];

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      {/* Desktop Sidebar — 240px Enterprise Workspace Navigation */}
      <aside
        aria-label="Primary Navigation"
        className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between overflow-hidden border-r border-border bg-sidebar lg:flex"
      >
        <div className="flex flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <a
              href={PAGE_META.home.path}
              onClick={(e) => handleNavClick('home', e)}
              className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <span className="text-sm font-bold tracking-tight text-foreground">
                API Healer
              </span>
            </a>
          </div>

          <nav className="space-y-5 px-3 py-4">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="space-y-1">
                <div className="px-3 pb-1 text-[11px] font-medium text-muted-foreground">
                  {group.label}
                </div>
                {group.items.map(({ id, icon: Icon, count }) => {
                  const active = page === id;
                  const badgeVal = count?.(store);
                  const meta = PAGE_META[id];
                  return (
                    <a
                      key={id}
                      href={meta.path}
                      onClick={(e) => handleNavClick(id, e)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex h-9 items-center gap-2.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap',
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Icon
                        className={cn(
                          'h-4 w-4 shrink-0',
                          active ? 'text-primary-foreground' : 'text-muted-foreground',
                        )}
                      />
                      <span className="truncate">{meta.shortTitle}</span>
                      {badgeVal ? (
                        <span
                          className={cn(
                            'ml-auto font-mono text-[11px] tabular-nums',
                            active ? 'text-primary-foreground/80' : 'text-muted-foreground',
                          )}
                        >
                          {badgeVal}
                        </span>
                      ) : null}
                    </a>
                  );
                })}
              </div>
            ))}
          </nav>
        </div>

        <div className="shrink-0 space-y-3 border-t border-border p-3.5">
          <div className="space-y-1 px-1 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between font-mono tabular-nums">
              <span>Loop-1 Shield</span>
              <span className="font-medium text-foreground">&lt;0.10ms</span>
            </div>
            <div className="flex items-center justify-between font-mono tabular-nums">
              <span>Loop-2 Swarm</span>
              <span className="font-medium text-foreground">6 Patchers</span>
            </div>
          </div>
          <Button
            size="sm"
            onClick={openConnect}
            data-testid="one-click-setup-sidebar-btn"
            className="h-9 w-full gap-1.5 bg-primary text-xs font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
          >
            <Zap className="h-3.5 w-3.5" />
            1-Click App Setup
          </Button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-card/95 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0 border-border bg-card lg:hidden"
                  aria-label="Open navigation menu"
                >
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex h-dvh w-60 flex-col justify-between overflow-hidden border-r border-border bg-sidebar p-0"
              >
                <div>
                  <div className="flex h-14 items-center border-b border-border px-4 pr-12">
                    <SheetTitle className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
                      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <ShieldCheck className="h-4 w-4" />
                      </div>
                      API Healer
                    </SheetTitle>
                    <SheetDescription className="sr-only">
                      Primary mobile navigation menu
                    </SheetDescription>
                  </div>
                  <nav className="space-y-4 p-3">
                    {NAV_GROUPS.map((group) => (
                      <div key={group.label} className="space-y-1">
                        <div className="px-3 pb-1 text-[11px] font-medium text-muted-foreground">
                          {group.label}
                        </div>
                        {group.items.map(({ id, icon: Icon, count }) => {
                          const active = page === id;
                          const badgeVal = count?.(store);
                          const meta = PAGE_META[id];
                          return (
                            <a
                              key={id}
                              href={meta.path}
                              onClick={(e) => handleNavClick(id, e)}
                              aria-current={active ? 'page' : undefined}
                              className={cn(
                                'flex h-9 items-center gap-2.5 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap',
                                active
                                  ? 'bg-primary text-primary-foreground'
                                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                              )}
                            >
                              <Icon
                                className={cn(
                                  'h-4 w-4 shrink-0',
                                  active ? 'text-primary-foreground' : 'text-muted-foreground',
                                )}
                              />
                              <span className="truncate">{meta.shortTitle}</span>
                              {badgeVal ? (
                                <span
                                  className={cn(
                                    'ml-auto font-mono text-[11px] tabular-nums',
                                    active ? 'text-primary-foreground/80' : 'text-muted-foreground',
                                  )}
                                >
                                  {badgeVal}
                                </span>
                              ) : null}
                            </a>
                          );
                        })}
                      </div>
                    ))}
                  </nav>
                </div>

                <div className="shrink-0 border-t border-border p-3">
                  <Button
                    size="sm"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      openConnect();
                    }}
                    className="h-9 w-full gap-1.5 bg-primary text-xs font-medium text-primary-foreground hover:opacity-90 whitespace-nowrap"
                  >
                    <Zap className="h-3.5 w-3.5" />
                    1-Click App Setup
                  </Button>
                </div>
              </SheetContent>
            </Sheet>

            {/* Contextual Breadcrumb Trail */}
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="hidden text-muted-foreground sm:inline whitespace-nowrap">
                {currentMeta.section}
              </span>
              <span className="hidden text-muted-foreground/40 sm:inline" aria-hidden="true">
                /
              </span>
              <span className="truncate font-semibold text-foreground">
                {currentMeta.shortTitle}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <NotificationsCenter />

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={toggleTheme}
              data-testid="theme-toggle"
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="h-8 gap-1.5 border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap shrink-0"
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-amber-400" />
                  <span className="hidden sm:inline">Light</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="hidden sm:inline">Dark</span>
                </>
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap shrink-0"
              onClick={() => void resetAll()}
              aria-label="Reset runtime state"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Reset</span>
            </Button>

            {authUser ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void signOutUser()}
                title={`Signed in as ${authUser.email} · Synced with Cloud SQL`}
                className="h-8 gap-1.5 border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap shrink-0"
              >
                <UserCheck className="h-3.5 w-3.5 text-emerald-500" />
                <span className="hidden max-w-[110px] truncate md:inline">
                  {authUser.email.split('@')[0] || 'Account'}
                </span>
                <span className="hidden xl:inline text-[9px] font-mono text-emerald-500 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20">
                  Cloud SQL
                </span>
                <LogOut className="h-3 w-3 text-muted-foreground" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={authBusy}
                onClick={() => {
                  store.setAuthModalMode('signin');
                  store.setAuthModalOpen(true);
                }}
                className="h-8 gap-1.5 border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent whitespace-nowrap shrink-0"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Sign In</span>
              </Button>
            )}

            <Button
              size="sm"
              data-testid="one-click-setup-header-btn"
              className="h-8 gap-1.5 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 lg:hidden whitespace-nowrap shrink-0"
              onClick={openConnect}
            >
              <Zap className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">1-Click Setup</span>
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-5 sm:px-6 sm:py-6">
          {children}
        </main>
      </div>

      <AuthModal />
    </div>
  );
}

export function PageHeader({ actions }: { actions?: ReactNode }) {
  const { page } = useHealer();
  const meta = PAGE_META[page];
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {meta.title}
        </h1>
        <p className="text-xs text-muted-foreground max-w-3xl">
          {meta.subtitle}
        </p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
