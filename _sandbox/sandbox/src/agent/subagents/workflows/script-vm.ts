import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import { type ResultValue, ResultValueSchema } from "../child-result.js";

/* WHERE A WORKFLOW SCRIPT RUNS: a QuickJS interpreter compiled to WebAssembly, inside the daemon but sealed from it. A
   script is code an agent wrote, and the daemon holds what no agent should reach (every secret, every conversation), so
   it runs where there is no module, no file, no network, no process and nothing of the daemon's own, only what is handed
   in: `agent`, `phase` and `log`, each crossing as JSON text. Its clock and its randomness are taken away too, so a script
   run again over the same results makes the same calls in the same order, which is what lets a restart or a resume hand
   finished calls back instead of paying for them twice (script-runs.ts). Memory, stack and every stretch of synchronous
   code are bounded, so a loop that never yields stops rather than freezing the daemon's thread. */

export interface ScriptHost {
    // One agent() call: its prompt and its options as the script gave them; answers the value the script receives, or
    // throws the error it sees.
    readonly agent: (prompt: string, options: ResultValue) => Promise<ResultValue>;
    readonly phase: (title: string) => void;
    readonly log: (line: string) => void;
}

export interface ScriptLimits {
    readonly memoryBytes: number;
    readonly stackBytes: number;
    // The longest the script may run without yielding, each time the daemon hands it control.
    readonly syncMs: number;
}

const SCRIPT_LIMITS: ScriptLimits = { memoryBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024, syncMs: 1_000 };

// What the script sees besides its own code: the helpers, written in the script's own language over the three host calls,
// with the clock and randomness gone.
const PRELUDE = `
"use strict";
delete globalThis.Date;
Math.random = undefined;
Object.freeze(Math);
const __fail = (where, error) => __log(where + ": " + String(error && error.message !== undefined ? error.message : error));
globalThis.agent = (prompt, options) =>
    __agent(String(prompt), JSON.stringify(options === undefined ? {} : options)).then((text) => JSON.parse(text));
globalThis.parallel = (thunks) => {
    if (!Array.isArray(thunks)) throw new TypeError("parallel takes an array of functions");
    return Promise.all(thunks.map(async (thunk) => {
        try { return await thunk(); } catch (error) { __fail("parallel", error); return null; }
    }));
};
globalThis.pipeline = (items, ...stages) => {
    if (!Array.isArray(items)) throw new TypeError("pipeline takes an array of items first");
    return Promise.all(items.map(async (item, index) => {
        try {
            let value = item;
            for (const stage of stages) value = await stage(value, item, index);
            return value;
        } catch (error) { __fail("pipeline", error); return null; }
    }));
};
globalThis.phase = (title) => __phase(String(title));
globalThis.log = (...parts) => __log(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" "));
globalThis.args = JSON.parse(__args);
`;

// An error thrown inside the sandbox comes out as a plain object (its name, message and stack), not an Error.
const ThrownSchema = z.object({ message: z.string() });
const thrownIn = (vm: QuickJSContext, handle: QuickJSHandle): string => {
    const dumped = ThrownSchema.safeParse(vm.dump(handle));
    handle.dispose();
    return dumped.success ? dumped.data.message : "the script threw something that is not an error";
};

let loading: Promise<QuickJSWASMModule> | undefined;
const quickjs = (): Promise<QuickJSWASMModule> => {
    // The single-file build: its WebAssembly travels inside the module, so the image needs no sidecar file for it.
    loading ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-singlefile-cjs-release-sync"));
    return loading;
};

// A JSON text from the script read as a value; anything that is not JSON is the script's mistake, said as such.
const jsonOf = (text: string, what: string): ResultValue => {
    let parsed: ResultValue;
    try {
        // SAFETY: JSON.parse yields exactly the JSON value grammar; the schema below checks it is one.
        parsed = JSON.parse(text) as ResultValue;
    } catch {
        throw new Error(`${what} is not JSON`);
    }
    const checked = ResultValueSchema.safeParse(parsed);
    if (!checked.success) {
        throw new Error(`${what} is not JSON`);
    }
    return checked.data;
};

/** A meta literal's value, read in a sandbox of its own with nothing to call; or why it is not a plain literal. */
export const readLiteral = async (literal: string, limits: ScriptLimits = SCRIPT_LIMITS): Promise<{ readonly value: ResultValue } | { readonly fault: string }> => {
    const runtime = (await quickjs()).newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const deadline = Date.now() + limits.syncMs;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const vm = runtime.newContext();
    try {
        const evaluated = vm.evalCode(`JSON.stringify((${literal}))`);
        if (evaluated.error !== undefined) {
            return { fault: `The meta literal cannot be read: ${thrownIn(vm, evaluated.error)}` };
        }
        const text = vm.getString(evaluated.value);
        evaluated.value.dispose();
        return { value: jsonOf(text, "The meta literal") };
    } catch (error) {
        return { fault: errorMessage(error) };
    } finally {
        vm.dispose();
        runtime.dispose();
    }
};

// One run's sandbox: its interpreter, the calls still open in it, and the door that hands it control.
interface Sandbox {
    readonly vm: QuickJSContext;
    // Runs `work` inside the sandbox for no longer than its bound: every way into the script goes through here.
    readonly bounded: <T>(work: () => T) => T;
    // Hands the script control, for no longer than its bound; what it ran into, if it ran into anything.
    readonly pump: () => string | undefined;
    // Settles one open call with its value as JSON text, or its error; the first thing the script then ran into stays.
    readonly settle: (deferred: QuickJSDeferredPromise, outcome: { readonly text: string } | { readonly error: string }) => void;
    readonly open: Set<QuickJSDeferredPromise>;
    readonly fatal: () => string | undefined;
    readonly close: () => void;
}

const openSandbox = (runtime: QuickJSRuntime, limits: ScriptLimits, signal: AbortSignal): Sandbox => {
    let deadline = Number.POSITIVE_INFINITY;
    runtime.setInterruptHandler(() => signal.aborted || Date.now() > deadline);
    const vm = runtime.newContext();
    const open = new Set<QuickJSDeferredPromise>();
    let closed = false;
    let fatal: string | undefined;
    const bounded = <T,>(work: () => T): T => {
        deadline = Date.now() + limits.syncMs;
        try {
            return work();
        } finally {
            deadline = Number.POSITIVE_INFINITY;
        }
    };
    const pump = (): string | undefined => {
        const ran = bounded(() => runtime.executePendingJobs());
        const why = ran.error === undefined ? undefined : thrownIn(vm, ran.error);
        fatal ??= why;
        return why;
    };
    return {
        vm,
        bounded,
        pump,
        open,
        fatal: () => fatal,
        settle: (deferred, outcome) => {
            if (closed || !open.delete(deferred)) {
                return;
            }
            const handle = "text" in outcome ? vm.newString(outcome.text) : vm.newError(outcome.error);
            if ("text" in outcome) {
                deferred.resolve(handle);
            } else {
                deferred.reject(handle);
            }
            handle.dispose();
            deferred.dispose();
            pump();
        },
        close: () => {
            closed = true;
            for (const deferred of open) {
                deferred.dispose();
            }
            open.clear();
            vm.dispose();
        },
    };
};

// What the script can call, each crossing as JSON text, and its `args`.
const installHost = (sandbox: Sandbox, host: ScriptHost, args: ResultValue): void => {
    const { vm } = sandbox;
    const install = (name: string, make: (...handles: QuickJSHandle[]) => QuickJSHandle | undefined): void => {
        const fn = vm.newFunction(name, make);
        vm.setProp(vm.global, name, fn);
        fn.dispose();
    };
    install("__agent", (promptHandle, optionsHandle) => {
        const deferred = vm.newPromise();
        sandbox.open.add(deferred);
        const prompt = promptHandle === undefined ? "" : vm.getString(promptHandle);
        const optionsText = optionsHandle === undefined ? "{}" : vm.getString(optionsHandle);
        void (async (): Promise<void> => {
            try {
                const value = await host.agent(prompt, jsonOf(optionsText, "agent()'s options"));
                sandbox.settle(deferred, { text: JSON.stringify(value) });
            } catch (error) {
                sandbox.settle(deferred, { error: errorMessage(error) });
            }
        })();
        return deferred.handle;
    });
    install("__phase", (title) => {
        host.phase(title === undefined ? "" : vm.getString(title));
        return undefined;
    });
    install("__log", (line) => {
        host.log(line === undefined ? "" : vm.getString(line));
        return undefined;
    });
    const argsHandle = vm.newString(JSON.stringify(args));
    vm.setProp(vm.global, "__args", argsHandle);
    argsHandle.dispose();
};

// Settles when the run is stopped, at once if it already was.
const whenStopped = (signal: AbortSignal): Promise<{ readonly kind: "stopped" }> =>
    new Promise((resolve) => {
        const stop = (): void => resolve({ kind: "stopped" });
        if (signal.aborted) {
            stop();
        }
        signal.addEventListener("abort", stop, { once: true });
    });

// The prelude, then the body as an async function: the promise of its ending, or why it never started.
const started = (sandbox: Sandbox, body: string): QuickJSHandle | { readonly error: string } => {
    const { vm } = sandbox;
    const prelude = sandbox.bounded(() => vm.evalCode(PRELUDE, "prelude.js"));
    if (prelude.error !== undefined) {
        return { error: `The workflow's sandbox could not start: ${thrownIn(vm, prelude.error)}` };
    }
    prelude.value.dispose();
    const evaluated = sandbox.bounded(() => vm.evalCode(`(async () => {\n${body}\n})()`, "workflow.js"));
    return evaluated.error === undefined ? evaluated.value : { error: `The script does not run: ${thrownIn(vm, evaluated.error)}` };
};

/**
 * Runs a script's body to its end: the value it returns, or the error it ended on. `signal` stops it, failing every call
 * still open in it. Calls it started and never awaited are the caller's to settle once this answers.
 */
export const runScript = async (
    body: string,
    args: ResultValue,
    host: ScriptHost,
    signal: AbortSignal,
    limits: ScriptLimits = SCRIPT_LIMITS,
): Promise<{ readonly value: ResultValue } | { readonly error: string }> => {
    const runtime = (await quickjs()).newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const sandbox = openSandbox(runtime, limits, signal);
    const { vm } = sandbox;
    try {
        installHost(sandbox, host, args);
        const promise = started(sandbox, body);
        if ("error" in promise) {
            return promise;
        }
        const ending = vm.resolvePromise(promise);
        promise.dispose();
        const fatal = sandbox.pump();
        if (fatal !== undefined) {
            return { error: fatal };
        }
        const raced = await Promise.race([ending.then((result) => ({ kind: "ended" as const, result })), whenStopped(signal)]);
        if (raced.kind === "stopped") {
            return { error: "The workflow was stopped." };
        }
        if (raced.result.error !== undefined) {
            const why = thrownIn(vm, raced.result.error);
            return { error: sandbox.fatal() ?? why };
        }
        const returned = vm.dump(raced.result.value);
        raced.result.value.dispose();
        return { value: jsonOf(JSON.stringify(returned ?? null), "What the workflow returned") };
    } catch (error) {
        return { error: errorMessage(error) };
    } finally {
        sandbox.close();
        runtime.dispose();
    }
};
