import { justSetUpKey, removeStoredValue, storedValue, storeValue } from "../../../app/storage/browserStorage";

// A SANDBOX THIS BROWSER HAS ONLY JUST SET UP. /setup opens the workspace when the sandbox has reported in, and the
// first seconds after that can still be quiet: the browser's list may not carry the address yet, the edge may not route
// to it yet. Without this fact the gate read that quiet as a sandbox nobody had finished setting up ("Connect", "Finish
// setup") and the tab said "Offline", seconds after a hosted machine had been started for the reader (UX review
// 2026-10-18, F02). With it, the quiet reads as what it is: a connection on its way, retried on its own.
//
// Stored rather than held in memory, so a reload in those first minutes still knows it.

// How long after the hand-over a quiet sandbox is still "just set up": well past the minute or two a fresh machine
// can take to become reachable through its edge, short enough that a sandbox that never came up stops being excused.
export const JUST_SET_UP_MS = 5 * 60_000;

/** Records that /setup is opening this sandbox's workspace now. */
export const markJustSetUp = (sandbox: string, now: number = Date.now()): void => {
    storeValue(justSetUpKey(sandbox), String(now));
};

/** Whether /setup opened this sandbox within the last few minutes; a stale or unreadable record is dropped. */
export const justSetUp = (sandbox: string | undefined, now: number = Date.now()): boolean => {
    if (sandbox === undefined) {
        return false;
    }
    const key = justSetUpKey(sandbox);
    const at = Number(storedValue(key));
    if (!Number.isFinite(at) || at <= 0) {
        return false;
    }
    if (now - at > JUST_SET_UP_MS) {
        removeStoredValue(key);
        return false;
    }
    return true;
};
