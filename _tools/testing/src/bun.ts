import { fileURLToPath } from "node:url";
import { jest, type Mock } from "bun:test";

// The vi.* surface bun:test lacks, with the same semantics: real-clock waits under fake timers, stubs that restore,
// and async timer advance that interleaves microtasks between timers.

// Under fake timers bun freezes every clock (Date, performance, hrtime) and every timer, a setTimeout captured
// beforehand included; Atomics.waitAsync and setImmediate are the two schedulers it leaves on the real clock.
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const realSleep = async (ms: number): Promise<void> => {
    const wait = Atomics.waitAsync(sleepCell, 0, 0, ms);
    if (wait.async) {
        await wait.value;
    }
};

const realYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type WaitForOptions = { timeout?: number; interval?: number };

// waitFor's 1s default is a latency bound no integration suite means to assert; 30s matches the 120s budget so a
// wait is not read as a hang.
export const SETTLES = { timeout: 30_000 } as const satisfies WaitForOptions;

// vi.waitFor: retries `fn` on the real clock until it stops throwing/rejecting or `timeout` (1s) of sleeps has passed.
export const waitFor = async <T>(fn: () => T | Promise<T>, { timeout = 1_000, interval = 50 }: WaitForOptions = {}): Promise<T> => {
    let slept = 0;
    let lastError: unknown;
    for (;;) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
        }
        if (slept >= timeout) {
            throw lastError instanceof Error ? lastError : new Error(`waitFor timed out after ${timeout}ms: ${String(lastError)}`);
        }
        await realSleep(interval);
        slept += interval;
    }
};

const globalStubs = new Map<string, PropertyDescriptor | undefined>();

// vi.stubGlobal: sets `globalThis[name]`, remembering the original for unstubAllGlobals.
export const stubGlobal = (name: string, value: unknown): void => {
    if (!globalStubs.has(name)) {
        globalStubs.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
};

export const unstubAllGlobals = (): void => {
    for (const [name, descriptor] of globalStubs) {
        if (descriptor === undefined) {
            delete (globalThis as Record<string, unknown>)[name];
        } else {
            Object.defineProperty(globalThis, name, descriptor);
        }
    }
    globalStubs.clear();
};

const envStubs = new Map<string, string | undefined>();

// vi.stubEnv: sets `process.env[name]`, remembering the original for unstubAllEnvs.
export const stubEnv = (name: string, value: string | undefined): void => {
    if (!envStubs.has(name)) {
        envStubs.set(name, process.env[name]);
    }
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
};

export const unstubAllEnvs = (): void => {
    for (const [name, value] of envStubs) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
    envStubs.clear();
};

// vi.advanceTimersByTimeAsync: yields first, so a timer a pending continuation schedules exists before the clock moves,
// then fires one timer per step up to the window's end and never past it (`advanceTimersByTime(0)` moves bun's clock
// 1 ms, so the walk ends on the deadline instead).
export const advanceTimersByTimeAsync = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    for (;;) {
        await realYield();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return;
        }
        // Fences the step at the window's edge: advanceTimersToNextTimer would otherwise jump to a later timer.
        const fence = setTimeout(() => {}, remaining);
        jest.advanceTimersToNextTimer();
        clearTimeout(fence);
    }
};

// vi.runAllTimersAsync, capped at 10_000 rounds so an interval cannot spin forever.
const RUN_ALL_ROUNDS = 10_000;

export const runAllTimersAsync = async (): Promise<void> => {
    for (let round = 0; jest.getTimerCount() > 0; round += 1) {
        if (round >= RUN_ALL_ROUNDS) {
            throw new Error(`runAllTimersAsync: ${RUN_ALL_ROUNDS} timers fired and more remain, an interval is likely rescheduling itself`);
        }
        jest.advanceTimersToNextTimer();
        await realYield();
    }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export type Mocked<T> = T extends AnyFn ? Mock<T> : { [K in keyof T]: T[K] extends AnyFn ? Mock<T[K]> : T[K] };

// vi.mocked: a type-level cast, the value passes through untouched.
export const mocked = <T>(item: T): Mocked<T> => item as Mocked<T>;

// vi.hoisted: bun's mock.module is never hoisted, so the thunk runs in place.
export const hoisted = <T>(factory: () => T): T => factory();

// vi.resetModules for one module: a fresh evaluation per call, since a query makes bun treat the path as a new
// module. The caller's `import.meta.url` resolves a relative specifier against the suite; the import takes a filesystem
// path, since bun keeps a query on a path specifier and strips it from a `file:` href.
let freshCount = 0;
export const freshImport = <T>(specifier: string, from: string): Promise<T> => {
    freshCount += 1;
    const url = new URL(specifier, from);
    const target = url.protocol === `file:` ? fileURLToPath(url) : url.href;
    return import(`${target}?fresh=${freshCount}`) as Promise<T>;
};

export { realSleep, realYield };
