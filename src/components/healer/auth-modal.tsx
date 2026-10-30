'use client';

import { useState, type FormEvent } from 'react';
import { useHealer } from '@/components/healer/store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ShieldCheck, Loader2, Sparkles, Database, Mail, Lock, User, ArrowRight } from 'lucide-react';

export function AuthModal() {
  const {
    authModalOpen,
    setAuthModalOpen,
    authModalMode,
    setAuthModalMode,
    authBusy,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    instantDemoLogin,
  } = useHealer();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const isSignUp = authModalMode === 'signup';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!email.trim() || !password) {
      setValidationError('Please fill in both email and password.');
      return;
    }

    if (password.length < 6) {
      setValidationError('Password must be at least 6 characters long.');
      return;
    }

    if (isSignUp && password !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }

    if (isSignUp) {
      await signUpWithEmail(email, password, displayName);
    } else {
      await signInWithEmail(email, password);
    }
  };

  return (
    <Dialog open={authModalOpen} onOpenChange={setAuthModalOpen}>
      <DialogContent className="sm:max-w-md border-border bg-card p-6 shadow-2xl">
        <DialogHeader className="space-y-2 text-left">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold tracking-tight text-foreground">
                {isSignUp ? 'Create API-HEALER Account' : 'Sign In to API-HEALER'}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Autonomous runtime protection & multi-agent PR synthesis console.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Mode Selector Tabs */}
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => {
              setValidationError(null);
              setAuthModalMode('signin');
            }}
            className={`flex h-8 items-center justify-center rounded-md text-xs font-medium transition-all ${
              !isSignUp
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setValidationError(null);
              setAuthModalMode('signup');
            }}
            className={`flex h-8 items-center justify-center rounded-md text-xs font-medium transition-all ${
              isSignUp
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Create Account
          </button>
        </div>

        {/* Google Authentication */}
        <div className="space-y-3 pt-1">
          <Button
            type="button"
            variant="outline"
            disabled={authBusy}
            onClick={() => void signInWithGoogle()}
            className="w-full h-10 gap-2.5 border-border bg-card text-xs font-semibold hover:bg-accent text-foreground transition-all"
          >
            {authBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            )}
            <span>{isSignUp ? 'Sign up with Google' : 'Sign in with Google'}</span>
          </Button>

          <div className="relative flex items-center justify-center">
            <div className="w-full border-t border-border" />
            <span className="absolute bg-card px-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Or with work email
            </span>
          </div>

          {/* Email / Password Form */}
          <form onSubmit={handleSubmit} className="space-y-3">
            {isSignUp && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-name" className="text-xs font-medium text-foreground">
                  Full Name
                </Label>
                <div className="relative">
                  <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="auth-name"
                    type="text"
                    placeholder="Sundeep Rao"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="pl-9 text-xs h-9"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="auth-email" className="text-xs font-medium text-foreground">
                Email Address
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="auth-email"
                  type="email"
                  placeholder="engineer@company.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9 text-xs h-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="auth-password" className="text-xs font-medium text-foreground">
                  Password
                </Label>
                {!isSignUp && (
                  <span className="text-[11px] text-muted-foreground hover:underline cursor-pointer">
                    Min 6 chars
                  </span>
                )}
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="auth-password"
                  type="password"
                  placeholder="••••••••"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 text-xs h-9"
                />
              </div>
            </div>

            {isSignUp && (
              <div className="space-y-1.5">
                <Label htmlFor="auth-confirm" className="text-xs font-medium text-foreground">
                  Confirm Password
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="auth-confirm"
                    type="password"
                    placeholder="••••••••"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-9 text-xs h-9"
                  />
                </div>
              </div>
            )}

            {validationError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {validationError}
              </div>
            )}

            <Button
              type="submit"
              disabled={authBusy}
              className="w-full h-9 text-xs font-semibold gap-1.5 bg-primary text-primary-foreground hover:opacity-90"
            >
              {authBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <span>{isSignUp ? 'Create Account & Enter' : 'Sign In to Console'}</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </form>

          {/* Instant Judge Demo Access */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-left">
            <div className="flex items-center justify-between mb-1.5">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Hackathon / Judge Quick-Access
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">Zero-Setup</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              Evaluate full console features without entering credentials. Creates an authenticated session synchronized with Cloud SQL PostgreSQL.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={authBusy}
              onClick={() => void instantDemoLogin()}
              className="w-full h-8 gap-1.5 text-xs font-medium border border-border"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              1-Click Instant Demo Login
            </Button>
          </div>

          {/* Database & Security Assurance */}
          <div className="flex items-center justify-center gap-2 pt-1 text-[11px] text-muted-foreground">
            <Database className="h-3.5 w-3.5 text-emerald-500" />
            <span>Persisted & Protected by Google Cloud SQL PostgreSQL</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
