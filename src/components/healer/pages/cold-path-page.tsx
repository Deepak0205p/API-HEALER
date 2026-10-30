'use client';

import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GitPullRequest, Key, CheckCircle2, ExternalLink, ShieldCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useHealer } from '../store';
import { ColdPath } from '../cold-path';
import { PageHeader } from '../app-shell';

export function ColdPathPage() {
  const {
    loading,
    hotPatches,
    fingerprints,
    prs,
    revokeFingerprint,
    refreshPrs,
  } = useHealer();

  const [githubRepo, setGithubRepo] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tokenPreview, setTokenPreview] = useState('');

  useEffect(() => {
    fetch('/api/settings/github')
      .then((res) => res.json())
      .then((data) => {
        if (data.repo) setGithubRepo(data.repo);
        setIsConfigured(data.configured);
        setTokenPreview(data.tokenPreview || '');
      })
      .catch(() => {});
  }, []);

  const handleSaveGitHubConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubRepo.trim()) {
      toast.error('Please enter a target repository (e.g. your-org/target-repo)');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/settings/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: githubRepo.trim(),
          token: githubToken.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save GitHub credentials');
        return;
      }
      setIsConfigured(data.configured);
      toast.success(
        data.configured
          ? 'Live GitHub integration verified & connected!'
          : 'Repository target updated (Token still required for live PRs)',
      );
      setGithubToken('');
    } catch (err: any) {
      toast.error('Connection failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-48 rounded-lg" />
        <Skeleton className="h-[460px] rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshPrs()}
            className="h-8 gap-1.5 text-xs font-medium"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      {/* Interactive GitHub Integration Config Box */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <GitPullRequest className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                Automated GitHub PR Dispatcher
                {isConfigured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="h-3 w-3" />
                    Live Mode Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    Dry-Run Mode
                  </span>
                )}
              </h2>
              <p className="text-xs text-muted-foreground">
                Set the target repository and personal access token directly from this dashboard so AI Pull Requests open on your repository.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSaveGitHubConfig} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-12 items-end">
          <div className="sm:col-span-5 space-y-1">
            <label className="text-xs font-medium text-foreground">Target GitHub Repository</label>
            <Input
              type="text"
              placeholder="e.g. Deepak0205p/apti or organization/service"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              className="h-9 text-xs font-mono"
              required
            />
          </div>

          <div className="sm:col-span-5 space-y-1">
            <label className="text-xs font-medium text-foreground">
              GitHub Personal Access Token (Classic with `repo` scope)
            </label>
            <Input
              type="password"
              placeholder={tokenPreview ? `Current: ${tokenPreview}` : 'ghp_••••••••••••••••••••••••'}
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              className="h-9 text-xs font-mono"
            />
          </div>

          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={saving}
              className="h-9 w-full text-xs font-medium"
            >
              {saving ? 'Testing...' : 'Save & Verify'}
            </Button>
          </div>
        </form>
      </section>

      {/* Telemetry counters */}
      <div className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3.5">
          <div className="text-xs font-medium text-muted-foreground">Active Hot Patches</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
            {hotPatches.length}
          </div>
        </div>

        <div className="px-4 py-3.5">
          <div className="text-xs font-medium text-muted-foreground">Durable Fingerprints</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
            {fingerprints.length}
          </div>
        </div>

        <div className="px-4 py-3.5">
          <div className="text-xs font-medium text-muted-foreground">Generated Pull Requests</div>
          <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
            {prs.length}
          </div>
        </div>
      </div>

      <ColdPath
        hotPatches={hotPatches}
        fingerprints={fingerprints}
        prs={prs}
        onRevoke={(id) => void revokeFingerprint(id)}
      />
    </div>
  );
}
