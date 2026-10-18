import { t } from "../../i18n/index.js";
import type { DeviceConflictRow, DeviceFolderRow } from "./deviceDetail.js";

// What a conflict actually is, since a bare count names no file, cause or remedy. Says what happened,
// what it costs (nothing overwritten, just paused), and what ends it, then the paths.
const CONFLICT_ROWS_MAX = 6;

type ConflictChange = NonNullable<DeviceConflictRow[`local`]>;

// `untracked` never reads as somebody's edit, which is what the old wording made of it: a reader told their own
// `node_modules` was "created on this device" goes looking for a difference in content that does not exist.
// Built when read, so the words follow the language on screen.
const onDevice = (change: ConflictChange): string =>
    ({
        created: t(`ui.deviceDetail.createdOnDevice`),
        modified: t(`ui.deviceDetail.changedOnDevice`),
        deleted: t(`ui.deviceDetail.deletedOnDevice`),
        untracked: t(`ui.deviceDetail.buildOutputOnDevice`),
    })[change];

const inSandbox = (change: ConflictChange): string =>
    ({
        created: t(`ui.deviceDetail.createdInSandbox`),
        modified: t(`ui.deviceDetail.changedInSandbox`),
        deleted: t(`ui.deviceDetail.deletedInSandbox`),
        untracked: t(`ui.deviceDetail.buildOutputInSandbox`),
    })[change];

export interface ConflictLine {
    /** The lead counts conflicts, never rows: the machine and Mutagen both cap what they report. */
    readonly path: string;
    /** Relative to the synced folder, so it reads the same against the path above and against /work. */
    readonly note: string;
}

export interface FolderConflicts {
    /** The sentence over the list: what happened to those paths, and what ends it. */
    readonly lead: string;
    readonly rows: readonly ConflictLine[];
    // How many conflicts these rows do NOT account for, counted against the machine's own total.
    readonly more: number;
    /** What happened on each side, as far as the machine reported it; empty when it reported neither. */
    readonly note?: string;
    // How many of the reported paths are the device's own build output blocking a deletion. A button clears exactly
    // these, so a reader is never offered one for a conflict it cannot settle.
    readonly clearable: number;
    // How many need a person, which is what the agent turn is for. Counted off the ROWS, so neither number ever claims
    // anything about the conflicts the report had to leave out.
    readonly disputed: number;
}

const conflictLine = (conflict: DeviceConflictRow): ConflictLine => ({
    // Why there's no list at all: an agent older than the field reports only the count. Absent whenever
    // there is a list, however short.
    path: conflict.path === `` ? t(`ui.deviceDetail.folderItself`) : conflict.path,
    note: [
        conflict.local === undefined ? undefined : onDevice(conflict.local),
        conflict.sandbox === undefined ? undefined : inSandbox(conflict.sandbox),
    ]
        .filter((side) => side !== undefined)
        .join(` · `),
});

// Whether this one is the device's own build output blocking a deletion, rather than two copies of something real.
// Tested FOR the derived shape and never against the other, since an agent older than the classification reports no
// nature at all and everything it sends must read as needing a person.
const isDerived = (conflict: DeviceConflictRow): boolean =>
    conflict.nature === `derived-leftover` && conflict.local === `untracked` && conflict.sandbox === `deleted`;

// TWO UNLIKE THINGS WERE BEING SAID IN ONE SENTENCE, and the common one was being described as the rare one. "Both
// ends changed it, make the copies match" is true of a genuine collision and false of the conflict this view actually
// shows most: a directory the sandbox deleted that this device cannot follow, because build output nothing syncs is
// still sitting in it. Nothing there disagrees, nothing is at stake, and telling somebody to reconcile two copies
// sends them looking for a difference in content that does not exist.
// Kept to two clauses on purpose: at the width this card is read on, the sentence it replaced ran to eight lines
// before the first path, and half of those explained how the sync decides rather than what is stuck.
const derivedLead = (count: number): string => t(`ui.deviceDetail.derivedLead`, { count }, count);

const disputedLead = (count: number): string => t(`ui.deviceDetail.disputedLead`, { count }, count);

export const folderConflicts = (folder: DeviceFolderRow | undefined): FolderConflicts | undefined => {
    const count = folder?.conflicts ?? 0;
    if (folder === undefined || count === 0) {
        return undefined;
    }
    const listed = folder.conflictedPaths ?? [];
    const rows = listed.slice(0, CONFLICT_ROWS_MAX).map(conflictLine);
    const clearable = listed.filter(isDerived).length;
    const disputed = listed.length - clearable;
    // Counted off what the machine actually listed, so an unclassified report (an older agent, or paths the report had
    // to drop) falls to the sentence that asks for a person rather than to the one offering a button.
    const lead =
        clearable === 0
            ? disputedLead(count)
            : disputed === 0
              ? derivedLead(clearable)
              : t(`ui.deviceDetail.derivedAndDisputedLead`, { lead: derivedLead(clearable), count: disputed }, disputed);
    const said: FolderConflicts = { lead, rows, more: count - rows.length, clearable, disputed };
    return rows.length === 0 ? { ...said, note: t(`ui.sandboxDeviceDetail.devicesAgentDoesntReport`) } : said;
};
