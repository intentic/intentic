import type { DerivedDoc, Deriver } from "./deriver.js";

/* Media derivation reads container duration, codecs, and tags without decoding frames. */

// music-metadata is 0.2s to load, and only a recording needs it; see xlsx.ts for why that is loaded inside derive().

const formatDuration = (seconds: number): string => {
    const whole = Math.round(seconds);
    const minutes = Math.floor(whole / 60);
    return minutes === 0 ? `${whole}s` : `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
};

export const mediaDeriver: Deriver = {
    name: "media",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const { parseFile } = await import("music-metadata");
        const meta = await parseFile(absPath, { duration: true });
        const lines: string[] = [];
        const { format, common } = meta;
        if (format.container !== undefined) {
            lines.push(`- Container: ${format.container}${format.codec === undefined ? "" : ` (${format.codec})`}`);
        }
        if (format.duration !== undefined) {
            lines.push(`- Duration: ${formatDuration(format.duration)}`);
        }
        if (format.sampleRate !== undefined) {
            lines.push(`- Sample rate: ${format.sampleRate} Hz${format.numberOfChannels === undefined ? "" : `, ${format.numberOfChannels}ch`}`);
        }
        if (format.bitrate !== undefined) {
            lines.push(`- Bitrate: ${Math.round(format.bitrate / 1000)} kbit/s`);
        }
        const tags: readonly (readonly [string, string | number | undefined])[] = [
            ["Title", common.title],
            ["Artist", common.artist],
            ["Album", common.album],
            ["Year", common.year],
            ["Genre", common.genre?.join(", ")],
        ];
        for (const [label, value] of tags) {
            if (value !== undefined && value !== "") {
                lines.push(`- ${label}: ${value}`);
            }
        }
        return {
            markdown: lines.join("\n"),
            title: common.title,
            notes: ["no transcript: audio transcription is a later, whisper-backed tier"],
        };
    },
};
