import { t } from "../../i18n/index.js";
import { formatBinaryBytes } from "../../lib/format.js";
import { formatUntil } from "../../lib/timeWindow.js";
import type { Tip } from "../../lib/tooltip.js";

// WHAT A DEVICE HOLDS BACK BY ITSELF (2026-10-18), as its card says it. A folder's sync paused because the drive it is
// on is nearly full (the machine agent's low-disk.ts): the one pause nobody chose and the owner can end by freeing room,
// so it reads as a warning with the numbers, where a pause somebody chose wears quiet ink. And repos whose git history on
// that computer stopped following the sandbox for a while because a fetch did not finish (git-bridge.ts): their files
// still sync, so it is said as history lagging, never as sync failing.

export interface DeviceLowDiskRow {
    readonly freeBytes: number;
    readonly totalBytes: number;
}

export interface DeviceBridgeHoldRow {
    repo: string;
    reason: string;
    retryAt: number;
}

// The numbers behind a low-disk pause, and that it ends by itself.
const diskFullHint = (low: DeviceLowDiskRow): string =>
    t(`ui.deviceDetail.diskFullHint`, { free: formatBinaryBytes(low.freeBytes), total: formatBinaryBytes(low.totalBytes) });

// Built when read, so the words follow the language on screen. A reason a newer agent sends reads as the plain refusal.
const holdReason = (reason: string): string =>
    reason === `stalled`
        ? t(`ui.deviceDetail.historyStalled`)
        : reason === `too-long`
          ? t(`ui.deviceDetail.historyTooLong`)
          : reason === `shallow`
            ? t(`ui.deviceDetail.historyShallow`)
            : t(`ui.deviceDetail.historyFailed`);

// Which repos lag, why, and when each is tried again.
export const historyHint = (held: readonly DeviceBridgeHoldRow[]): Tip => ({
    title: t(`ui.deviceDetail.historyBehindTitle`),
    rows: held.map((hold) => ({ label: hold.repo, value: `${holdReason(hold.reason)} · ${t(`ui.deviceDetail.historyRetry`, { when: formatUntil(hold.retryAt) })}` })),
});

// WHY A FOLDER'S FILE SYNC IS NOT RUNNING, AND WHOSE WORD LIFTS IT (2026-10-20). The machine agent says what holds it
// (`heldBy`, its holds.ts), the owner's own pause first; only that one is a person's to lift, and every other ends by
// itself, so a page that offered Resume for any paused session asked for a press that changed nothing (fair-moth,
// 2026-10-19). An agent older than `heldBy` says only that Mutagen has it paused: a pause a person may lift, as it was.
export interface FolderHold {
    /** The short word, where a row says its state ("paused", "held"). */
    readonly word: string;
    /** The chip's label. */
    readonly label: string;
    readonly hint: string;
    readonly tone: `quiet` | `warning`;
    /** Whether Resume is the owner's to press. */
    readonly resumable: boolean;
}

export interface HeldFolder {
    readonly paused?: boolean | undefined;
    readonly heldBy?: readonly string[] | undefined;
    readonly lowDisk?: DeviceLowDiskRow | undefined;
}

// What a hold the agent made says about itself; a reason a newer agent sends reads as the plain one.
const heldHint = (hold: string | undefined): string =>
    hold === `gone`
        ? t(`ui.deviceDetail.heldBy.gone`)
        : hold === `container-missing`
          ? t(`ui.deviceDetail.heldBy.containerMissing`)
          : hold === `container-trashed`
            ? t(`ui.deviceDetail.heldBy.containerTrashed`)
            : hold === `swap`
              ? t(`ui.deviceDetail.heldBy.swap`)
              : hold === `unreachable`
                ? t(`ui.deviceDetail.heldBy.unreachable`)
                : t(`ui.deviceDetail.heldBy.other`);

export const folderHold = (folder: HeldFolder | undefined): FolderHold | undefined => {
    const held = folder?.heldBy ?? [];
    const lowDisk = folder?.lowDisk;
    if (held[0] === `owner` || (held.length === 0 && lowDisk === undefined && folder?.paused === true)) {
        return { word: t(`ui.deviceDetail.paused`), label: t(`ui.deviceDetail.fileSyncingPaused`), hint: t(`ui.deviceDetail.syncPaused`), tone: `quiet`, resumable: true };
    }
    if (lowDisk !== undefined) {
        return { word: t(`ui.deviceDetail.diskFull`), label: t(`ui.deviceDetail.diskFull`), hint: diskFullHint(lowDisk), tone: `warning`, resumable: false };
    }
    return held.length === 0
        ? undefined
        : { word: t(`ui.deviceDetail.held`), label: t(`ui.deviceDetail.fileSyncingHeld`), hint: heldHint(held[0]), tone: `quiet`, resumable: false };
};

// The closed line's words for both, when they hold.
export const holdWarnings = (folder: { readonly lowDisk?: DeviceLowDiskRow | undefined; readonly bridgeHolds?: readonly unknown[] | undefined } | undefined): string[] => {
    const held = folder?.bridgeHolds?.length ?? 0;
    return [
        ...(folder?.lowDisk === undefined ? [] : [t(`ui.deviceDetail.diskFull`)]),
        ...(held > 0 ? [t(`ui.deviceDetail.historyBehind`, { count: held }, held)] : []),
    ];
};
