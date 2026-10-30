/**
 * Ambient type shim for Bun's test runner under `tsc --noEmit`.
 *
 * Bun executes tests with its own runtime (where 'bun:test' resolves natively),
 * but plain `tsc` has no type declarations for it. This ambient module keeps
 * `tsc --noEmit` at ZERO errors across the test suite without pulling the
 * full bun-types DOM surface into the Next.js build. It declares only the
 * surface the suite actually uses.
 */
declare module 'bun:test' {
  type TestFn = (() => void | Promise<unknown>) | ((done: (err?: Error) => void) => void);

  interface Expect<T = unknown> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeNaN(): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toContain(item: unknown): void;
    toContainEqual(item: unknown): void;
    toMatchObject(expected: Record<string, unknown>): void;
    toHaveLength(n: number): void;
    toMatch(pattern: RegExp | string): void;
    toHaveProperty(prop: string | string[], value?: unknown): void;
    toThrow(error?: RegExp | string | ErrorConstructor): void;
    resolves: Expect<T>;
    rejects: { toThrow(error?: RegExp | string): Promise<void> };
    not: Expect<T>;
  }

  function describe(name: string, fn: () => void): void;
  function test(name: string, fn: TestFn, timeoutMs?: number): void;
  function it(name: string, fn: TestFn, timeoutMs?: number): void;
  function expect<T = unknown>(actual: T): Expect<T>;
  function beforeAll(fn: () => void | Promise<unknown>): void;
  function afterAll(fn: () => void | Promise<unknown>): void;
  function beforeEach(fn: () => void | Promise<unknown>): void;
  function afterEach(fn: () => void | Promise<unknown>): void;
  function skip(name: string, fn: TestFn, timeoutMs?: number): void;
  function todo(name: string): void;

  interface MockFn {
    (...args: unknown[]): unknown;
    mock: {
      calls: unknown[][];
      results: { type: 'return' | 'throw'; value: unknown }[];
      implementations: ((...args: unknown[]) => unknown)[];
    };
    mockImplementation(impl: (...args: unknown[]) => unknown): MockFn;
    mockReturnValue(value: unknown): MockFn;
    mockResolvedValue(value: unknown): MockFn;
    mockRejectedValue(value: unknown): MockFn;
    mockClear(): void;
    mockReset(): void;
  }

  const mock: {
    fn(impl?: (...args: unknown[]) => unknown): MockFn;
    <T extends (...args: never[]) => unknown>(fn?: T): MockFn & T;
    module(
      spec: string,
      factory: () => unknown,
      options?: { virtual?: boolean; from?: string | string[] },
    ): void;
    restore(): void;
    clearAllMocks(): void;
    resetAllMocks(): void;
  };
}
