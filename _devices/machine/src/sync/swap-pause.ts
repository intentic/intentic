import { sandboxIdFromUrl } from "@intentic/sandbox-contract";
import type { SwapRecord } from "../device/sandbox-rounds/swap-records.js";
import type { Pairing } from "./config.js";

// FILE SYNC HOLDS STILL WHILE ITS SANDBOX IS SWAPPED ON THIS MACHINE. Two-way sync against a container that is parked,
// half started, or a new version that may yet be rolled back reads the sandbox's side as whatever that moment shows, and
// writes the answer into this machine's folder: the pairing's sessions are paused from the cutover through the first
// quarter hour of probation, and past that for as long as the sandbox is not answering, then resumed. The decisions are
// pure; mirror.ts carries them out each pass.

// How long into a swap sync stays paused however well the new version looks: the probation watch's first verdicts land
// inside it. Measured from the cutover's start, which is the one time ic records.
export const PROBATION_HOLD_MS = 15 * 60_000;

// The slugs this machine's ic may know a pairing's sandbox by. ic names a sandbox with a public hostname by that
// hostname's first label (`sandbox-<id>`, or the subdomain an owner chose) and one without by the 12-hex id its
// connect token derives, which is the same id the hostname carries. A pairing's URL is that public hostname, so its
// first label, or the id in it, is the slug of the one sandbox it is: the mapping needs no guessing.
export const pairingSlugs = (sandboxUrl: string): string[] => {
    const id = sandboxIdFromUrl(sandboxUrl);
    const label = URL.canParse(sandboxUrl) ? new URL(sandboxUrl).hostname.split(".")[0] : undefined;
    return [...new Set([label, id].filter((slug): slug is string => slug !== undefined && slug !== ""))];
};

// This pairing's sandbox's record, when this machine runs it and ic has one naming a phase.
export const recordOf = (pairing: Pairing, records: readonly SwapRecord[]): SwapRecord | undefined => {
    const slugs = pairingSlugs(pairing.sandboxUrl);
    return records.find((record) => slugs.includes(record.slug));
};

// Whether a record holds file sync still: the whole cutover, the first quarter hour of probation, and after that while
// the sandbox does not answer. A phase this agent does not know is read as probation; a probation with no time as
// fresh, since there is nothing to measure it from.
export const holdsSync = (record: SwapRecord | undefined, now: number, answering: boolean): boolean => {
    if (record?.phase === undefined) {
        return false;
    }
    if (record.phase === "cutover") {
        return true;
    }
    return record.at === undefined || now - record.at < PROBATION_HOLD_MS || !answering;
};

// What this pass does about one pairing: pause its sessions, resume the ones this pause holds, or nothing. Only file
// sync is paused (a mirror-only pairing has none), and only a pause this rule made is ever resumed by it.
export const swapPauseStep = (pairing: Pairing, holds: boolean): "pause" | "resume" | undefined => {
    if (holds && pairing.mode === "sync" && pairing.fileSyncSwapPaused !== true) {
        return "pause";
    }
    return !holds && pairing.fileSyncSwapPaused === true ? "resume" : undefined;
};

// How long a sandbox has to stop answering before its forwarded ports are taken off this machine's localhost: a port
// that answers nothing is worse than a free one, which something local could use. They come back on the first answer.
export const RELEASE_FORWARDS_MS = 10 * 60_000;

export const shouldReleaseForwards = (unreachableForMs: number, mirrored: number): boolean => unreachableForMs >= RELEASE_FORWARDS_MS && mirrored > 0;
