import { open, stat } from "node:fs/promises";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { pairingRemoteDir, type Pairing } from "../config.js";
import { asidePrefix } from "../project/adopt.js";

/* WHAT A FILE-SYNC SETUP SAYS IT LEFT TRUE (2026-11-20, intentic#49). A Windows PC whose Mutagen had lost its agent bundle
   finished every setup with "Desktop sync is running." while the agent's log said, every pass, that preparing the
   folder's file sync had failed, and the folder never synced. "Running" is said now only once this pairing's session
   exists; otherwise the ending says sync could not start, and why, in the words the agent logged for it. */

/** The ending's three parts: the verdict, the address under it, and the sentence that says what is true now. */
export interface SetupEnding {
    readonly verdict: string;
    readonly address: string | undefined;
    readonly instruction: string;
}

// What a file-sync setup that started leaves true. The first copy is still to come when setup returns, so it says it is
// under way rather than done; a folder that already held files says where the ones that disagree with the sandbox go
// (adopt.ts), since that is the one thing setup does to files the owner put there.
const syncedSentence = (pairing: Pairing): string => {
    const kept = `That folder and your sandbox's ${pairingRemoteDir(pairing)} are kept the same from now on; the first copy can take a few minutes.`;
    return pairing.adoptFolder === true && pairing.localDir !== undefined
        ? `${kept}\nThe folder already held files: any that differ from the sandbox's copy are moved to ${asidePrefix(pairing.localDir)}<time> first, so the sandbox's version is the one that syncs. Nothing is deleted.`
        : kept;
};

/**
 * The ending of a setup. `notStarted` is why this pairing's file sync has no session yet, undefined once it has one;
 * a mirror-only enrollment has no file sync to start. Pure.
 */
export const setupEnding = (pairing: Pairing, sandboxUrl: string, notStarted: string | undefined): SetupEnding => {
    if (pairing.mode !== "sync") {
        return {
            verdict: "Enrolled for port mirroring.",
            address: undefined,
            instruction: `Ports from ${sandboxUrl} now answer on this device's localhost (mirror-only, no file sync).`,
        };
    }
    if (notStarted !== undefined) {
        return {
            verdict: "Desktop sync couldn't start.",
            address: pairing.localDir,
            instruction: `${notStarted}\nThe folder stays paired with your sandbox, and this device's agent keeps trying; it syncs as soon as that is put right.`,
        };
    }
    return { verdict: "Desktop sync is running.", address: pairing.localDir, instruction: syncedSentence(pairing) };
};

// Why this pairing's file sync has no session after the wait, best first: what the agent logged when preparing it
// failed, then what is wrong with Mutagen itself, then the wait's own account (an older agent, or a slow sandbox). Pure.
export const notStartedReason = (logged: string | undefined, mutagen: string | undefined, late: string): string => {
    if (logged !== undefined) {
        return `This device's agent could not start file sync: ${logged}`;
    }
    return mutagen ?? late;
};

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * The last reason the agent logged for failing to prepare this pairing's file sync (mirror.ts `prepareSession`), from
 * the log text written since setup began; undefined when it logged none. Pure.
 */
export const prepareFailureIn = (logText: string, pairingKey: string): string | undefined => {
    const failed = new RegExp(`${escaped(pairingKey)}: preparing its file sync failed: (.+)$`, "gm");
    let last: string | undefined;
    for (const match of logText.matchAll(failed)) {
        last = match[1]?.trim();
    }
    return last === "" ? undefined : last;
};

// How much of a log is read back for that reason at most: a setup's minute and a half of passes, with room to spare.
const LOG_TAIL_BYTES = 256 * 1024;

/** The size of a log now, where setup starts reading it back from; 0 for a log not written yet. */
export const logSizeNow = async (path: string): Promise<number> => (await stat(path).catch(undefinedIfMissing))?.size ?? 0;

/** What a log gained since `from`, at most its last LOG_TAIL_BYTES; empty when it cannot be read, with the reason. */
export const logSince = async (path: string, from: number): Promise<{ readonly text: string; readonly unread?: string }> => {
    try {
        const file = await open(path, "r");
        try {
            const size = (await file.stat()).size;
            const start = Math.max(from, size - LOG_TAIL_BYTES);
            const length = Math.max(0, size - start);
            const buffer = Buffer.alloc(length);
            await file.read(buffer, 0, length, start);
            return { text: buffer.toString("utf8") };
        } finally {
            await file.close();
        }
    } catch (error) {
        return { text: "", unread: errorMessage(error) };
    }
};
