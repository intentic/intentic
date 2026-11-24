import { setTimeout as sleep } from "node:timers/promises";
import type { Log } from "@intentic/local-agent";
import type { Dialed } from "../../daemon-base.js";
import { type Pairing, pairingKey, setChangeSignal } from "../config.js";
import { syncHeld } from "../holds.js";
import { flushSession, sessionName } from "../mutagen.js";
import { createFlusher, createFollowers, fetchSyncChanges, FLUSH_TIMING, followSyncChanges } from "./sync-changes.js";

// The mirror watcher's side of the change signal (sync-changes.ts): one follow per sandbox whose files this device
// syncs, fed each pass with where that sandbox is dialled and the pairings it holds, and a flush of the workspace sessions
// of whichever of them is not held. A sandbox that starts or stops pushing has its pairings recorded (config.ts
// `changeSignalSince`) and put back on the watcher's pending list, whose retry brings their sessions to the interval the
// record now asks for (mutagen.ts sandboxPollSeconds), from a settled state.

interface Latest {
    readonly base: string;
    readonly pairings: readonly Pairing[];
}

export interface ChangeFollow {
    readonly update: (dialed: readonly Dialed<Pairing>[]) => void;
    readonly stopAll: () => void;
}

// The workspace sessions a sandbox's signal flushes: every file-syncing pairing of it that nothing holds. The state
// backup is left to its own minute, as it always was.
export const flushTargets = (pairings: readonly Pairing[], now: number): string[] =>
    pairings.filter((pairing) => pairing.mode === "sync" && pairing.localDir !== undefined && !syncHeld(pairing, now)).map((pairing) => sessionName(pairingKey(pairing)));

// What a pass hands the follows: the sandboxes that sync files, have a token to ask with, and are not said to be gone.
export const followedSandboxes = (dialed: readonly Dialed<Pairing>[]): Map<string, Latest> => {
    const bySandbox = new Map<string, Latest>();
    for (const { pairing, base } of dialed) {
        if (pairing.mode !== "sync" || pairing.syncToken === undefined || pairing.goneSince !== undefined) {
            continue;
        }
        const held = bySandbox.get(pairing.sandboxId);
        bySandbox.set(pairing.sandboxId, { base: held?.base ?? base, pairings: [...(held?.pairings ?? []), pairing] });
    }
    return bySandbox;
};

// Every follow ends with `run`, the watcher run that made them.
export const createChangeFollow = (mutagen: string, pending: Set<string>, say: Log, run?: AbortSignal): ChangeFollow => {
    let latest = new Map<string, Latest>();
    // What each sandbox was last recorded as, so an answer writes the state file only when it moved.
    const recorded = new Map<string, boolean>();
    const record = async (sandboxId: string, pushes: boolean): Promise<void> => {
        const known = recorded.get(sandboxId) ?? latest.get(sandboxId)?.pairings.some((pairing) => pairing.changeSignalSince !== undefined);
        if (known === pushes) {
            return;
        }
        recorded.set(sandboxId, pushes);
        const moved = await setChangeSignal(sandboxId, pushes);
        for (const key of moved) {
            pending.add(key);
        }
        if (moved.length > 0) {
            say(
                pushes
                    ? `  ${sandboxId}: the sandbox says when its files change, so file sync follows that and scans it only as a backstop`
                    : `  ${sandboxId}: the sandbox no longer says when its files change, so file sync scans it every 2 seconds again`,
            );
        }
    };
    const followers = createFollowers((sandboxId, signal) => {
        const flusher = createFlusher(
            async () => {
                for (const name of flushTargets(latest.get(sandboxId)?.pairings ?? [], Date.now())) {
                    // one session at a time, as every Mutagen call this agent makes
                    await flushSession(mutagen, name);
                }
            },
            FLUSH_TIMING,
            say,
        );
        void followSyncChanges(
            {
                target: () => {
                    const held = latest.get(sandboxId);
                    const token = held?.pairings.find((pairing) => pairing.syncToken !== undefined)?.syncToken;
                    return held === undefined || token === undefined ? undefined : { base: held.base, syncToken: token };
                },
                ask: fetchSyncChanges,
                changed: flusher.request,
                supported: (pushes) => void record(sandboxId, pushes).catch(() => recorded.delete(sandboxId)),
                wait: async (ms, waitSignal) => await sleep(ms, undefined, { signal: waitSignal }),
            },
            signal,
        );
        return flusher.stop;
    });
    run?.addEventListener("abort", () => followers.stopAll(), { once: true });
    return {
        update: (dialed) => {
            latest = followedSandboxes(dialed);
            followers.reconcile([...latest.keys()]);
        },
        stopAll: followers.stopAll,
    };
};
