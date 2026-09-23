import { sandboxScopeGuard, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { watch } from "vue";
import { SandboxHttpError } from "./sandboxHttpError";
import { useEndpoint } from "../secrets/useEndpoint";

// A value fetched per workspace path, on first ask, from a daemon that may not have an address yet. Shared by the
// attachment thumbnail cache and the attachment text peek, which differ only in what one path fetches: the race
// against the sandbox's boot, and what counts as a final refusal, are the same question for both.

// The daemon's final answer: gone (404), refused (400), or over the route's size ceiling (413). Anything else says
// nothing about the file (no endpoint yet, a dropped connection, a mid-boot 5xx).
const isRefusal = (error: unknown): boolean => error instanceof SandboxHttpError && [400, 404, 413].includes(error.status);

// Backoff schedule for a fetch that may just be racing the daemon's boot; running out ends the chain, not the path.
const RETRY_MS = [200, 600, 1_500, 4_000, 8_000];

export interface LazyByPath<T> {
    /** The cached value, starting the fetch on first ask. Undefined while in flight, and forever once refused. */
    readonly get: (path: string) => T | undefined;
    /** The cached value if there already is one, asking nothing of the daemon for a path that has none. */
    readonly cached: (path: string) => T | undefined;
    /** Files a value this window already holds, so nothing is asked of the daemon for that path. */
    readonly put: (path: string, value: T) => void;
    /** Forgets a path, so the next ask fetches it again. */
    readonly drop: (path: string) => void;
}

export const lazyByPath = <T>(load: (path: string) => Promise<T>): LazyByPath<T> => {
    // All of it one sandbox's: a path names a file on the daemon it was read from, so a switch starts the cache over,
    // lets go of the chains sleeping for the old one, and drops whatever answer that one still sends.
    // Shallow: entries are replaced wholesale, never mutated, so deep reactivity would only cost traversals.
    const values = sandboxShallowRef<Record<string, T>>(() => ({}));
    // Every path anything has asked about, whatever came of it; the set a newly resolved address re-tries.
    const asked = sandboxValue(() => new Set<string>());
    // Paths with an attempt chain running, including backoff sleeps; a path leaves only when its chain ends.
    const loading = sandboxValue(() => new Set<string>());
    // The timer of a chain waiting out backoff, so a resolved address can cancel it and retry immediately.
    const sleeping = sandboxValue(
        () => new Map<string, ReturnType<typeof setTimeout>>(),
        (timers) => timers.forEach((timer) => clearTimeout(timer)),
    );
    // Paths the daemon refused for good; these stay parked and the caller keeps drawing whatever it has without one.
    const refused = sandboxValue(() => new Set<string>());

    const attempt = (path: string, tries = 0): void => {
        const here = sandboxScopeGuard();
        loading.value.add(path);
        void load(path).then(
            (value) => {
                if (!here()) {
                    return;
                }
                loading.value.delete(path);
                values.value = { ...values.value, [path]: value };
            },
            (error: unknown) => {
                if (!here()) {
                    return;
                }
                if (isRefusal(error)) {
                    loading.value.delete(path);
                    refused.value.add(path);
                    return;
                }
                const delay = RETRY_MS[tries];
                if (delay === undefined) {
                    loading.value.delete(path);
                    return;
                }
                // Still claimed while the chain sleeps: dropping it would let a re-render start a second chain beside it.
                sleeping.value.set(
                    path,
                    setTimeout(() => {
                        sleeping.value.delete(path);
                        attempt(path, tries + 1);
                    }, delay),
                );
            },
        );
    };

    // Restarts any backoff-waiting chain once an address resolves; those attempts had nothing to test against.
    watch(useEndpoint().daemonBase, (base) => {
        if (base === undefined || base === ``) {
            return;
        }
        for (const path of asked.value) {
            if (values.value[path] !== undefined || refused.value.has(path)) {
                continue;
            }
            const timer = sleeping.value.get(path);
            if (timer !== undefined) {
                clearTimeout(timer);
                sleeping.value.delete(path);
            } else if (loading.value.has(path)) {
                // A request already on the wire: its own handler carries the chain from here.
                continue;
            }
            attempt(path);
        }
    });

    return {
        get: (path) => {
            const cached = values.value[path];
            if (cached !== undefined) {
                return cached;
            }
            asked.value.add(path);
            if (!loading.value.has(path) && !refused.value.has(path)) {
                attempt(path);
            }
            return undefined;
        },
        cached: (path) => values.value[path],
        put: (path, value) => {
            asked.value.add(path);
            values.value = { ...values.value, [path]: value };
        },
        drop: (path) => {
            asked.value.delete(path);
            // Every trace of the path, or the next ask answers from a parked refusal or a chain still mid-backoff.
            refused.value.delete(path);
            loading.value.delete(path);
            const timer = sleeping.value.get(path);
            if (timer !== undefined) {
                clearTimeout(timer);
                sleeping.value.delete(path);
            }
            const { [path]: _dropped, ...rest } = values.value;
            values.value = rest;
        },
    };
};
