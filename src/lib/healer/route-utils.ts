/**
 * Clean path-based routing utilities for the API-HEALER Control Plane.
 * Maps PageId <-> clean URL paths ('/', '/playground', '/cold-path', '/contracts', '/workers', '/integrate')
 * while gracefully canonicalizing legacy '?page=...' query URLs.
 */

export const PAGES = [
  'home',
  'playground',
  'cold-path',
  'contracts',
  'workers',
  'integrate',
  'audit',
] as const;

export type PageId = (typeof PAGES)[number];

export function isValidPageId(value: string | null | undefined): value is PageId {
  if (!value) return false;
  return (PAGES as readonly string[]).includes(value);
}

export function pageToPath(page: PageId): string {
  return page === 'home' ? '/' : `/${page}`;
}

export interface ResolvedRoute {
  page: PageId;
  canonicalPath: string;
  needsCanonicalReplace: boolean;
}

/**
 * Resolves the active PageId from a URL pathname and optional query string.
 * - Clean paths like '/workers' -> page: 'workers', canonicalPath: '/workers'
 * - Root path '/' with legacy '?page=workers' -> page: 'workers', canonicalPath: '/workers', needsCanonicalReplace: true
 * - Root path '/' -> page: 'home', canonicalPath: '/'
 */
export function resolvePageFromUrl(pathname: string, search = ''): ResolvedRoute {
  const cleanSegment = pathname.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';

  if (cleanSegment && isValidPageId(cleanSegment)) {
    const canonicalPath = pageToPath(cleanSegment);
    const hasLegacyQuery = search.includes('page=');
    return {
      page: cleanSegment,
      canonicalPath,
      needsCanonicalReplace: hasLegacyQuery || pathname !== canonicalPath,
    };
  }

  if (search) {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
    const queryPage = params.get('page');
    if (isValidPageId(queryPage)) {
      const canonicalPath = pageToPath(queryPage);
      return {
        page: queryPage,
        canonicalPath,
        needsCanonicalReplace: true,
      };
    }
  }

  return {
    page: 'home',
    canonicalPath: '/',
    needsCanonicalReplace: cleanSegment.length > 0,
  };
}
