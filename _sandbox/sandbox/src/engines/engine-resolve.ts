import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { EngineId } from "@intentic/sandbox-contract";
import { resolveOnPath } from "../platform/on-path.js";
import { engineDescriptor, type EnginePaths } from "./engine-descriptors.js";
import { engineVersionDir, isQuarantined, readEngineState } from "./engine-store.js";

/* WHICH COPY OF AN ENGINE A TURN GETS, asked once per turn by everything that spawns or imports one.
 *
 * There are exactly two answers, and the second is always available: the store's copy, or the one the image
 * bakes. Every reason to doubt the store — no active version, the directory is gone, the version is
 * quarantined, the state file is unreadable — resolves to the image, silently and without throwing, because
 * this read sits directly in the turn path and a sandbox that cannot answer it is a sandbox that cannot work.
 * That is the property that makes tracking upstream safe: the worst outcome of the whole mechanism is the
 * behaviour of a sandbox that never had it.
 *
 * `image` carries no paths on purpose. A consumer's existing resolution (the daemon's own node_modules, a
 * pack's prefix, a binary on PATH) IS the image answer, so the fallback is the code that was already there
 * rather than a second spelling of it here.
 *
 * CACHED FOR SECONDS, not for the process's life. The pointer moves when an owner presses Update, and the next
 * turn has to see it; a daemon-lifetime cache would make the button mean "after a restart". A few seconds is
 * long enough that a burst of consumers inside one turn costs one read, and short enough that "the next turn"
 * is honest even when a second daemon on the same volume was the one that moved it. */

export interface ResolvedEngine {
    readonly id: EngineId;
    // Absent when the image's copy is what runs and this daemon cannot cheaply name its version (a binary on
    // PATH). Present for every store answer, which is the case the card and the audit trail care about.
    readonly version?: string;
    readonly source: "image" | "store";
    // The installed prefix, for the store answer only.
    readonly prefix?: string;
    // Empty for the image answer: the consumer's own resolution is the image answer.
    readonly paths: EnginePaths;
}

const TTL_MS = 5_000;

interface Cached {
    readonly at: number;
    readonly resolved: Promise<ResolvedEngine>;
}

const cache = new Map<EngineId, Cached>();

const imageAnswer = (id: EngineId): ResolvedEngine => ({ id, source: "image", paths: {} });

const resolveNow = async (id: EngineId): Promise<ResolvedEngine> => {
    const state = await readEngineState(id);
    const version = state.active;
    if (version === undefined || isQuarantined(state, version)) {
        return imageAnswer(id);
    }
    const prefix = engineVersionDir(id, version);
    // The directory can be gone without the pointer knowing: a GC on another daemon, an owner clearing space,
    // a volume restored from a snapshot older than the state file. Checked here rather than trusted, because
    // the cost of being wrong is every turn failing to spawn.
    if (!(await access(prefix, constants.F_OK).then(() => true, () => false))) {
        return imageAnswer(id);
    }
    const paths = await engineDescriptor(id).paths(prefix);
    return { id, version, source: "store", prefix, paths };
};

export const resolveEngine = (id: EngineId, now: number = Date.now()): Promise<ResolvedEngine> => {
    const cached = cache.get(id);
    if (cached !== undefined && now - cached.at < TTL_MS) {
        return cached.resolved;
    }
    // Never rejects (resolveNow's every failure path returns the image answer), so a cached promise cannot
    // poison later reads the way a rejected one would.
    const resolved = resolveNow(id).catch(() => imageAnswer(id));
    cache.set(id, { at: now, resolved });
    return resolved;
};

/* THE SPAWN-SITE READ: the store's binary for this engine, or the image's copy on PATH, or nothing.
 *
 * Three answers rather than two, and the third is deliberate: a core image carries no provider packs at all,
 * and every caller here already has a sentence for that state ("rebuild from the Environment card"). Answering
 * with the bare name instead would turn a known, explainable absence into an ENOENT from a spawn. */
export const engineBinary = async (id: EngineId, onPathName: string): Promise<string | undefined> =>
    (await resolveEngine(id)).paths.binPath ?? resolveOnPath(onPathName);

// Drop the cached answer NOW, for the two moments this process knows better than a timer: it has just moved
// the pointer itself, and a suite is moving between fixture trees.
export const forgetEngineResolution = (id?: EngineId): void => {
    if (id === undefined) {
        cache.clear();
        return;
    }
    cache.delete(id);
};
