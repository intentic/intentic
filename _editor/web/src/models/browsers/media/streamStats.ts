import { ref } from "vue";
import type { MediaStats } from "./frameBook";

// Whether the live pictures show their stream's numbers (StreamStats.vue): one switch for the whole editor, from the
// browser's menu, or on from the start with `?streamStats` in the address, for a measurement that begins at load.
// allow(module-state): a debugging overlay's switch, shared by every live picture in this window
export const streamStatsShown = ref(`location` in globalThis && new URLSearchParams(globalThis.location.search).has(`streamStats`));

export const toggleStreamStats = (): void => {
    streamStatsShown.value = !streamStatsShown.value;
};

/** One line of the overlay: a label and its value, rounded for reading; undefined fields have no sample yet. */
export interface StatLine {
    readonly label: string;
    readonly value: string;
}

const ms = (value: number | undefined): string => (value === undefined ? `–` : `${Math.round(value)} ms`);

/** The overlay's lines, in the order a person reads a stream's health: is it moving, how late, why. */
export const statLines = (stats: MediaStats): readonly StatLine[] => [
    { label: `fps`, value: `${stats.fps}${stats.sentFps === undefined ? `` : ` / ${Math.round(stats.sentFps)} sent`}` },
    { label: `age p50/p95`, value: `${ms(stats.ageMs)} / ${ms(stats.ageP95Ms)}` },
    { label: `decode`, value: ms(stats.decodeMs) },
    { label: `rtt`, value: ms(stats.rttMs) },
    { label: `queue`, value: ms(stats.queueMs) },
    { label: `rate`, value: `${Math.round(stats.kbps)} kbps${stats.targetKbps === undefined ? `` : ` / ${Math.round(stats.targetKbps)} target`}` },
    { label: `dropped`, value: `${stats.dropped}` },
    { label: `picture`, value: `${stats.width}×${stats.height} @${stats.scale}x · ${stats.stripes} stripe${stats.stripes === 1 ? `` : `s`}` },
    ...(stats.audioMs === undefined ? [] : [{ label: `sound`, value: `${ms(stats.audioMs)} / ${ms(stats.audioTargetMs)} target` }]),
];
