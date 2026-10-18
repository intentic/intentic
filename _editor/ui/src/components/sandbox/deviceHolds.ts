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
export const diskFullHint = (low: DeviceLowDiskRow): string =>
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

// The closed line's words for both, when they hold.
export const holdWarnings = (folder: { readonly lowDisk?: DeviceLowDiskRow | undefined; readonly bridgeHolds?: readonly unknown[] | undefined } | undefined): string[] => {
    const held = folder?.bridgeHolds?.length ?? 0;
    return [
        ...(folder?.lowDisk === undefined ? [] : [t(`ui.deviceDetail.diskFull`)]),
        ...(held > 0 ? [t(`ui.deviceDetail.historyBehind`, { count: held }, held)] : []),
    ];
};
