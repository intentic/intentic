import { type Fence, type Slice, SliceSchema } from "@intentic/sandbox-contract";
import { idListFile, type IdListStore } from "../store/id-list-file.js";

// The named parts of the workspace, tracked in git like personas: a slice holds folder names, never a credential.
// Unlike personas it IS a security boundary, and what keeps it one is not the file's permissions but the fence itself:
// reaching `.intentic/config/slices.json` requires a fence that admits `.intentic`, which no fenced member is given.

export type SlicesStore = IdListStore<Slice>;

// An unreadable slice is reported to both `onInvalid` (daemon log) and the manifest-problem registry, and is then
// absent — which fails SHUT, since a member row naming a slice nobody can read resolves to a fence admitting nothing
// rather than to no fence at all.
export const fileSlicesStore = (path: string, onInvalid?: (id: string, reason: string) => void): SlicesStore =>
    idListFile(path, SliceSchema, onInvalid);

/**
 * The folders a set of slice ids admits, or undefined when no slice is named at all — the difference between "works
 * everywhere" and "works in whatever these slices say".
 * An id with no slice behind it contributes no folder rather than every folder, so a deleted or unreadable slice
 * narrows its holder instead of releasing them.
 */
export const foldersOf = (slices: readonly Slice[], named: readonly string[] | undefined): Fence => {
    if (named === undefined) {
        return undefined;
    }
    const byId = new Map(slices.map((slice) => [slice.id, slice]));
    return [...new Set(named.flatMap((id) => byId.get(id)?.folders ?? []))];
};
