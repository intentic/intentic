import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { EngineId } from "@intentic/sandbox-contract";
import { resolveOnPath } from "../platform/boot/on-path.js";
import { engineDescriptor, type EnginePaths } from "./engine-descriptors.js";
import { engineVersionDir, isQuarantined, readEngineState } from "./engine-store.js";

// Which copy of an engine a turn gets: the store's, or the image's when the store is missing, unreadable, or
// quarantined — silently, since this sits in the turn path. `image` carries no paths; the consumer's existing
// resolution already is the image answer. Cached a few seconds, not the process's life, so Update reaches the next
// turn, not the next restart.

export interface ResolvedEngine {
    readonly id: EngineId;
    // Absent when the image answer's version cannot be named cheaply (a PATH binary); present for a store answer.
    readonly version?: string;
    readonly source: "image" | "store";
    // The installed prefix, for the store answer only.
    readonly prefix?: string;
    // Empty for the image answer; the consumer's own existing resolution stands in for it.
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
    // Directory can vanish without the pointer knowing (GC elsewhere, restored snapshot); checked, not trusted.
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
    // Never rejects; a rejected cached promise would poison every later read until the TTL passed.
    const resolved = resolveNow(id).catch(() => imageAnswer(id));
    cache.set(id, { at: now, resolved });
    return resolved;
};

// The store's binary, the image's copy on PATH, or nothing; a core image with no provider packs is a known, explainable
// absence rather than a bare name that ENOENTs on spawn.
export const engineBinary = async (id: EngineId, onPathName: string): Promise<string | undefined> =>
    (await resolveEngine(id)).paths.binPath ?? resolveOnPath(onPathName);

// Drops the cache immediately: this process just moved the pointer itself, or a test suite is switching fixture trees.
export const forgetEngineResolution = (id?: EngineId): void => {
    if (id === undefined) {
        cache.clear();
        return;
    }
    cache.delete(id);
};
