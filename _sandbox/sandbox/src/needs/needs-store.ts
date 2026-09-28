import { isOpenNeed, type Need, NeedSchema, type NeedsFile } from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Every open need and the recent closed ones, by id (docs/architecture/needs.md). One entry per need, parsed on its
// own, so a need written by a later release costs itself and never the rest. No value of any secret ever lands here: a
// secret need names the secret, and the value goes to the secret store.

export const needsDocument = defineDocument({
    path: stateRelPath(".intentic/records/needs.json"),
    schema: NeedSchema,
    granularity: "record",
});

// Closed needs kept, newest first: enough for a card reopened days later to still say how it ended, bounded so a busy
// sandbox's file does not grow for ever. An open need is never dropped.
const CLOSED_KEPT = 300;
const CLOSED_MAX_AGE_MS = 30 * 24 * 3_600_000;

export interface NeedsStore {
    // Newest first.
    readonly all: () => Promise<readonly Need[]>;
    readonly get: (id: string) => Promise<Need | undefined>;
    // Writes one need whole, then trims what is closed and old.
    readonly put: (need: Need) => Promise<void>;
    // Changes one need in place; undefined when there is no such need, and the change is not called.
    readonly update: (id: string, change: (need: Need) => Need) => Promise<Need | undefined>;
}

// Closed ones past their keep, dropped; open ones always stay.
export const trimmed = (needs: NeedsFile, now: number): NeedsFile => {
    const closed = Object.values(needs)
        .filter((need) => !isOpenNeed(need))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    const dropped = new Set(
        closed.filter((need, index) => index >= CLOSED_KEPT || now - need.updatedAt > CLOSED_MAX_AGE_MS).map((need) => need.id),
    );
    if (dropped.size === 0) {
        return needs;
    }
    return Object.fromEntries(Object.entries(needs).filter(([id]) => !dropped.has(id)));
};

// The whole file as a store reads and writes it; openDocument's JsonFile satisfies it, and so does a suite's memory.
export interface NeedsFileAccess {
    readonly read: () => Promise<NeedsFile>;
    readonly update: (change: (current: NeedsFile) => NeedsFile) => Promise<unknown>;
}

export const needsStoreOver = (file: NeedsFileAccess, now: () => number = Date.now): NeedsStore => {
    const newestFirst = (needs: NeedsFile): Need[] => Object.values(needs).sort((left, right) => right.createdAt - left.createdAt);
    return {
        all: async () => newestFirst(await file.read()),
        get: async (id) => (await file.read())[id],
        put: async (need) => {
            await file.update((current) => trimmed({ ...current, [need.id]: need }, now()));
        },
        update: async (id, change) => {
            let changed: Need | undefined;
            await file.update((current) => {
                const need = current[id];
                if (need === undefined) {
                    // Returned by reference, so nothing is written.
                    return current;
                }
                changed = change(need);
                return trimmed({ ...current, [id]: changed }, now());
            });
            return changed;
        },
    };
};

export const fileNeedsStore = (path: string, now: () => number = Date.now): NeedsStore =>
    needsStoreOver(openDocument(needsDocument, path, { fallback: (): NeedsFile => ({}) }), now);
