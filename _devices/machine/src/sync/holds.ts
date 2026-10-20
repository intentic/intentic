import { join } from "node:path";
import { pathExists, writeFileAtomic } from "@intentic/base/fs";
import type { Log } from "@intentic/local-agent";
import type { DeviceSyncHold } from "@intentic/sandbox-contract/schemas/devices";
import type { SwapRecord } from "../device/sandbox-rounds/swap-records.js";
import { baseDir } from "../config.js";
import { type Pairing, pairingKey, pairingSlugs, updateState } from "./config.js";
import { type LiveSession, pauseSessions, readAllSessions, resumeSessions, syncSessionNames } from "./mutagen.js";

/* WHETHER A PAIRING'S FILE SYNC RUNS IS ONE DECISION, READ OFF FACTS (2026-10-20). Seven things hold it still: the
   owner's Pause, the sandbox said to be gone, the container a docker pairing reaches being away or in ic's trash, a swap
   of the sandbox on this machine, an hour of it not answering, and the drive under the folder filling up. Each is a fact
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
// there, then what passes by itself. Empty means it runs. A mirror-only pairing and the projects host hold no file sync,
// so nothing holds them.
export const syncHolds = (pairing: Pairing, now: number): DeviceSyncHold[] => {
    if (pairing.mode !== "sync" || pairing.projectsHost === true) {
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
    const adopted = await adoptOwnerPauses(pairings, live, now);
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

// FILE SYNC HOLDS STILL WHILE ITS SANDBOX IS SWAPPED ON THIS MACHINE. Two-way sync against a container that is parked,
// half started, or a new version that may yet be rolled back reads the sandbox's side as whatever that moment shows, and
// writes the answer into this machine's folder: the pairing is held (`swapSince`) from the cutover through the
// first quarter hour after it, and past that for as long as ic still watches the swap and the sandbox is not answering.
// The decisions are pure; mirror.ts keeps the fact each pass.
//
// THE HOLD OUTLIVES IC'S RECORD OF THE SWAP (2026-10-20). ic keeps a swap on its record only while the swap is in flight
// or on probation, and a swap with no probation (the dev loop, a probation of 0, the watch going back) leaves no record
// seconds after its cutover: a hold read off the record alone let go after about thirty seconds, while the new version
// it was holding for had not proven anything yet. So the quarter hour is measured from the pairing's own fact, the
// cutover's start as ic recorded it, kept on the pairing when the swap is first seen; the record only begins a hold (or
// a new one, for a later swap) and keeps it while it is cutting over.

// How long after a swap's cutover began sync stays paused however well the new version looks: the probation watch's
// first verdicts land inside it.
export const PROBATION_HOLD_MS = 15 * 60_000;

// This pairing's sandbox's record, when this machine runs it and ic has one naming a phase.
export const recordOf = (pairing: Pairing, records: readonly SwapRecord[]): SwapRecord | undefined => {
    const slugs = pairingSlugs(pairing.sandboxUrl);
    return records.find((record) => slugs.includes(record.slug));
};

// When the swap a pairing's hold measures from began: the cutover ic's record names while it keeps one, else the start
// the pairing kept (`since`). A record with no time begins at `now`, the moment it was first seen.
export const swapBegan = (record: SwapRecord | undefined, since: number | undefined, now: number): number | undefined =>
    record?.phase === undefined ? since : (record.at ?? since ?? now);

// Whether a swap holds file sync still: the whole cutover, the first quarter hour after it began, and after that while
// ic still watches it and the sandbox does not answer. A phase this agent does not know is read as probation.
export const holdsSync = (record: SwapRecord | undefined, since: number | undefined, now: number, answering: boolean): boolean => {
    if (record?.phase === "cutover") {
        return true;
    }
    const began = swapBegan(record, since, now);
    if (began === undefined) {
        return false;
    }
    return now - began < PROBATION_HOLD_MS || (record?.phase !== undefined && !answering);
};

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
