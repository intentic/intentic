import { fileURLToPath } from "node:url";
import { jest, type Mock } from "bun:test";

// Test helpers bun:test lacks: real-clock waits under fake timers, stubs that restore, async timer advance.

// Bun's fake timers freeze every clock and timer; Atomics.waitAsync and setImmediate alone stay on the real clock.
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const realSleep = async (ms: number): Promise<void> => {
    const wait = Atomics.waitAsync(sleepCell, 0, 0, ms);
    if (wait.async) {
        await wait.value;
    }
};

const realYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type WaitForOptions = { timeout?: number; interval?: number };

// An integration suite's wait bound, inside its 120 s budget: waitFor's 1 s default is no latency it means to assert.
export const SETTLES = { timeout: 30_000 } as const satisfies WaitForOptions;

// Retries `fn` on the real clock until it stops throwing/rejecting or `timeout` (1s) of sleeps has passed.
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

// Sets `globalThis[name]`, remembering the original for unstubAllGlobals.
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

// Sets `process.env[name]`, remembering the original for unstubAllEnvs.
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

// One timer per step, each after a yield so a continuation's timer exists, never past `ms` (bun's `advanceTimersByTime(0)` moves 1 ms).
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

// Fires every pending timer, capped at 10_000 rounds so an interval cannot spin forever.
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

// A type-level cast to the mock a module mock installed; the value passes through untouched.
export const mocked = <T>(item: T): Mocked<T> => item as Mocked<T>;

// A fresh module per call: bun keys a module by path and query, and keeps the query only on a filesystem path.
let freshCount = 0;
export const freshImport = <T>(specifier: string, from: string): Promise<T> => {
    freshCount += 1;
    const url = new URL(specifier, from);
    const target = url.protocol === `file:` ? fileURLToPath(url) : url.href;
    return import(`${target}?fresh=${freshCount}`) as Promise<T>;
};

export { realSleep, realYield };
