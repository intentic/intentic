import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Worker } from "playwright";
import { sleep } from "@intentic/base/async";
import { z } from "zod";
import { statePath } from "../../state-paths.js";

// What CDP cannot say about a tab, asked of Chromium's own tab model through a tiny extension loaded into the person's
// own window: whether a tab is playing sound and whether it is muted (`chrome.tabs`' audible and mutedInfo; CDP has no
// audible state at all), muting it, a copy of a tab that keeps its back and forward (`chrome.tabs.duplicate`), and
// bringing a closed tab back the way Ctrl+Shift+T does, history and all (`chrome.sessions`). Measured on Chromium 156,
// 2026-11-19: Chromium's tab-restore records a tab the daemon closes over CDP like one closed by hand, and restoring it
// brings back its whole history, which reopening its address in a fresh tab cannot.
//
// The daemon drives the extension's service worker over the same CDP connection it already holds: Playwright lists the
// worker and evaluates in it, so the extension has no messaging, no content script and no page a site could detect.
// A tab is matched to the daemon's page by its CDP target id, which `chrome.debugger.getTargets()` pairs with the tab id
// without attaching to anything. Only the person's own window loads it: an agent's Chromium is launched by its MCP server,
// with flags the daemon does not choose. Everything here answers "can't say" when the worker is not there (a Chromium
// build that refuses --load-extension, as branded Chrome has since 137), and the callers fall back.

const WORKER_FILE = "intentic-tabs.js";

const MANIFEST = {
    manifest_version: 3,
    name: "Intentic tabs",
    version: "1",
    description: "Lets the sandbox read and set a tab's sound and reopen closed tabs. Not visible to pages.",
    background: { service_worker: WORKER_FILE },
    permissions: ["tabs", "sessions", "debugger"],
};

// The worker. `audio` is a long poll: it answers at once when the tabs' sound changed since `since`, else at the next
// change or after `waitMs`, so the daemon hears a tab start playing within a round trip without polling. The interval
// calls an API every 20 s, which keeps an MV3 worker from being stopped for idleness between calls.
const WORKER_SOURCE = `"use strict";
let version = 0;
const waiters = new Set();
const bump = () => { version += 1; for (const wake of waiters) wake(); waiters.clear(); };
chrome.tabs.onUpdated.addListener((_id, change) => { if ("audible" in change || "mutedInfo" in change) bump(); });
chrome.tabs.onCreated.addListener(bump);
chrome.tabs.onRemoved.addListener(bump);
const tabIdOf = async (targetId) => (await chrome.debugger.getTargets()).find((target) => target.id === targetId)?.tabId;
const sound = async () => {
    const tabs = new Map((await chrome.tabs.query({})).map((tab) => [tab.id, tab]));
    return (await chrome.debugger.getTargets()).flatMap((target) => {
        const tab = target.type === "page" && target.tabId !== undefined ? tabs.get(target.tabId) : undefined;
        return tab === undefined ? [] : [{ targetId: target.id, audible: tab.audible === true, muted: tab.mutedInfo?.muted === true }];
    });
};
self.intentic = {
    audio: async (since, waitMs) => {
        if (version <= since) {
            await new Promise((resolve) => { waiters.add(resolve); setTimeout(resolve, waitMs); });
        }
        return { version, tabs: await sound() };
    },
    mute: async (targetId, muted) => {
        const id = await tabIdOf(targetId);
        if (id === undefined) return false;
        await chrome.tabs.update(id, { muted });
        return true;
    },
    duplicate: async (targetId) => {
        const id = await tabIdOf(targetId);
        if (id === undefined) return false;
        await chrome.tabs.duplicate(id);
        return true;
    },
    restore: async (url) => {
        const hit = (await chrome.sessions.getRecentlyClosed()).find((entry) => entry.tab?.url === url);
        if (hit === undefined) return false;
        await chrome.sessions.restore(hit.tab.sessionId);
        return true;
    },
};
setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
`;

// Where the extension is written, beside the profiles and dot-prefixed out of the account-id namespace like the
// fingerprint seed. Written again on every launch, so the window always loads this daemon's own copy.
const tabHelperDir = (root: string): string => statePath(root, ".intentic/local/browser/", ".tab-helper");

export const writeTabHelper = async (root: string): Promise<string> => {
    const dir = tabHelperDir(root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(MANIFEST, undefined, 2)}\n`);
    await writeFile(join(dir, WORKER_FILE), WORKER_SOURCE);
    return dir;
};

export interface TabSound {
    readonly audible: boolean;
    readonly muted: boolean;
}

const SoundSchema = z.object({
    version: z.number(),
    tabs: z.array(z.object({ targetId: z.string(), audible: z.boolean(), muted: z.boolean() })),
});

export interface TabHelper {
    // Mutes or unmutes one tab; false when the helper could not (no worker, no such tab).
    readonly mute: (targetId: string, muted: boolean) => Promise<boolean>;
    // Opens a copy of one tab, history and all, beside it; false when the helper could not.
    readonly duplicate: (targetId: string) => Promise<boolean>;
    // Brings back the most recent closed tab that was at `url`, as Ctrl+Shift+T does; false when Chromium holds none.
    readonly restore: (url: string) => Promise<boolean>;
    // Hears every tab's sound as it changes until stopped; answers how to stop.
    readonly watchSound: (changed: (sound: ReadonlyMap<string, TabSound>) => void) => () => void;
}

// How long one poll waits for a change before answering anyway; under CDP's own call budget.
const POLL_WAIT_MS = 20_000;
// How long a new window is given to start the extension's worker.
const WORKER_WAIT_MS = 5000;
// Between two failed polls: a worker restarting is back within a beat, and one that is gone is not asked in a loop.
const RETRY_MS = 2000;

const isHelper = (worker: Worker): boolean => worker.url().startsWith("chrome-extension://") && worker.url().endsWith(`/${WORKER_FILE}`);

// The worker as it is now: an MV3 worker can be stopped and started again, and each start is a new Worker.
const workerOf = (context: BrowserContext): Worker | undefined => context.serviceWorkers().find(isHelper);

// The helper of a window that loaded it, once its worker is up; undefined when it never comes.
export const connectTabHelper = async (context: BrowserContext): Promise<TabHelper | undefined> => {
    if (workerOf(context) === undefined) {
        // allow(silent-catch): a window whose Chromium did not load the extension has no helper, and says so by its absence.
        await context.waitForEvent("serviceworker", { predicate: isHelper, timeout: WORKER_WAIT_MS }).catch(() => undefined);
    }
    if (workerOf(context) === undefined) {
        return undefined;
    }
    // One call into the worker as it is now, its answer parsed; the fallback when there is no worker or it failed.
    // An expression rather than a function, so nothing needs the worker's global typed on this side: the arguments are
    // JSON, written into it whole.
    const call = async <T>(schema: z.ZodType<T>, method: string, args: readonly unknown[], fallback: T): Promise<T> => {
        const worker = workerOf(context);
        if (worker === undefined) {
            return fallback;
        }
        // allow(silent-catch): a worker stopping mid-call is the helper not being able to; the caller falls back.
        const answer = await worker.evaluate(`self.intentic.${method}(...${JSON.stringify(args)})`).catch(() => undefined);
        return schema.safeParse(answer).data ?? fallback;
    };
    return {
        mute: (targetId, muted) => call(z.boolean(), "mute", [targetId, muted], false),
        duplicate: (targetId) => call(z.boolean(), "duplicate", [targetId], false),
        restore: (url) => call(z.boolean(), "restore", [url], false),
        watchSound: (changed) => {
            let stopped = false;
            const loop = async (): Promise<void> => {
                let since = -1;
                for (;;) {
                    const answer = await call(SoundSchema.optional(), "audio", [since, POLL_WAIT_MS], undefined);
                    // A window that has gone has no worker to ask again.
                    if (stopped || context.browser()?.isConnected() === false) {
                        return;
                    }
                    if (answer === undefined) {
                        await sleep(RETRY_MS, { unref: true });
                    } else if (answer.version !== since) {
                        since = answer.version;
                        changed(new Map(answer.tabs.map((tab) => [tab.targetId, { audible: tab.audible, muted: tab.muted }])));
                    }
                }
            };
            void loop();
            return () => {
                stopped = true;
            };
        },
    };
};
