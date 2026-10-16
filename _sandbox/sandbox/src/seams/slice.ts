import type { CompositionCore } from "../composition.js";

// A leaf slice of the composition: what it builds from the hand-ordered core, and how it stops what it started. Declared
// as `export const name = defineSlice<Members>({ … })` at the top of its module, it is listed in
// src/bootstrap/slices/slice-registry.ts by scripts/write-indexes.mjs, which composition.ts builds and tears down.
export interface SliceDef<M, D = CompositionCore> {
    // Reads only the core it is handed; anything built later is reached through `whole` when called, never while building.
    readonly build: (deps: D) => M;
    readonly stop?: (members: M) => SliceStopped;
}

// What a stop answers: nothing, or a promise main's shutdown waits on.
export type SliceStopped = void | Promise<void>;

export const defineSlice = <M, D = CompositionCore>(slice: SliceDef<M, D>): SliceDef<M, D> => slice;

// Each built slice's member names, by slice name: a member two slices build, or one a slice builds over the core,
// throws rather than letting the later spread win.
export const distinctMembers = (built: readonly (readonly [slice: string, members: readonly string[]])[], coreKeys: readonly string[]): void => {
    const owners = new Map<string, string>(coreKeys.map((key) => [key, "the composition core"]));
    for (const [slice, members] of built) {
        for (const key of members) {
            const owner = owners.get(key);
            if (owner !== undefined) {
                throw new Error(`composition: ${key} is built by both ${owner} and ${slice}`);
            }
            owners.set(key, slice);
        }
    }
};

// A slice's stop, as one teardown entry, or none for a slice that starts nothing.
export const stopsOf = <M, D>(slice: SliceDef<M, D>, members: M): readonly (() => SliceStopped)[] => {
    const { stop } = slice;
    return stop === undefined ? [] : [() => stop(members)];
};
