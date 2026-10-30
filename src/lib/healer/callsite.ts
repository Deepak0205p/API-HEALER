/**
 * API-HEALER · Callsite capture (Step 3 · blast-radius sensor, client half)
 * ---------------------------------------------------------------------------
 * The drop-in client captures WHERE in the consumer's code the drifting
 * upstream is consumed — `services/checkout.ts:42` — by parsing the Error
 * stack at the heal call. Zero dependencies, best-effort, never throws.
 * The server stores it on the DriftEvent, shows it in the inspector, and
 * attaches it to the automated PR ("blast radius" section).
 */

/** Frames that are healer internals / runtime noise, never the consumer. */
const NOISE = [
  'node:internal',
  'node_modules',
  'api-healer-client',
  'healerFetch',
  'healPayload',
  'healRequest',
  'api-healer',
  'instrumentation',
  'async_hooks',
  'internal/process',
];

/**
 * Parse a raw Error stack into the most useful consumer frame:
 * "services/checkout.ts:42:10" → normalized to "services/checkout.ts:42".
 * Accepts V8 (Node/Bun/Chrome) and SpiderMonkey/JSC (Deno) formats.
 */
export function parseCallsite(stack: string | undefined | null): string | null {
  if (!stack) return null;
  const lines = stack.split('\n').slice(1); // drop the "Error" header line
  for (const raw of lines) {
    let frame = raw.trim();
    if (frame.startsWith('at ')) frame = frame.slice(3);
    else if (!frame.includes('@')) continue; // SpiderMonkey "fn@file:1:2" has no 'at'
    if (NOISE.some((n) => frame.includes(n))) continue;
    if (frame.startsWith('new Promise') || frame === 'Array.forEach') continue;
    if (frame.includes('<anonymous>')) continue;

    let file: string | null = null;
    let lineNo: number | null = null;

    // V8 paren form: "fn (/path/file.ts:42:10)" (line/col optional)
    const paren = frame.match(/\((.+?)(?::(\d+))?(?::(\d+))?\)$/);
    // SpiderMonkey/JSC: "fn@/path/file.ts:42:10" — checked BEFORE the bare
    // form so the "fn@" prefix is never swallowed into the file path.
    const sm = paren ? null : frame.includes('@') ? frame.match(/^(?:.*@)?(.+?):(\d+):\d+$/) : null;
    // bare V8: "/path/file.ts:42:10"
    const bare = paren || sm ? null : frame.match(/^(.+?):(\d+):\d+$/);

    if (paren) {
      file = paren[1];
      lineNo = paren[2] ? Number(paren[2]) : null;
    } else if (sm) {
      file = sm[1];
      lineNo = Number(sm[2]);
    } else if (bare) {
      file = bare[1];
      lineNo = Number(bare[2]);
    }
    if (!file || file === '') continue;
    if (file.startsWith('file://')) file = file.slice(7);
    // strip up to and including the workspace root markers for a relative look
    const norm = file.replace(/^\/?home\/[^/]+\//, '').replace(/^\/?Users\/[^/]+\//, '');
    const out = lineNo ? `${norm}:${lineNo}` : norm;
    return out.length > 180 ? out.slice(-180) : out;
  }
  return null;
}

/** Capture the callsite from the current execution context (never throws). */
export function captureCallsite(): string | null {
  try {
    const err = new Error('api-healer-callsite');
    // Re-walk the fresh stack; Error.captureStackTrace keeps it cheap on V8.
    return parseCallsite(err.stack);
  } catch {
    return null;
  }
}
