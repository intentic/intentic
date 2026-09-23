import { afterAll } from "bun:test";
import vm from "node:vm";
import { JSDOM } from "./jsdom.js";

// Every jsdom window member that is not an ECMAScript intrinsic becomes a global, over the runtime's own but for KEEP_RUNTIME.

// Fake timers, a fetched Response and compared bytes belong to the runtime's realm, so these stay the runtime's.
const KEEP_RUNTIME = new Set<string>([
    `URL`,
    `URLSearchParams`,
    `Headers`,
    `AbortController`,
    `AbortSignal`,
    `TextEncoder`,
    `TextDecoder`,
    `performance`,
    `crypto`,
    `setTimeout`,
    `setInterval`,
    `clearTimeout`,
    `clearInterval`,
    `queueMicrotask`,
    `atob`,
    `btoa`,
    `onmessage`,
    `onerror`,
]);

// Intrinsics taken from the window anyway, so a buffer jsdom hands back passes `instanceof` in the code under test.
const WINDOW_REALM = [
    `ArrayBuffer`,
    `Uint8Array`,
    `Uint8ClampedArray`,
    `Uint16Array`,
    `Uint32Array`,
    `Int8Array`,
    `Int16Array`,
    `Int32Array`,
    `Float32Array`,
    `Float64Array`,
];

// Aliases of the global itself, set by hand below rather than copied.
const SKIP_KEYS = new Set<string>([`window`, `self`, `top`, `parent`, `constructor`]);

const INTRINSICS = new Set<string>(Object.getOwnPropertyNames(vm.runInNewContext(`globalThis`)));

type Global = Record<string, unknown>;

const isClassLikeName = (name: string): boolean => name[0] === name[0]?.toUpperCase();

// Every window member, own or inherited: a new one always, one the runtime already has unless it is its own to keep.
const windowKeys = (global: Global, win: Global): Set<string> => {
    const keys = new Set<string>(WINDOW_REALM);
    for (
        let level: object | null = win;
        level !== null && level !== (win[`Object`] as ObjectConstructor).prototype;
        level = Object.getPrototypeOf(level)
    ) {
        for (const key of Object.getOwnPropertyNames(level)) {
            if (!SKIP_KEYS.has(key) && (!(key in global) || (!INTRINSICS.has(key) && !KEEP_RUNTIME.has(key)))) {
                keys.add(key);
            }
        }
    }
    return keys;
};

const populateGlobal = (global: Global, win: Global): void => {
    const overrides = new Map<string, unknown>();
    for (const key of windowKeys(global, win)) {
        const value = win[key];
        const bound = typeof value === `function` && !isClassLikeName(key) ? (value as (...args: unknown[]) => unknown).bind(win) : undefined;
        Object.defineProperty(global, key, {
            get: () => (overrides.has(key) ? overrides.get(key) : (bound ?? win[key])),
            set: (next: unknown) => {
                overrides.set(key, next);
            },
            configurable: true,
        });
    }
    global[`window`] = global;
    global[`self`] = global;
    global[`top`] = global;
    global[`parent`] = global;
    const document = global[`document`] as { defaultView?: unknown } | undefined;
    if (document?.defaultView !== undefined) {
        Object.defineProperty(document, `defaultView`, { get: () => global, enumerable: true, configurable: true });
    }
};

// A DOM error handler that throws fails the file unless the suite listens for `error` itself.
const catchWindowErrors = (win: Window): void => {
    let userErrorListeners = 0;
    win.addEventListener(`error`, (event) => {
        if (userErrorListeners === 0 && event.error != null) {
            event.preventDefault();
            queueMicrotask(() => {
                throw event.error;
            });
        }
    });
    const add = win.addEventListener.bind(win);
    const remove = win.removeEventListener.bind(win);
    win.addEventListener = ((...args: Parameters<Window[`addEventListener`]>) => {
        if (args[0] === `error`) {
            userErrorListeners += 1;
        }
        return add(...args);
    }) as Window[`addEventListener`];
    win.removeEventListener = ((...args: Parameters<Window[`removeEventListener`]>) => {
        if (args[0] === `error` && userErrorListeners > 0) {
            userErrorListeners -= 1;
        }
        return remove(...args);
    }) as Window[`removeEventListener`];
};

// jsdom's EventTarget wants its own AbortSignal; a Node signal handed to addEventListener is bridged to one.
const patchAddEventListener = (win: Global): void => {
    const controllers = new WeakMap<AbortSignal, AbortController>();
    const JsdomAbortSignal = win[`AbortSignal`] as typeof AbortSignal;
    const JsdomAbortController = win[`AbortController`] as typeof AbortController;
    const proto = (win[`EventTarget`] as typeof EventTarget).prototype;
    const original = proto.addEventListener;
    const bridged = (signal: AbortSignal): AbortSignal => {
        let controller = controllers.get(signal);
        if (controller === undefined) {
            controller = new JsdomAbortController();
            const forward = controller;
            signal.addEventListener(`abort`, () => forward.abort(signal.reason));
            controllers.set(signal, controller);
        }
        return controller.signal;
    };
    proto.addEventListener = function addEventListener(this: EventTarget, ...args: Parameters<EventTarget[`addEventListener`]>) {
        const [type, callback, options] = args;
        if (typeof options === `object` && options?.signal != null && !(options.signal instanceof JsdomAbortSignal)) {
            return original.call(this, type, callback, { ...options, signal: bridged(options.signal) });
        }
        return original.apply(this, args);
    };
};

const dom = new JSDOM(`<!DOCTYPE html>`, { pretendToBeVisual: true, url: `http://localhost:3000`, runScripts: `dangerously` });
const win = dom.window as unknown as Global;
const global = globalThis as unknown as Global;

// Before the runtime's signal classes replace jsdom's on the window: the bridge below keys on jsdom's own.
patchAddEventListener(win);

// jsdom lacks structuredClone and the encoders; the fetch family is always the runtime's, so a Response is its fetch's own.
for (const name of [`structuredClone`, `TextEncoder`, `TextDecoder`]) {
    if (global[name] !== undefined && win[name] === undefined) {
        win[name] = global[name];
    }
}
for (const name of [`fetch`, `Response`, `Headers`, `AbortController`, `AbortSignal`, `URLSearchParams`]) {
    if (global[name] !== undefined) {
        win[name] = global[name];
    }
}

catchWindowErrors(dom.window as unknown as Window);
populateGlobal(global, win);

// pretendToBeVisual's frame clock keeps an unclosed window resident in the worker for every later file.
afterAll(() => {
    dom.window.close();
});

export { dom };
