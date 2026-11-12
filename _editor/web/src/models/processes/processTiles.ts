import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui/icons";
import {
    type ProcessKind,
    type ProcessReport,
    processAsks,
    processLive,
    type RecreateMode,
    recreateMode,
} from "../../app/environments/processes/processReport";
import { processNote, processTitle } from "./processWords";

// THE RAIL'S TEMPORARY GROUP: one tile per process under way, the same on Home's rail and on This computer's
// (parts/processes/ProcessTiles.vue draws it, each face hands it its own list). A run stands on the rail while it works,
// waits, asks or failed, and once it is done for a moment, until the app puts it away (processes.rs `DONE_LINGER`); one
// the reader stopped goes at once, since they already know. Its marks are the rail's own: the spinning mark while it works, a warning while it waits on the
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
    "agent-install": `shield`,
} as const satisfies Readonly<Record<ProcessKind, IconName>>;

// A recreate is not worn in the sandbox's letters: its subject is the container's slug (`sandbox-6a4ac…`), so every one
// read "S", and an update said nothing of being one. It wears what it does instead, by the swap its report names.
const SANDBOX_KINDS: ReadonlySet<ProcessKind> = new Set([`sandbox-setup`, `folder-setup`, `first-task`, `fix`, `sync`]);

const RECREATE_GLYPHS = { update: `arrow-circle-up`, rebuild: `refresh`, rollback: `undo` } as const satisfies Readonly<Record<RecreateMode, IconName>>;

const glyphOf = (report: ProcessReport): ProcessTile[`glyph`] => {
    if (report.kind === `recreate`) {
        const mode = recreateMode(report);
        return { icon: mode === undefined ? GLYPHS.recreate : RECREATE_GLYPHS[mode] };
    }
    return SANDBOX_KINDS.has(report.kind) && report.subject !== undefined ? { logo: report.subject } : { icon: GLYPHS[report.kind] };
};

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
    glyph: glyphOf(report),
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

// ONE SANDBOX, ONE TILE (2026-10-28, the owner's): a sandbox already on the rail (it reported in, so it is in the
// switcher's list) carries its own runs, rather than a second tile with the same letters under the divider. While such a
// run works its sandbox's tile wears the spinning mark; a run that asks something of the reader, or failed, keeps its tile
// in the group, since that tile is the way to the page that answers it. A setup that finished needs no news tile at all:
// its sandbox's tile is the news, marked ready until opened (settledSetups, RailProcesses.vue).

/**
 * Whether a run is drawn on its sandbox's own tile (one of `tiled`) rather than in the group: while it works, and a setup
 * once it finished (put away a moment later, so no "done" tile flashes up meanwhile). Another run's "done" keeps its tile.
 */
export const foldedOnSandbox = (report: ProcessReport, tiled: ReadonlySet<string>): boolean =>
    report.sandboxId !== undefined &&
    tiled.has(report.sandboxId) &&
    !processAsks(report) &&
    (processLive(report) || (report.kind === `sandbox-setup` && report.state === `done`));

/** The run a sandbox's tile wears while it works: its spinning mark and its line; undefined while none does. */
export const sandboxRunOf = (reports: readonly ProcessReport[], sandboxId: string): ProcessReport | undefined =>
    reports.find((report) => report.sandboxId === sandboxId && processLive(report) && !processAsks(report));

/**
 * The setups that finished for a sandbox the reader already has (on this rail, or the one the shell is in): put away by
 * the rail as they finish, rather than standing as a tile that says "done" beside the sandbox it made.
 */
export const settledSetups = (reports: readonly ProcessReport[], tiled: ReadonlySet<string>, active: string | undefined): readonly ProcessReport[] =>
    reports.filter(
        (report) =>
            report.kind === `sandbox-setup` &&
            report.state === `done` &&
            report.sandboxId !== undefined &&
            (tiled.has(report.sandboxId) || report.sandboxId === active),
    );

/** The sandbox whose own rail is drawn: its platform id, and the slug `ic` knows it by on its machine. */
export interface RailSandbox {
    readonly id: string | undefined;
    readonly slug: string | undefined;
}

/**
 * Whether a run that finished well is news about some other sandbox than the one whose rail this is (the owner's,
 * 2026-11-04: an update that worked for one sandbox showed its check on every other sandbox's rail too). Home's rail
 * keeps it, and so does that sandbox's own; another sandbox's rail has nothing to say about it. A run that failed or
 * still works is not this: the rail is how it is reached from anywhere. A recreate (an update, a rollback, a reshape)
 * names its sandbox only by its slug (desktop-app's device/sandboxes.ts), so an unknown slug is never a match.
 */
export const doneElsewhere = (report: ProcessReport, here: RailSandbox): boolean => {
    if (report.state !== `done`) {
        return false;
    }
    if (report.sandboxId !== undefined) {
        return report.sandboxId !== here.id;
    }
    return report.kind === `recreate` && (here.slug === undefined || report.subject !== here.slug);
};

/** The tiles a face's rail wears for `reports`, leaving out what the face already draws a tile of its own for. */
export const processTilesOf = (reports: readonly ProcessReport[], drawnElsewhere: (report: ProcessReport) => boolean = () => false): readonly ProcessTile[] =>
    reports.filter((report) => processShown(report) && !drawnElsewhere(report)).map(processTileOf);
