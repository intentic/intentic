import type { Tip, Tone } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MediaStats } from "../../../../models/browsers/media/frameBook";
import type { ScreenStatus } from "./useDeviceScreen";

// THE CONNECTION, IN ONE GLANCE: whether the picture comes straight from the computer (a peer connection) or through
// the sandbox, and the three numbers that say whether it is good, the round trip, frames a second and the bitrate.
// While it is not live, the state instead. Pure, for the badge (ConnectionBadge.vue) and its test.

export interface ScreenBadge {
    readonly tone: Tone;
    readonly label: string;
    // The numbers, once the stream has said them.
    readonly detail: string | undefined;
    readonly tip: Tip;
}

const rate = (kbps: number): string => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${Math.round(kbps)} kb/s`);

/** The stream's numbers in reading order: how late, how smooth, how much. */
export const statsLine = (stats: MediaStats | undefined): string | undefined => {
    if (stats === undefined) {
        return undefined;
    }
    const parts = [stats.rttMs === undefined ? undefined : `${Math.round(stats.rttMs)} ms`, `${stats.fps} fps`, rate(stats.kbps)];
    return parts.filter((part) => part !== undefined).join(` · `);
};

export const screenBadge = (status: ScreenStatus, carrier: `socket` | `peer`, stats: MediaStats | undefined): ScreenBadge => {
    if (status.kind === `live`) {
        const direct = carrier === `peer`;
        const detail = statsLine(stats);
        return {
            tone: direct ? `success` : `info`,
            label: direct ? t(`sandbox.deviceScreen.direct`) : t(`sandbox.deviceScreen.relayed`),
            detail,
            tip: {
                title: direct ? t(`sandbox.deviceScreen.directTitle`) : t(`sandbox.deviceScreen.relayedTitle`),
                note: direct ? t(`sandbox.deviceScreen.directNote`) : t(`sandbox.deviceScreen.relayedNote`),
            },
        };
    }
    if (status.kind === `failed`) {
        return { tone: `danger`, label: t(`sandbox.deviceScreen.notConnected`), detail: undefined, tip: { title: t(`sandbox.deviceScreen.notConnected`) } };
    }
    const label = status.kind === `reconnecting` ? t(`sandbox.deviceScreen.reconnecting`) : t(`sandbox.deviceScreen.connecting`);
    return { tone: `warning`, label, detail: undefined, tip: { title: label } };
};
