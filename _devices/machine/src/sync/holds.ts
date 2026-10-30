import { join } from "node:path";
import { pathExists, writeFileAtomic } from "@intentic/base/fs";
import type { Log } from "@intentic/local-agent";
import type { DeviceSyncHold } from "@intentic/sandbox-contract/schemas/devices";
import type { SwapRecord } from "../device/sandbox-rounds/swap-records.js";
import { baseDir } from "../config.js";
import { type Pairing, pairingKey, pairingSlugs, updateState } from "./config.js";
import { type LiveSession, pauseSessions, readAllSessions, resumeSessions, syncSessionNames } from "./mutagen.js";
import { operationRunning } from "./project/project-transfer.js";

/* WHETHER A PAIRING'S FILE SYNC RUNS IS ONE DECISION, READ OFF FACTS (2026-10-20). Eight things hold it still: the
   owner's Pause, the sandbox said to be gone, the container a docker pairing reaches being away or in ic's trash, a swap
   of the sandbox on this machine, an hour of it not answering, the drive under the folder filling up, and a bring-back,
   restore or delivery writing into the folder (project-transfer.ts, 2026-10-21). Each is a fact
   the one rule that observes it keeps on the pairing (config.ts), and the holds are read off those facts here; nothing
   records a pause of its own. Every pass `holdSessions` then makes Mutagen agree: what runs while anything holds is
   paused, and what is paused once nothing does is resumed, tried again every pass until Mutagen took it.

   Before this, each reason paused and resumed Mutagen itself behind a marker of its own, set only when it found the
   session running. A marker cleared before Mutagen took the resume (fair-moth, 2026-10-19), one a rewrite of the pairing
   dropped (swift-cedar, 2026-10-17), and a pause another reason found already in place each left sync paused with
   nothing that would ever lift it, or lifted a pause somebody else still meant. */

// Transient failures keep their sessions; only an uninterrupted hour of the sandbox not answering holds them, since
// otherwise Mutagen reconnects and rescans for ever against a deleted sandbox. Measured on the clock from the outage's
// first failed poll (`unreachableSince`), which the backoff is free to stretch.
export const UNREACHABLE_HOLD_MS = 60 * 60_000;

// What holds a pairing's file sync still right now, by whose word first: the owner's, then what says the sandbox is not
// there, then what passes by itself. Empty means it runs. A mirror-only pairing holds no file sync, so nothing holds it.
export const syncHolds = (pairing: Pairing, now: number): DeviceSyncHold[] => {
    if (pairing.mode !== "sync") {
        return [];
    }
    const held: [DeviceSyncHold, boolean][] = [
        ["owner", pairing.ownerPausedAt !== undefined],
        ["gone", pairing.goneSince !== undefined],
        ["container-missing", pairing.containerAway === "missing"],
        ["container-trashed", pairing.containerAway === "trashed"],
        ["swap", pairing.swapSince !== undefined],
        ["unreachable", pairing.unreachableSince !== undefined && now - pairing.unreachableSince >= UNREACHABLE_HOLD_MS],
        ["low-disk", pairing.lowDisk !== undefined],
        ["transfer", pairing.transferSince !== undefined],
    ];
    return held.flatMap(([hold, holds]) => (holds ? [hold] : []));
};

export const syncHeld = (pairing: Pairing, now: number): boolean => syncHolds(pairing, now).length > 0;

// Why, as the CLI says it after "held while".
export const HOLD_WORDS = {
    owner: "you paused it",
    gone: "its sandbox is said to be gone",
    "container-missing": "its container is not on this machine's Docker engine",
    "container-trashed": "its sandbox sits in ic's trash",
    swap: "its sandbox is being swapped on this machine",
    unreachable: "its sandbox has not answered for an hour",
    "low-disk": "the drive under its folder is nearly full",
    transfer: "a bring-back, restore or delivery is writing into its folder",
} as const satisfies Record<DeviceSyncHold, string>;

// The sessions of a pairing that disagree with its holds, by name: running while held, or paused while nothing holds.
interface Disagreement {
    readonly held: boolean;
    readonly names: readonly string[];
}

const disagreeing = (pairing: Pairing, live: readonly LiveSession[], now: number): Disagreement => {
    const held = syncHeld(pairing, now);
    const own = new Set(syncSessionNames(pairing));
    const names = live.flatMap((session) => (session.name !== undefined && own.has(session.name) && (session.paused === true) !== held ? [session.name] : []));
    return { held, names: [...new Set(names)] };
};

// Makes Mutagen agree with every pairing's holds, off one listing. A listing that did not answer acts on nothing: the
// next pass asks again. Answers the keys whose sessions still disagree, the pause or resume Mutagen did not take.
export const holdSessions = async (mutagen: string, pairings: readonly Pairing[], say: Log, now: number = Date.now()): Promise<ReadonlySet<string>> => {
    const live = readAllSessions(mutagen);
    if (live === undefined) {
        return new Set();
    }
    const adopted = await letGoOfDeadTransfers(await adoptOwnerPauses(pairings, live, now));
    const behind = new Set<string>();
    for (const pairing of adopted) {
        const { held, names } = disagreeing(pairing, live, now);
        if (names.length === 0) {
            continue;
        }
        // one pairing's sessions at a time, as every Mutagen call here; a resume is one call per session, read back
        const took = held ? pauseSessions(mutagen, names) : await resumeSessions(mutagen, names);
        if (!took) {
            behind.add(pairingKey(pairing));
            say(`  ${pairingKey(pairing)}: Mutagen did not take the ${held ? "pause" : "resume"} of its file sync; trying again next pass.`);
        }
    }
    return behind;
};

// A transfer's hold whose operation is gone, killed between its pause and its resume, is lifted here rather than left
// to the next command about its folder: its fact stands only while the folder's lock names a live process. Cleared only
// where the pairing still holds the hold that was read, so one a new operation took meanwhile stands.
const letGoOfDeadTransfers = async (pairings: readonly Pairing[]): Promise<readonly Pairing[]> => {
    const dead = new Map<string, number>();
    for (const pairing of pairings) {
        // a lock read per folder that holds one, which is rarely more than one
        if (pairing.transferSince !== undefined && !(await operationRunning(baseDir, pairingKey(pairing)))) {
            dead.set(pairingKey(pairing), pairing.transferSince);
        }
    }
    if (dead.size === 0) {
        return pairings;
    }
    const lifted = (held: Pairing): boolean => held.transferSince !== undefined && dead.get(pairingKey(held)) === held.transferSince;
    await updateState((state) => ({ pairings: state.pairings.map((held) => (lifted(held) ? { ...held, transferSince: undefined } : held)) }));
    return pairings.map((held) => (lifted(held) ? { ...held, transferSince: undefined } : held));
};

/* A PERSON'S PAUSE FROM BEFORE HOLDS, TAKEN ONCE. Older builds kept no record of `sync pause`: it lived in Mutagen alone.
   The first pass of this build reads every paused session that no fact explains as the owner's, records it, and leaves a
   mark so this is never done again: from then on a paused session nothing holds is one to resume. Also written by the
   move off Mutagen's shared directory, which declares the pauses it carries itself (mutagen-move.ts). */
const adoptedPath = join(baseDir, "sync-owner-pauses-adopted");

export const markOwnerPausesAdopted = async (): Promise<void> => await writeFileAtomic(adoptedPath, `${new Date().toISOString()}\n`);

// The pairings as they stand once any pause nothing explained has become the owner's. Run before anything writes an
// owner's pause or resume, so a resume asked for in the same breath is not taken for an old pause.
export const adoptOwnerPauses = async (pairings: readonly Pairing[], live: readonly LiveSession[], now: number): Promise<readonly Pairing[]> => {
    if (await pathExists(adoptedPath)) {
        return pairings;
    }
    const owned = new Set(pairings.filter((pairing) => disagreeing(pairing, live, now).names.length > 0 && !syncHeld(pairing, now)).map(pairingKey));
    await declareOwnerPauses(owned, now);
    await markOwnerPausesAdopted();
    return pairings.map((pairing) => (owned.has(pairingKey(pairing)) ? { ...pairing, ownerPausedAt: now } : pairing));
};

// The owner's pause recorded on each of these pairings, in one write.
export const declareOwnerPauses = async (keys: ReadonlySet<string>, now: number): Promise<void> => {
    if (keys.size > 0) {
        await updateState((state) => ({
            pairings: state.pairings.map((held) => (keys.has(pairingKey(held)) && held.ownerPausedAt === undefined ? { ...held, ownerPausedAt: now } : held)),
        }));
    }
};

// FILE SYNC HOLDS STILL WHILE ITS SANDBOX IS SWAPPED ON THIS MACHINE, AND NOT A MOMENT LONGER. Two-way sync against a
// container that is parked or half started reads the sandbox's side as whatever that moment shows, and writes the answer
// into this machine's folder: the pairing is held (`swapSince`) from the cutover until the new version has answered.
// The decisions are pure; mirror.ts keeps the facts each pass.
//
// EVENTS, NOT A CLOCK (2026-10-26). Until today the hold lasted a quarter hour from the cutover whatever happened, so a
// dev-loop rebuild that was serving again in a minute kept the owner's folder fourteen minutes behind (brave-thistle: a
// landed change "missing" on the owner's machine was sitting behind it). The clock guarded against a rollback, but the
// old and new containers share one volume (ic recreate.rs keeps /work, /history), so going back changes no file sync
// could read. What does matter is the cutover itself and a sandbox that is not there yet, and both are events: ic's
// record says a cutover is in flight, and the watcher's own poll says the sandbox answered. So the hold lasts while ic
// cuts over, and after that until the first answer from a poll that began once the cutover was seen done. A version on
// probation that stops answering (the crash loop a rollback answers) holds again while ic still watches it, and lets go
// at its next answer, whichever container gives it.

// This pairing's sandbox's record, when this machine runs it and ic has one naming a phase.
export const recordOf = (pairing: Pairing, records: readonly SwapRecord[]): SwapRecord | undefined => {
    const slugs = pairingSlugs(pairing.sandboxUrl);
    return records.find((record) => slugs.includes(record.slug));
};

// When the swap a pairing's hold measures from began: the cutover ic's record names while it keeps one, else the start
// the pairing kept (`since`). A record with no time begins at `now`, the moment it was first seen.
export const swapBegan = (record: SwapRecord | undefined, since: number | undefined, now: number): number | undefined =>
    record?.phase === undefined ? since : (record.at ?? since ?? now);

// What the watcher has seen of one sandbox around a swap: when it first saw the cutover done (`settledFrom`), when its
// poll last got an answer (`answeredAt`), and since when its polls have been failing, if they are right now
// (`silentSince`).
export interface SwapSight {
    readonly settledFrom?: number | undefined;
    readonly answeredAt?: number | undefined;
    readonly silentSince?: number | undefined;
}

// (2026-10-30) HOW LONG A SANDBOX ON PROBATION MUST BE SILENT BEFORE IT READS AS DOWN AGAIN. The rule below is for a new
// version that keeps crashing, and a crash loop is silent for minutes. It used to fire on the first failed poll: one
// ports read that timed out (a loopback daemon slow for ten seconds) paused and resumed file sync and logged "being
// swapped" with no swap anywhere, five times in one day on rog (shinobi-society). A minute is several polls, and still
// well inside any crash loop the probation watch answers.
export const PROBATION_SILENCE_MS = 60_000;

// Whether ic is still watching a swap's new version: a record that names a phase, with its probation not yet over. A
// record past `probationUntil` stands only until the probation watch settles it, and an ic that cannot run its watch
// (rog, 2026-10-29: "run ic sandbox fix") leaves it standing for good: it says nothing about the sandbox now.
const stillWatched = (record: SwapRecord | undefined, now: number): boolean =>
    record?.phase !== undefined && (record.probationUntil === undefined || now < record.probationUntil);

// Whether a swap holds file sync still: the whole cutover, then until the sandbox answers a poll made after the cutover
// was seen done, and again while ic still watches the swap and the sandbox has been silent for PROBATION_SILENCE_MS. A
// phase this agent does not know is read as probation.
export const holdsSync = (record: SwapRecord | undefined, since: number | undefined, now: number, sight: SwapSight): boolean => {
    if (record?.phase === "cutover") {
        return true;
    }
    if (swapBegan(record, since, now) === undefined) {
        return false;
    }
    if (stillWatched(record, now) && sight.silentSince !== undefined && now - sight.silentSince >= PROBATION_SILENCE_MS) {
        return true;
    }
    const { settledFrom, answeredAt } = sight;
    return settledFrom === undefined || answeredAt === undefined || answeredAt <= settledFrom;
};

// The moment the cutover is first seen done, kept until the next one begins: an answer counts only after it.
export const settledFromStep = (record: SwapRecord | undefined, before: number | undefined, now: number): number | undefined =>
    record?.phase === "cutover" ? undefined : (before ?? now);

// What this pass writes about one pairing's swap: that it began (`began`, the start to keep, also for a later swap that
// begins while one is held), that it settled, or nothing when the pairing already says what is so. The hold itself is
// read off the fact (syncHolds), so nothing here decides who resumes what.
export const swapStep = (pairing: Pick<Pairing, "swapSince">, holds: boolean, began: number | undefined): "began" | "settled" | undefined => {
    if (!holds) {
        return pairing.swapSince === undefined ? undefined : "settled";
    }
    return pairing.swapSince === began ? undefined : "began";
};

// How long a sandbox has to stop answering before its forwarded ports are taken off this machine's localhost: a port
// that answers nothing is worse than a free one, which something local could use. They come back on the first answer.
export const RELEASE_FORWARDS_MS = 10 * 60_000;

export const shouldReleaseForwards = (unreachableForMs: number, mirrored: number): boolean => unreachableForMs >= RELEASE_FORWARDS_MS && mirrored > 0;
