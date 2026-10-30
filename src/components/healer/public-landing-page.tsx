'use client';

import { useState } from 'react';
import { useHealer } from '@/components/healer/store';
import { AuthModal } from '@/components/healer/auth-modal';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck,
  Zap,
  Cpu,
  GitPullRequest,
  Lock,
  ArrowRight,
  Database,
  CheckCircle2,
  XCircle,
  Sun,
  Moon,
  Sparkles,
  Layers,
  Activity,
  FileCode2,
} from 'lucide-react';

export function PublicLandingPage() {
  const {
    setAuthModalOpen,
    setAuthModalMode,
    instantDemoLogin,
    theme,
    toggleTheme,
    authBusy,
  } = useHealer();

  const [activeTab, setActiveTab] = useState<'loop1' | 'loop2' | 'gates' | 'cloudsql'>('loop1');

  const openSignIn = () => {
    setAuthModalMode('signin');
    setAuthModalOpen(true);
  };

  const openSignUp = () => {
    setAuthModalMode('signup');
    setAuthModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col selection:bg-primary/20">
      {/* Auth Modal is always mounted for immediate opening */}
      <AuthModal />

      {/* Public Top Navbar */}
      <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold tracking-tight text-foreground">API Healer</span>
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                Autonomous Runtime Shield
              </span>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-muted-foreground">
            <a href="#dual-loop" className="hover:text-foreground transition-colors">
              Dual-Loop Engine
            </a>
            <a href="#architecture" className="hover:text-foreground transition-colors">
              Architecture
            </a>
            <a href="#scenarios" className="hover:text-foreground transition-colors">
              Fault Scenarios
            </a>
            <a href="#benchmarks" className="hover:text-foreground transition-colors">
              SLA & Benchmarks
            </a>
          </nav>

          <div className="flex items-center gap-2.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={toggleTheme}
              className="h-8 w-8 border-border bg-card text-foreground hover:bg-accent"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4 text-amber-400" />
              ) : (
                <Moon className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={openSignIn}
              className="h-8 px-3 text-xs font-medium text-foreground hover:bg-accent"
            >
              Sign In
            </Button>

            <Button
              size="sm"
              onClick={openSignUp}
              className="h-8 gap-1.5 bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 shadow-sm"
            >
              <span>Get Started</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-12 pb-16 md:pt-20 md:pb-24 border-b border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          {/* Eyebrow Badge */}
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3.5 py-1 text-xs font-medium text-primary mb-6 shadow-sm">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Dual-Loop Architecture · Google Cloud SQL PostgreSQL Powered</span>
          </div>

          <h1 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-5xl lg:text-6xl max-w-4xl mx-auto leading-tight sm:leading-tight">
            Zero-Downtime Autonomous Runtime Patching for Breaking APIs
          </h1>

          <p className="mt-5 text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            When upstream APIs alter schemas, rename payload fields, or trigger silent 200 OK crashes,
            <strong className="text-foreground font-semibold"> API-HEALER</strong> heals requests in <code className="font-mono text-primary font-bold">&lt;0.1ms</code> at runtime, while a 6-agent swarm autonomously drafts and verifies atomic GitHub Pull Requests before your users ever notice.
          </p>

          {/* Primary CTA Buttons */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              onClick={openSignUp}
              className="h-11 px-6 text-sm font-semibold gap-2 bg-primary text-primary-foreground hover:opacity-90 shadow-md"
            >
              <Zap className="h-4 w-4" />
              <span>Launch Developer Console</span>
              <ArrowRight className="h-4 w-4" />
            </Button>

            <Button
              size="lg"
              variant="outline"
              disabled={authBusy}
              onClick={() => void instantDemoLogin()}
              className="h-11 px-6 text-sm font-semibold gap-2 border-border bg-card hover:bg-accent text-foreground shadow-sm"
            >
              <Sparkles className="h-4 w-4 text-emerald-500" />
              <span>1-Click Hackathon Judge Demo</span>
            </Button>
          </div>

          <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5 text-emerald-500" />
            <span>Authentication required · Protected by Cloud SQL PostgreSQL and Firebase Auth</span>
          </div>

          {/* Key SLA Metric Highlights */}
          <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-4 max-w-4xl mx-auto text-left">
            <div className="rounded-xl border border-border bg-card/60 p-4 shadow-sm">
              <div className="text-[11px] font-mono text-muted-foreground uppercase">Loop-1 Latency</div>
              <div className="mt-1 text-2xl font-bold font-mono text-emerald-500 tabular-nums">&lt;0.10ms</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">Deterministic L1 Memory Shield</div>
            </div>

            <div className="rounded-xl border border-border bg-card/60 p-4 shadow-sm">
              <div className="text-[11px] font-mono text-muted-foreground uppercase">Statistical Safety</div>
              <div className="mt-1 text-2xl font-bold font-mono text-primary tabular-nums">3-Gate 4.5σ</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">Zero-Hallucination Veto</div>
            </div>

            <div className="rounded-xl border border-border bg-card/60 p-4 shadow-sm">
              <div className="text-[11px] font-mono text-muted-foreground uppercase">Agent Swarm</div>
              <div className="mt-1 text-2xl font-bold font-mono text-blue-500 tabular-nums">6 Patchers</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">Multi-Agent Code Synthesis</div>
            </div>

            <div className="rounded-xl border border-border bg-card/60 p-4 shadow-sm">
              <div className="text-[11px] font-mono text-muted-foreground uppercase">Persistence</div>
              <div className="mt-1 text-2xl font-bold font-mono text-purple-500 tabular-nums">Cloud SQL</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">Managed PostgreSQL Backend</div>
            </div>
          </div>
        </div>
      </section>

      {/* Before vs After Visual Comparison */}
      <section id="dual-loop" className="py-16 border-b border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-12">
            <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Why Traditional Error Handling Fails Upstream
            </h2>
            <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
              Upstream APIs change without warning. Here is what happens with and without API-HEALER.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {/* The Failure Path */}
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 shadow-sm">
              <div className="flex items-center gap-2 font-bold text-sm text-destructive mb-4">
                <XCircle className="h-5 w-5" />
                <span>WITHOUT API-HEALER: Critical Outage</span>
              </div>
              <ol className="space-y-3 text-xs text-muted-foreground">
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-destructive">01</span>
                  <span>Payment provider renames <code className="font-mono text-foreground">amount_cents</code> to <code className="font-mono text-foreground">total_cents</code>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-destructive">02</span>
                  <span>Your core service throws <code className="font-mono text-foreground">TypeError: undefined is not a function</code>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-destructive">03</span>
                  <span>Customer checkout fails. Transactions drop. Revenue is permanently lost.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-destructive">04</span>
                  <span>Engineers woken up by PagerDuty at 3:00 AM to manually hot-fix production.</span>
                </li>
              </ol>
            </div>

            {/* The Healer Path */}
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 shadow-sm">
              <div className="flex items-center gap-2 font-bold text-sm text-emerald-500 mb-4">
                <CheckCircle2 className="h-5 w-5" />
                <span>WITH API-HEALER: Zero Downtime</span>
              </div>
              <ol className="space-y-3 text-xs text-muted-foreground">
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-emerald-500">01</span>
                  <span>Loop-1 Runtime Shield detects schema drift on ingress in <code className="font-mono text-foreground">0.08ms</code>.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-emerald-500">02</span>
                  <span>3-Gate Statistical Engine verifies zero anomalies (no mathematical hallucination).</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-emerald-500">03</span>
                  <span>6-Verb JSON DSL normalizes payload. Core microservice checkout succeeds smoothly.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="font-mono font-bold text-emerald-500">04</span>
                  <span>Loop-2 Multi-Agent Swarm drafts an atomic GitHub PR for permanent codebase fix.</span>
                </li>
              </ol>
            </div>
          </div>
        </div>
      </section>

      {/* Dual-Loop Engine Interactive Tabs */}
      <section id="architecture" className="py-16 border-b border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-10">
            <span className="text-xs font-mono font-semibold text-primary uppercase tracking-wider">
              System Architecture
            </span>
            <h2 className="mt-1.5 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Engineered with Dual-Loop Precision
            </h2>
            <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
              Separating high-speed deterministic runtime mutation from asynchronous deep agent synthesis.
            </p>
          </div>

          {/* Architecture Selector Tabs */}
          <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl mx-auto mb-8">
            <button
              type="button"
              onClick={() => setActiveTab('loop1')}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
                activeTab === 'loop1'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'border border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              <span>Loop-1: Sub-0.1ms Shield</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('gates')}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
                activeTab === 'gates'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'border border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>3-Gate Statistical Veto</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('loop2')}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
                activeTab === 'loop2'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'border border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <Cpu className="h-3.5 w-3.5" />
              <span>Loop-2: 6-Agent Swarm</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('cloudsql')}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
                activeTab === 'cloudsql'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'border border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              <span>Cloud SQL PostgreSQL</span>
            </button>
          </div>

          {/* Active Tab Content Card */}
          <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 max-w-4xl mx-auto shadow-sm text-left">
            {activeTab === 'loop1' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
                    <Zap className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-foreground">Loop-1: In-Memory Hot-Tier Shield (&lt;0.10ms)</h3>
                    <p className="text-xs text-muted-foreground">Zero network overhead, pure in-memory execution pipeline.</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Operates directly on the HTTP ingress path. Analyzes incoming payload against registered schema contracts using an ultra-compact 6-verb JSON Domain Specific Language (DSL):
                  <strong className="text-foreground"> RENAME, CAST, DEFAULT, HOIST, WRAP, COMPLIANCE</strong>.
                  Fingerprinted schema patches are cached with a strict 24-hour TTL to prevent stale mutations from lingering indefinitely.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase">Execution Time</div>
                    <div className="text-sm font-bold text-emerald-500 font-mono">0.07ms – 0.12ms</div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase">DSL Mutation Engine</div>
                    <div className="text-sm font-bold text-foreground font-mono">6 Safe Verbs</div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase">Temporary Bridge TTL</div>
                    <div className="text-sm font-bold text-foreground font-mono">24 Hours Max</div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'gates' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-foreground">3-Gate Statistical Anomaly Veto</h3>
                    <p className="text-xs text-muted-foreground">Mathematical guards against hallucination or corrupt payload mutators.</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Before any mutated payload is released to downstream microservices, it must pass through 3 strict deterministic gates:
                </p>
                <div className="space-y-2.5 text-xs text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <span className="font-mono font-bold text-primary">Gate 1:</span>
                    <span><strong className="text-foreground">Paise / Currency Anomaly Gate:</strong> Validates numeric range against historical 4.5σ baseline. If upstream sends a 100x multiplication (e.g. ₹49.99 vs 4999 paise), it catches and corrects or vetoes.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-mono font-bold text-primary">Gate 2:</span>
                    <span><strong className="text-foreground">Compliance Regex Gate:</strong> Ensures GSTIN, PAN, ISO country codes, and email format rules are rigorously obeyed.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-mono font-bold text-primary">Gate 3:</span>
                    <span><strong className="text-foreground">Distribution Bounds Veto:</strong> Rejects mutations that alter array structures or drop mandatory business fields.</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'loop2' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                    <Cpu className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-foreground">Loop-2: 3-Tier Multi-Agent Swarm (Cold Path)</h3>
                    <p className="text-xs text-muted-foreground">Master Orchestrator → 3 Sub-Orchestrators → 6 Specialized Patchers.</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  While Loop-1 keeps the application alive, Loop-2 triggers an asynchronous multi-agent swarm in an isolated network sandbox. The swarm inspects the production TypeScript AST, generates a regression test in Vitest, verifies 100% test pass rate in Canary, and opens a clean GitHub Pull Request.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 font-mono text-[11px]">
                  <div className="border border-border bg-muted/20 p-2.5 rounded-md">1. Schema AST Analyzer</div>
                  <div className="border border-border bg-muted/20 p-2.5 rounded-md">2. Upstream Doc Inferrer</div>
                  <div className="border border-border bg-muted/20 p-2.5 rounded-md">3. TypeScript Code Synthesizer</div>
                  <div className="border border-border bg-muted/20 p-2.5 rounded-md">4. Vitest Unit Test Author</div>
                  <div className="border border-border bg-muted/20 p-2.5 rounded-md">5. Canary Replay Sandbox</div>
                  <div className="border border-border bg-muted/20 p-2.5 rounded-md">6. GitHub PR Publisher</div>
                </div>
              </div>
            )}

            {activeTab === 'cloudsql' && (
              <div className="space-y-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
                    <Database className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-foreground">Google Cloud SQL PostgreSQL Persistence</h3>
                    <p className="text-xs text-muted-foreground">Managed relational storage in region asia-southeast1 with Drizzle ORM.</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  All enterprise state is persisted in a relational PostgreSQL database on Google Cloud SQL Developer Edition:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                    <span><strong className="text-foreground">users:</strong> Firebase Auth UID + Email mappings</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                    <span><strong className="text-foreground">contracts:</strong> Registered API endpoint schemas</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                    <span><strong className="text-foreground">drift_events:</strong> Real-time telemetric logs and latency</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                    <span><strong className="text-foreground">pull_requests:</strong> Autonomous Git branches and diffs</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Real-World Scenarios */}
      <section id="scenarios" className="py-16 border-b border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-10">
            <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Supported Real-World Upstream Failures
            </h2>
            <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
              Built specifically to handle the most catastrophic third-party breaking changes.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-mono font-bold text-primary mb-2">
                <FileCode2 className="h-4 w-4" />
                <span>FIELD RENAMES & CASTING</span>
              </div>
              <h4 className="text-sm font-semibold text-foreground mb-1.5">Stripe / Razorpay Drift</h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Upstream replaces <code className="font-mono text-foreground">amount_cents</code> with <code className="font-mono text-foreground">total_cents</code> (string). Healer renames and casts to integer in &lt;0.1ms.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-mono font-bold text-amber-500 mb-2">
                <Activity className="h-4 w-4" />
                <span>SILENT 200 OK CRASH TRAPS</span>
              </div>
              <h4 className="text-sm font-semibold text-foreground mb-1.5">Hidden Null Trap Disruption</h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Upstream returns HTTP 200 OK with <code className="font-mono text-foreground">{`{ status: "SUCCESS", data: null }`}</code>. Healer detects the silent trap and synthesizes a safe fallback structure.
              </p>
            </div>

            <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-mono font-bold text-emerald-500 mb-2">
                <Layers className="h-4 w-4" />
                <span>NESTED OBJECT HOISTING</span>
              </div>
              <h4 className="text-sm font-semibold text-foreground mb-1.5">Twilio / Sendgrid Restructure</h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Upstream wraps flat parameters inside a <code className="font-mono text-foreground">metadata.carrier_info</code> sub-object. Healer hoists required fields back to root level.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Final Banner */}
      <section className="py-16 md:py-20 text-center">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-primary/30 bg-primary/5 p-8 sm:p-12 shadow-md">
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
              Ready to immunize your production APIs?
            </h2>
            <p className="mt-3 text-xs sm:text-sm text-muted-foreground max-w-xl mx-auto leading-relaxed">
              Sign in or create a developer account to access the real-time Playground, monitor active hot patches, and inspect autonomous Multi-Agent Pull Requests.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button
                size="lg"
                onClick={openSignUp}
                className="h-10 px-6 text-xs font-semibold gap-2 bg-primary text-primary-foreground hover:opacity-90 shadow-sm"
              >
                <span>Create Free Account</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={authBusy}
                onClick={() => void instantDemoLogin()}
                className="h-10 px-6 text-xs font-semibold gap-2 border-border bg-card hover:bg-accent text-foreground shadow-sm"
              >
                <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
                <span>1-Click Judge Demo</span>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Public Footer */}
      <footer className="mt-auto border-t border-border bg-card py-6">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <span className="font-semibold text-foreground">API-HEALER Console</span>
            <span>· Enterprise Dual-Loop Autonomous Resilience</span>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <span>Google Cloud SQL (asia-southeast1)</span>
            <span>·</span>
            <span>Firebase Auth</span>
            <span>·</span>
            <button type="button" onClick={openSignIn} className="hover:text-foreground underline">
              Sign In
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
