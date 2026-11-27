import { randomUUID } from "node:crypto";
import { EXTENSION_SLEEP_BOOT_WAIT_MS, EXTENSION_SLEEP_HOOK_MS, type ExtensionSleepBoot, type ExtensionSleepFrame } from "@intentic/sandbox-contract/extension-protocol";

// HOSTED SLEEP, AS AN EXTENSION'S OWN CODE MEETS IT (2026-11-27): who is watching for the machine about to sleep, and
// what this boot follows. A watch lives exactly as long as the request that opened it stays open (own-sleep.ts, POST
// /extension/sleep/watch), as a work hold does (extension-holds.ts), so a backend or a process that died watches
// nothing. Right before a hosted sleep, idle-stop's last word (bootstrap/platform-presence.ts) tells every watch at once
// and waits until each answered ready or EXTENSION_SLEEP_HOOK_MS passed; the machine stops either way.

interface Watch {
    // The extension, as its routing id.
    readonly extension: string;
    readonly tell: (frame: ExtensionSleepFrame) => void;
}

// allow(module-state): the watches of this daemon's open connections, which end with the process
const watches = new Map<symbol, Watch>();
// allow(module-state): the sleep each told watch is answering, by the id its frame carried
const waiting = new Map<string, { readonly extension: string; readonly answered: () => void }>();
// allow(module-state): what this boot follows, set once by the hosted sleep that knows (platform-presence.ts): what is
// known at once, and the facts once the platform has said whether a request started it
let bootFacts: { readonly known: ExtensionSleepBoot; readonly settled: () => Promise<ExtensionSleepBoot> } | undefined;

/** Watches for the machine about to sleep on behalf of `extension`; answers the release, which is safe to call twice. */
export const watchSleep = (extension: string, tell: Watch["tell"]): (() => void) => {
    const key = Symbol(extension);
    watches.set(key, { extension, tell });
    return () => void watches.delete(key);
};

/** `extension` is done with the sleep it was told as `id`; false for an id it was never told. */
export const answerSleep = (extension: string, id: string): boolean => {
    const asked = waiting.get(id);
    if (asked?.extension !== extension) {
        return false;
    }
    asked.answered();
    return true;
};

/** Tells every watch the machine is about to sleep and waits until each answered or the deadline passed: how many were
 * told, and how many answered in time. */
export const beforeHostedSleep = async (hookMs = EXTENSION_SLEEP_HOOK_MS): Promise<{ readonly told: number; readonly answered: number }> => {
    const deadline = Date.now() + hookMs;
    const told = [...watches.values()].map(async (watch) => {
        const id = randomUUID();
        const answered = Promise.withResolvers<boolean>();
        waiting.set(id, { extension: watch.extension, answered: () => answered.resolve(true) });
        const late = setTimeout(() => answered.resolve(false), hookMs);
        late.unref();
        try {
            watch.tell({ kind: "sleep", id, deadline });
            return await answered.promise;
        } finally {
            clearTimeout(late);
            waiting.delete(id);
        }
    });
    const answers = await Promise.all(told);
    return { told: answers.length, answered: answers.filter(Boolean).length };
};

/** Says where this boot's facts come from: `known` before the platform has spoken, `settled` once it has. A daemon that is
 * no hosted machine never sets it. */
export const setSleepBootFacts = (known: ExtensionSleepBoot, settled: () => Promise<ExtensionSleepBoot>): void => {
    bootFacts = { known, settled };
};

const NOTHING: ExtensionSleepBoot = { afterSleep: false, requestWake: false };

/** What this boot follows, waiting up to `waitMs` for the platform's word on a request wake, and answering what is known
 * without it past then; neither on a sandbox that never sleeps hosted. */
export const sleepBootFacts = async (waitMs = EXTENSION_SLEEP_BOOT_WAIT_MS): Promise<ExtensionSleepBoot> => {
    const facts = bootFacts;
    if (facts === undefined) {
        return NOTHING;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ExtensionSleepBoot>((resolve) => {
        timer = setTimeout(() => resolve(facts.known), waitMs);
        timer.unref();
    });
    try {
        return await Promise.race([facts.settled(), late]);
    } finally {
        clearTimeout(timer);
    }
};
