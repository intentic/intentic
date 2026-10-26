import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui/icons";
import { type ProcessKind, type ProcessReport, processAsks, processLive } from "../../app/environments/processes/processReport";
import { processNote, processTitle } from "./processWords";

// THE RAIL'S TEMPORARY GROUP: one tile per process under way, the same on Home's rail and on This computer's
// (parts/processes/ProcessTiles.vue draws it, each face hands it its own list). A run stands on the rail while it works,
// waits, asks or failed, and once it is done until the reader has seen it; one the reader stopped goes at once, since
// they already know. Its marks are the rail's own: the spinning mark while it works, a warning while it waits on the
// reader, a danger mark when it failed, a check when it is done.

export interface ProcessTile {
    readonly id: string;
    readonly report: ProcessReport;
    /** The tile's name: what the run is, about what. */
    readonly title: string;
    /** The line under it, in the hover and the accessible name: where it is now. */
    readonly note: string;
    readonly badge: ViewBadge | undefined;
    /** A sandbox's runs wear the sandbox's own letters; the others a glyph of what they do. */
    readonly glyph: { readonly logo: string } | { readonly icon: IconName };
}

const GLYPHS = {
    "sandbox-setup": `box`,
    "pc-setup": `desktop`,
    docker: `server`,
    "folder-setup": `box`,
    "sign-in": `sign-in`,
    recreate: `refresh`,
    fix: `hammer`,
    sync: `sync`,
    repair: `wrench`,
    "engine-move": `server`,
    "first-task": `comments`,
} as const satisfies Readonly<Record<ProcessKind, IconName>>;

const SANDBOX_KINDS: ReadonlySet<ProcessKind> = new Set([`sandbox-setup`, `folder-setup`, `first-task`, `recreate`, `fix`, `sync`]);

/** The tile's corner marks for a run, as every rail tile wears them (viewBadge.ts). */
export const processBadgeOf = (report: ProcessReport): ViewBadge | undefined => {
    if (report.state === `failed`) {
        return { mark: `exclamation-circle`, tone: `danger` };
    }
    if (processAsks(report)) {
        return { mark: `exclamation-circle`, tone: `warning` };
    }
    if (report.state === `done`) {
        return { mark: `check`, tone: `info` };
    }
    return processLive(report) ? { running: processNote(report) } : undefined;
};

/** Whether a run has a tile: not one the reader stopped themselves. */
const processShown = (report: ProcessReport): boolean => report.state !== `stopped`;

export const processTileOf = (report: ProcessReport): ProcessTile => ({
    id: report.id,
    report,
    title: processTitle(report),
    note: processNote(report),
    badge: processBadgeOf(report),
    glyph: SANDBOX_KINDS.has(report.kind) && report.subject !== undefined ? { logo: report.subject } : { icon: GLYPHS[report.kind] },
});

/**
 * One list from several, one report per id: a later list's report replaces an earlier one's, so a face puts its own
 * richest source last. The order is first-seen, so a tile keeps its place as its reports come in.
 */
export const mergeProcesses = (...lists: readonly (readonly ProcessReport[])[]): readonly ProcessReport[] => {
    const byId = new Map<string, ProcessReport>();
    for (const list of lists) {
        for (const report of list) {
            byId.set(report.id, report);
        }
    }
    return [...byId.values()];
};

/** The tiles a face's rail wears for `reports`, leaving out what the face already draws a tile of its own for. */
export const processTilesOf = (reports: readonly ProcessReport[], drawnElsewhere: (report: ProcessReport) => boolean = () => false): readonly ProcessTile[] =>
    reports.filter((report) => processShown(report) && !drawnElsewhere(report)).map(processTileOf);
