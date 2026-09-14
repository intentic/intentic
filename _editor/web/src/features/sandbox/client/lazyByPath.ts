import { shallowRef, watch } from "vue";
import { SandboxHttpError } from "./sandboxClient";
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
    // shallowRef: entries are replaced wholesale, never mutated, so deep reactivity would only cost traversals.
    const values = shallowRef<Record<string, T>>({});
    // Every path anything has asked about, whatever came of it; the set a newly resolved address re-tries.
    const asked = new Set<string>();
    // Paths with an attempt chain running, including backoff sleeps; a path leaves only when its chain ends.
    const loading = new Set<string>();
    // The timer of a chain waiting out backoff, so a resolved address can cancel it and retry immediately.
    const sleeping = new Map<string, ReturnType<typeof setTimeout>>();
    // Paths the daemon refused for good; these stay parked and the caller keeps drawing whatever it has without one.
    const refused = new Set<string>();

    const attempt = (path: string, tries = 0): void => {
        loading.add(path);
        void load(path).then(
            (value) => {
                loading.delete(path);
                values.value = { ...values.value, [path]: value };
            },
            (error: unknown) => {
                if (isRefusal(error)) {
                    loading.delete(path);
                    refused.add(path);
                    return;
                }
                const delay = RETRY_MS[tries];
                if (delay === undefined) {
                    loading.delete(path);
                    return;
                }
                // Still claimed while the chain sleeps: dropping it would let a re-render start a second chain beside it.
                sleeping.set(
                    path,
                    setTimeout(() => {
                        sleeping.delete(path);
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
        for (const path of asked) {
            if (values.value[path] !== undefined || refused.has(path)) {
                continue;
            }
            const timer = sleeping.get(path);
            if (timer !== undefined) {
                clearTimeout(timer);
                sleeping.delete(path);
            } else if (loading.has(path)) {
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
            asked.add(path);
            if (!loading.has(path) && !refused.has(path)) {
                attempt(path);
            }
            return undefined;
        },
        cached: (path) => values.value[path],
        put: (path, value) => {
            asked.add(path);
            values.value = { ...values.value, [path]: value };
        },
        drop: (path) => {
            asked.delete(path);
            // Every trace of the path, or the next ask answers from a parked refusal or a chain still mid-backoff.
            refused.delete(path);
            loading.delete(path);
            const timer = sleeping.get(path);
            if (timer !== undefined) {
                clearTimeout(timer);
                sleeping.delete(path);
            }
            const { [path]: _dropped, ...rest } = values.value;
            values.value = rest;
        },
    };
};
