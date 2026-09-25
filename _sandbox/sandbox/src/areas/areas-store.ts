import { STATE_DIR } from "@intentic/constants";
import { type Fence, type Area, AreaSchema } from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { idListFile, type IdListStore } from "../store/id-list-file.js";
import { stateRelPath } from "../state-paths.js";

// The named parts of the workspace, tracked in git like personas: an area holds folder names, never a credential.
// Unlike personas it IS a security boundary, and what keeps it one is not the file's permissions but the fence itself:
// reaching `.intentic/config/areas.json` requires a fence that admits `.intentic`, which no fenced member is given.

export type AreasStore = IdListStore<Area>;

// Called slices until 2026-09-20.
export const areasDocument = defineDocument({
    path: stateRelPath(".intentic/config/areas.json"),
    schema: AreaSchema,
    granularity: "entries",
    movedFrom: [[STATE_DIR, "config", "slices.json"].join("/")],
});

// An unreadable area is reported to both `onInvalid` (daemon log) and the manifest-problem registry, and is then
// absent — which fails SHUT, since a member row naming an area nobody can read resolves to a fence admitting nothing
// rather than to no fence at all.
export const fileAreasStore = (path: string, onInvalid?: (id: string, reason: string) => void): AreasStore =>
    idListFile(path, AreaSchema, onInvalid, areasDocument);

/**
 * The folders a set of area ids admits, or undefined when no area is named at all — the difference between "works
 * everywhere" and "works in whatever these areas say".
 * An id with no area behind it contributes no folder rather than every folder, so a deleted or unreadable area
 * narrows its holder instead of releasing them.
 */
export const foldersOf = (areas: readonly Area[], named: readonly string[] | undefined): Fence => {
    if (named === undefined) {
        return undefined;
    }
    const byId = new Map(areas.map((area) => [area.id, area]));
    return [...new Set(named.flatMap((id) => byId.get(id)?.folders ?? []))];
};
