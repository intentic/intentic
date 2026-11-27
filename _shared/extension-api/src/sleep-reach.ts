import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import {
    type ExtensionSleepBoot,
    ExtensionSleepBootSchema,
    ExtensionSleepFrameSchema,
    ExtensionSleepHeardSchema,
    type ExtensionSleepReadySchema,
    type ExtensionWakeUrlAskSchema,
    ExtensionWakeUrlSchema,
    extensionSleepBootUrl,
    extensionSleepHeardUrl,
    extensionSleepReadyUrl,
    extensionSleepWatchUrl,
    extensionWakeUrlUrl,
} from "@intentic/sandbox-contract/extension-protocol";
import type { z } from "zod";
import { keepStreaming } from "./backend-reach.js";
import type { Disposable } from "./disposable.js";
import type { ExtensionServerApi, SleepHandler } from "./server.js";

// (2026-11-27) `api.sleep`: hosted sleep as an extension's own code meets it, the backend host and every declared process
// alike, over the five doors every extension token reaches (the contract's extension-protocol.ts). The before-sleep
// watch is one ndjson stream held while any handler is registered, reconnected with backoff like the event stream; a
// `sleep` frame runs every handler at once under the frame's deadline, then answers ready, so the daemon stops as soon
// as every extension is done rather than at the deadline.

type DaemonRequest = ExtensionServerApi["daemon"]["request"];

// Answered ready this long before the frame's deadline, so the answer lands before the daemon stops waiting.
const READY_MARGIN_MS = 500;

const AFTER_NOTHING: ExtensionSleepBoot = { afterSleep: false, requestWake: false };

// What the doors are sent: a wake URL's ask, a sleep answered ready, and the watch's empty body.
type Sent = z.input<typeof ExtensionWakeUrlAskSchema> | z.input<typeof ExtensionSleepReadySchema> | Record<string, never>;

const post = (request: DaemonRequest, path: string, body: Sent, signal?: AbortSignal): Promise<Response> =>
    request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? null });

// Every handler at once, each one's failure said and never raised, under one deadline.
const runHandlers = async (handlers: ReadonlySet<SleepHandler>, deadline: number, log: (message: string) => void): Promise<void> => {
    const each = [...handlers].map(async (handler) => {
        try {
            await handler({ deadline });
        } catch (error) {
            log(`a before-sleep handler threw: ${errorMessage(error)}`);
        }
    });
    const outcome = await within(
        async () => {
            await Promise.all(each);
            return "done" as const;
        },
        Math.max(0, deadline - Date.now() - READY_MARGIN_MS),
        "late" as const,
        { unref: true },
    );
    if (outcome === "late") {
        log("a before-sleep handler did not finish before the sandbox stopped waiting for it");
    }
};

export const createSleepReach = (request: DaemonRequest, log: (message: string) => void): ExtensionServerApi["sleep"] & { readonly close: () => void } => {
    const handlers = new Set<SleepHandler>();
    let watching: AbortController | undefined;
    let told = false;
    const heard = (line: string): void => {
        const frame = parseJsonWith(line, ExtensionSleepFrameSchema);
        if (frame?.kind !== "sleep") {
            return;
        }
        void runHandlers(handlers, frame.deadline, log)
            .then(() => post(request, extensionSleepReadyUrl(), { id: frame.id }))
            .catch((error: Error) => log(`telling the sandbox the before-sleep handlers are done failed: ${error.message}`));
    };
    const watch = (): void => {
        watching = new AbortController();
        void keepStreaming(
            {
                open: (signal) => post(request, extensionSleepWatchUrl(), {}, signal),
                line: heard,
                gap: () => undefined,
                dropped: (why) => {
                    if (!told) {
                        told = true;
                        log(`hearing when the sandbox sleeps failed (${why}); trying again`);
                    }
                },
            },
            watching.signal,
        );
    };
    return {
        wakeUrl: async (route, options = {}) => {
            const ask: z.input<typeof ExtensionWakeUrlAskSchema> = options.automationId === undefined ? { route } : { route, automationId: options.automationId };
            const answered = await post(request, extensionWakeUrlUrl(), ask);
            if (!answered.ok) {
                throw new Error(`daemon answered ${answered.status} for POST ${extensionWakeUrlUrl()}: ${(await answered.text()).slice(0, 300)}`);
            }
            return ExtensionWakeUrlSchema.parse(await answered.json()).url;
        },
        beforeSleep: (handler): Disposable => {
            handlers.add(handler);
            if (watching === undefined) {
                watch();
            }
            return {
                dispose: () => {
                    handlers.delete(handler);
                    if (handlers.size === 0) {
                        watching?.abort();
                        watching = undefined;
                    }
                },
            };
        },
        // A daemon from before these doors never slept with hooks and says nothing of a request: false for both.
        boot: async () => {
            const answered = await request(extensionSleepBootUrl());
            if (answered.status === 404) {
                return AFTER_NOTHING;
            }
            if (!answered.ok) {
                throw new Error(`daemon answered ${answered.status} for GET ${extensionSleepBootUrl()}: ${(await answered.text()).slice(0, 300)}`);
            }
            return ExtensionSleepBootSchema.parse(await answered.json());
        },
        heard: async () => {
            const answered = await post(request, extensionSleepHeardUrl(), {});
            // A daemon from before it never slept with a watch: nothing was heard.
            if (answered.status === 404) {
                return [];
            }
            if (!answered.ok) {
                throw new Error(`daemon answered ${answered.status} for POST ${extensionSleepHeardUrl()}: ${(await answered.text()).slice(0, 300)}`);
            }
            return ExtensionSleepHeardSchema.parse(await answered.json()).heard;
        },
        close: () => {
            handlers.clear();
            watching?.abort();
            watching = undefined;
        },
    };
};
