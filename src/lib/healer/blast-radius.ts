/**
 * API-HEALER · AST Blast-Radius Locator (Step 3 · the map maker, server half)
 * ----------------------------------------------------------------------------
 * Scans a consumer codebase and pinpoints exactly which files and lines
 * consume a protected endpoint — `services/checkout.ts:42` — so the automated
 * PR can point at real code instead of abstract JSON.
 *
 * Strategy:
 *   1. Walk the repo (code extensions only; node_modules/.git/.next skipped;
 *      file-count and size capped) relative to the tool's workspace root.
 *   2. Parse each file with the TypeScript compiler AST (dynamic import —
 *      falls back to a line scanner if the compiler is unavailable).
 *   3. Collect call expressions of fetch/healerFetch/healPayload whose first
 *      argument (or a nearby option object) references the endpoint or the
 *      contract id — record file:line:col + trimmed snippet + enclosing fn.
 *
 * The scanner reads code files only and returns call-site snippets (≤200
 * chars), never whole-file contents — no secret exfiltration surface.
 */
import { promises as fs } from 'fs';
import { join, relative, resolve, sep } from 'path';

export interface BlastRadiusMatch {
  file: string;
  line: number;
  column: number;
  kind: 'ast' | 'regex';
  callee: string;
  enclosing: string | null;
  snippet: string;
}

export interface BlastRadiusReport {
  root: string;
  scannedFiles: number;
  skipped: number;
  matches: BlastRadiusMatch[];
  parser: 'typescript-ast' | 'regex';
  truncated: boolean;
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage',
  '.turbo', '.cache', 'vendor', '__pycache__',
]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_MATCHES = 80;

const TARGET_CALLEES = new Set(['fetch', 'healerFetch', 'healPayload', 'axios', 'got', 'ofetch']);

function snippetOf(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

/** Recursively collect candidate code files (bounded). */
async function walkFiles(root: string): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const queue: string[] = [root];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift() as string;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped++;
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        queue.push(full);
      } else if (e.isFile()) {
        if (!CODE_EXT.has(e.name.slice(e.name.lastIndexOf('.')))) continue;
        if (files.length >= MAX_FILES) {
          skipped++;
          continue;
        }
        files.push(full);
      }
    }
  }
  return { files, skipped };
}

interface TsModule {
  createSourceFile: (name: string, text: string, target: number, setParent: boolean) => unknown;
  forEachChild: (node: unknown, cb: (child: unknown) => void) => void;
  ScriptTarget: { ES2022: number };
  SyntaxKind: Record<string, number | string>;
  isIdentifier: (n: unknown) => boolean;
  isStringLiteral: (n: unknown) => boolean;
  isObjectLiteralExpression: (n: unknown) => boolean;
  isPropertyAssignment: (n: unknown) => boolean;
  getTokenPosOfNode: (sf: unknown, n: unknown) => number;
}

/** Lazily load the TypeScript compiler (present in every TS project). */
async function loadTs(): Promise<TsModule | null> {
  try {
    const mod = (await import('typescript')) as unknown as TsModule & { default?: TsModule };
    return (mod.default ?? mod) as TsModule;
  } catch {
    return null;
  }
}

// Minimal structural helpers so we avoid any `any` while staying pragmatic.
function nodeText(ts: TsModule, sf: unknown, n: unknown): string {
  const src = (sf as { getFullText: () => string; getText: () => string }).getText();
  const start = (n as { getStart?: (sf?: unknown) => number }).getStart?.(sf) ?? 0;
  const end = (n as { getEnd?: () => number }).getEnd?.() ?? start;
  return src.slice(start, end);
}
function nodeLine(sf: unknown, n: unknown): { line: number; column: number } {
  const src = (sf as { getText: () => string }).getText();
  const start = (n as { getStart?: (sf?: unknown) => number }).getStart?.(sf) ?? 0;
  const before = src.slice(0, start);
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}
function kindOf(n: unknown): number {
  return (n as { kind: number }).kind;
}
function kindName(ts: TsModule, n: unknown): string {
  return String(ts.SyntaxKind[kindOf(n)] ?? '');
}

/** Full AST traversal via the compiler's own child iterator. */
function walkAst(ts: TsModule, node: unknown, visit: (n: unknown) => void): void {
  visit(node);
  try {
    ts.forEachChild(node, (child) => walkAst(ts, child, visit));
  } catch {
    /* malformed node — skip subtree */
  }
}

function enclosingFunctionName(ts: TsModule, sf: unknown, node: unknown): string | null {
  const FN_KINDS = new Set(['FunctionDeclaration', 'MethodDeclaration', 'ArrowFunction', 'FunctionExpression', 'GetAccessor', 'SetAccessor']);
  let cur = (node as { parent?: unknown }).parent;
  while (cur) {
    if (FN_KINDS.has(kindName(ts, cur))) {
      const name = (cur as { name?: { text?: string } }).name?.text;
      return name ?? '<anonymous>';
    }
    cur = (cur as { parent?: unknown }).parent;
  }
  return null;
}

function matchesTarget(endpoint: string, contractId: string | null, text: string): boolean {
  if (!text) return false;
  if (endpoint && text.includes(endpoint)) return true;
  // endpoint stored as path — match its tail too (host may differ in code)
  if (endpoint.startsWith('http')) {
    try {
      const u = new URL(endpoint);
      if (u.pathname && u.pathname !== '/' && text.includes(u.pathname)) return true;
    } catch {
      /* ignore */
    }
  }
  if (contractId && text.includes(contractId)) return true;
  return false;
}

/** Scan a codebase root for consumers of the endpoint / contract id. */
export async function scanBlastRadius(params: {
  root: string;
  endpoint: string;
  contractId?: string | null;
}): Promise<BlastRadiusReport> {
  const root = resolve(params.root);
  const { files, skipped } = await walkFiles(root);
  const matches: BlastRadiusMatch[] = [];
  const ts = await loadTs();
  const parser: 'typescript-ast' | 'regex' = ts ? 'typescript-ast' : 'regex';
  let truncated = false;

  for (const abs of files) {
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    let text: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, abs).split(sep).join('/');

    if (ts) {
      const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true);
      const calls: unknown[] = [];
      walkAst(ts, sf, (n) => {
        if (kindOf(n) === ts.SyntaxKind.CallExpression) calls.push(n);
      });
      for (const call of calls) {
        const expr = (call as { expression?: unknown }).expression;
        const callee = ts.isIdentifier(expr)
          ? ((expr as { text: string }).text)
          : nodeText(ts, sf, expr).slice(0, 60);
        if (!TARGET_CALLEES.has(callee)) continue;
        const args = (call as { arguments?: unknown[] }).arguments ?? [];
        const argText = args.map((a) => nodeText(ts, sf, a)).join(' ');
        const full = nodeText(ts, sf, call);
        if (!matchesTarget(params.endpoint, params.contractId ?? null, `${argText} ${full}`)) continue;
        const { line, column } = nodeLine(sf, call);
        matches.push({
          file: rel,
          line,
          column,
          kind: 'ast',
          callee,
          enclosing: enclosingFunctionName(ts, sf, call),
          snippet: snippetOf(full),
        });
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
    } else {
      // Regex fallback — line-precise, still useful without the compiler
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const m = l.match(/\b(fetch|healerFetch|healPayload|axios|got|ofetch)\s*\(/);
        if (!m) continue;
        const window = lines.slice(i, i + 6).join(' ');
        if (!matchesTarget(params.endpoint, params.contractId ?? null, window)) continue;
        matches.push({
          file: rel,
          line: i + 1,
          column: (m.index ?? 0) + 1,
          kind: 'regex',
          callee: m[1],
          enclosing: null,
          snippet: snippetOf(window),
        });
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
  }

  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { root, scannedFiles: files.length, skipped, matches, parser, truncated };
}
