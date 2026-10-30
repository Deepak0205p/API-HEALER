import { NextRequest, NextResponse } from 'next/server';

// In-memory runtime store for dynamic GitHub tokens set from the UI dashboard
let runtimeGitHubConfig: { token: string; repo: string } = {
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
};

export function getActiveGitHubCredentials(): { token: string; repo: string } {
  return {
    token: runtimeGitHubConfig.token || process.env.GITHUB_TOKEN || '',
    repo: runtimeGitHubConfig.repo || process.env.GITHUB_REPO || '',
  };
}

export async function GET() {
  const current = getActiveGitHubCredentials();
  return NextResponse.json({
    configured: Boolean(current.token && current.repo),
    repo: current.repo || '',
    hasToken: Boolean(current.token),
    tokenPreview: current.token ? `${current.token.slice(0, 4)}...${current.token.slice(-3)}` : '',
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { token?: string; repo?: string };
    if (!body.repo?.trim()) {
      return NextResponse.json({ error: 'Target GitHub repository (owner/repo) is required' }, { status: 400 });
    }

    runtimeGitHubConfig = {
      token: body.token?.trim() || '',
      repo: body.repo.trim(),
    };

    // If token provided, verify against GitHub API
    if (runtimeGitHubConfig.token) {
      try {
        const testRes = await fetch(`https://api.github.com/repos/${runtimeGitHubConfig.repo}`, {
          headers: {
            Authorization: `Bearer ${runtimeGitHubConfig.token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'API-Healer-Control-Plane',
          },
        });

        if (!testRes.ok) {
          return NextResponse.json(
            { error: `GitHub API error: HTTP ${testRes.status} (Check token scopes and repo name)` },
            { status: 400 },
          );
        }
      } catch (err: any) {
        return NextResponse.json({ error: `Connection failed: ${err.message}` }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true,
      repo: runtimeGitHubConfig.repo,
      hasToken: Boolean(runtimeGitHubConfig.token),
      configured: Boolean(runtimeGitHubConfig.token && runtimeGitHubConfig.repo),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
