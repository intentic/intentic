import type { WorkspaceHotspot } from "@intentic-app/api-contract";

/* The arithmetic behind the Codebase Health tab, as pure functions over the daemon's report — the same split as
 * usageChart.ts: the component binds, this file computes, and the numbers a reader is asked to act on are
 * testable without mounting anything. */

// Churn windows the panel offers. "All history" is the default because a hotspot ranking wants every commit a
// file ever took; the narrower windows answer "what is hot NOW", which is a different question, so it is a
// deliberate switch rather than a default.
export type ChurnWindow = "all" | "90d" | "30d" | "7d";
// Mutable by design — <Segmented> takes its options array as-is.
export const CHURN_WINDOWS: { label: string; value: ChurnWindow; title: string }[] = [
    { label: `All`, value: `all`, title: `Every commit in the repository's history` },
    { label: `90d`, value: `90d`, title: `Commits from the last 90 days` },
    { label: `30d`, value: `30d`, title: `Commits from the last 30 days` },
    { label: `7d`, value: `7d`, title: `Commits from the last 7 days` },
];

// A path split at its last separator, so a row can dim the directory and keep the filename legible — the part
// that identifies the file is the part that must survive truncation.
export const splitPath = (path: string): { dir: string; name: string } => {
    const cut = path.lastIndexOf(`/`);
    return { dir: cut === -1 ? `` : path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

// One hotspot row, ready to render: the ranking's numbers plus the bar's length. `share` is scaled against the
// LEADER, not an axis — a ranked list is read by comparing rows to each other, and there is no gridline here to
// round up to (the same choice UsageBarChart makes).
export interface HotspotRow extends WorkspaceHotspot {
    readonly dir: string;
    readonly name: string;
    // 0..1 of the top row's score. Never 0 for a file that placed at all — a bar that vanishes reads as "no
    // risk" when it means "much less than the leader".
    readonly share: number;
}

const MIN_SHARE = 0.02;

export const hotspotRows = (hotspots: readonly WorkspaceHotspot[]): HotspotRow[] => {
    const top = hotspots[0]?.score ?? 0;
    return hotspots.map((hotspot) => ({
        ...hotspot,
        ...splitPath(hotspot.path),
        share: top === 0 ? 0 : Math.max(MIN_SHARE, hotspot.score / top),
    }));
};

// Thousands-separated while the exact number still fits a tile, compact past a million. These are counts a
// reader may want to compare or repeat, so rounding them early ("10k symbols") costs real information for
// space that was never short.
export const formatCount = (value: number): string => (value < 1_000_000 ? value.toLocaleString(`en-US`) : `${(value / 1_000_000).toFixed(1)}M`);

// Branch points per file, the shape "complexity" is actually read in ("this repo averages 9 decisions a file").
// The raw total is meaningless without the denominator, and one file in ten thousand is not a repo-level fact.
export const perFile = (total: number, files: number): string => (files === 0 ? `—` : (total / files).toFixed(1));
