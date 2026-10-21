import { formatBytes } from "@intentic/ui";
import { formatCount } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { LocalFolderSetup, LocalProjectPreview } from "../../app/environments/localHost";
import { copyWeight } from "../projectWords";

// HOW FAR A FOLDER'S FIRST COPY IS, AS ITS PAGE SAYS IT (LocalSandboxSetup.vue), read off what the sync already counts:
// Mutagen's status word and, from an agent that reports them, the folder's files and bytes and how many of them the
// sandbox has (the machine agent's sync/report.ts `copyOf`, through the app's folder_setup.rs). Nothing walks the folder to say it.
//
// (2026-10-21) The copy used to be a bar that only swept, under "Getting the sandbox ready for this folder…", for as
// long as the copy took or, when it never started, for three minutes before saying so. A reader could tell neither how
// long it would take nor whether anything was moving. Pure, so each status's words are tested by value.

export interface CopyMeasure {
    /** How far, 0–99; undefined while files cross and nothing counts them (an agent older than the counts). */
    readonly percent: number | undefined;
    /** What the copy is doing, in a few words: connecting, counting, "142 of 328 files", putting files in place. */
    readonly step: string;
    /** Its weight: bytes in of bytes to copy while files cross, else what the copy carries, where that is known. */
    readonly detail: string | undefined;
}

// The share of the bar each stretch of Mutagen's pass is given: next to nothing before files cross and after.
const STAGING_FROM = 3;
const STAGING_SPAN = 94;
const BEFORE = new Map<string, readonly [number, `connecting` | `counting` | `comparing`]>([
    [`disconnected`, [0, `connecting`]],
    [`connecting-alpha`, [0, `connecting`]],
    [`connecting-beta`, [0, `connecting`]],
    [`scanning`, [1, `counting`]],
    [`waiting-for-rescan`, [1, `counting`]],
    [`reconciling`, [2, `comparing`]],
]);
const AFTER = new Map([
    [`transitioning`, 97],
    [`saving`, 98],
]);

// How much of the pass is in, 0–1, by files and by bytes where each is counted; undefined where neither is.
const fractionOf = (copy: NonNullable<LocalFolderSetup[`copy`]>): number | undefined => {
    const shares: number[] = [];
    if (copy.stagingFiles !== undefined && copy.stagingFiles > 0) {
        shares.push((copy.stagedFiles ?? 0) / copy.stagingFiles);
    }
    if (copy.bytes !== undefined && copy.bytes > 0 && copy.stagedBytes !== undefined) {
        shares.push(copy.stagedBytes / copy.bytes);
    }
    if (shares.length === 0) {
        return undefined;
    }
    return Math.min(1, shares.reduce((sum, share) => sum + share, 0) / shares.length);
};

// What the copy carries, before its files cross: the sync's own count once it has scanned, else the page's from before
// the press.
const weightOf = (setup: LocalFolderSetup, preview: LocalProjectPreview | undefined): string | undefined => {
    const files = setup.copy?.files;
    if (files !== undefined) {
        return copyWeight({ files, bytes: setup.copy?.bytes ?? 0, more: false });
    }
    return preview?.kind === `new` ? copyWeight(preview) : undefined;
};

const stagingMeasure = (setup: LocalFolderSetup): CopyMeasure => {
    const copy = setup.copy;
    const fraction = copy === undefined ? undefined : fractionOf(copy);
    if (copy === undefined || fraction === undefined) {
        return { percent: undefined, step: t(`local.setup.copy.copying`), detail: undefined };
    }
    const total = copy.stagingFiles ?? copy.files;
    const step =
        total === undefined
            ? t(`local.setup.copy.copying`)
            : t(`local.setup.copy.files`, { done: formatCount(copy.stagedFiles ?? 0), total: formatCount(total) }, total);
    const detail =
        copy.bytes !== undefined && copy.bytes > 0 && copy.stagedBytes !== undefined
            ? t(`local.setup.copy.bytes`, { done: formatBytes(Math.min(copy.stagedBytes, copy.bytes)), total: formatBytes(copy.bytes) })
            : undefined;
    return { percent: STAGING_FROM + Math.floor(STAGING_SPAN * fraction), step, detail };
};

/** Where a folder's first copy is, as its page says it; `preview` is what the page knew of the folder before the press. */
export const copyMeasureOf = (setup: LocalFolderSetup, preview?: LocalProjectPreview): CopyMeasure => {
    // No word from the sync yet: the sandbox has not taken the folder's first report, which is a connection still coming.
    const status = setup.status ?? `disconnected`;
    const before = BEFORE.get(status);
    if (before !== undefined) {
        return { percent: before[0], step: t(`local.setup.copy.${before[1]}`), detail: weightOf(setup, preview) };
    }
    const after = AFTER.get(status);
    if (after !== undefined) {
        return { percent: after, step: t(`local.setup.copy.placing`), detail: weightOf(setup, preview) };
    }
    return stagingMeasure(setup);
};
