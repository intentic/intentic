import type { WorkspaceHotspot, WorkspaceKeyModule } from "@intentic-app/api-contract";
import { hotspotAsk, moduleAsk, type RefactorAsk } from "./refactorAsk";

/* The arithmetic behind the Codebase Health tab, as pure functions over the daemon's report, the same split as
 * usageChart.ts: the component binds, this file computes, and the numbers a reader is asked to act on are
 * testable without mounting anything. The refactor each row offers to start is part of that: it is DERIVED from
 * these same figures (refactorAsk.ts), so it is decided and tested here rather than assembled in a template. */

// Churn windows the panel offers. "All history" is the default because a hotspot ranking wants every commit a
// file ever took; the narrower windows answer "what is hot NOW", which is a different question, so it is a
// deliberate switch rather than a default.
export type ChurnWindow = "all" | "90d" | "30d" | "7d";
// Mutable by design: <SegmentedControl> takes its options array as-is.
export const CHURN_WINDOWS: { label: string; value: ChurnWindow; title: string }[] = [
    { label: `All`, value: `all`, title: `Every commit in the repository's history` },
    { label: `90d`, value: `90d`, title: `Commits from the last 90 days` },
    { label: `30d`, value: `30d`, title: `Commits from the last 30 days` },
    { label: `7d`, value: `7d`, title: `Commits from the last 7 days` },
];

// A path split at its last separator, so a row can dim the directory and keep the filename legible, the part
// that identifies the file is the part that must survive truncation.
export const splitPath = (path: string): { dir: string; name: string } => {
    const cut = path.lastIndexOf(`/`);
    return { dir: cut === -1 ? `` : path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

// One hotspot row, ready to render: the ranking's numbers plus the bar's length. `share` is scaled against the
// LEADER, not an axis, a ranked list is read by comparing rows to each other, and there is no gridline here to
// round up to (the same choice UsageBarChart makes).
export interface HotspotRow extends WorkspaceHotspot {
    readonly dir: string;
    readonly name: string;
    // 0..1 of the top row's score. Never 0 for a file that placed at all, a bar that vanishes reads as "no
    // risk" when it means "much less than the leader".
    readonly share: number;
    // Which refactor this row's own figures call for, and the turn that starts it.
    readonly ask: RefactorAsk;
}

const MIN_SHARE = 0.02;

// The middle of a set of counts. Used for the peer group a key module's export surface is called wide against,
// a mean would be dragged by the very outlier being looked for.
export const median = (values: readonly number[]): number => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.toSorted((first, second) => first - second);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

// The key modules come in beside the hotspots because a file in BOTH lists is a different problem from a file in
// either, volatile and depended-on at once (refactorAsk.ts). `nowMs` is passed rather than read: a row's
// posture depends on how long ago its file was last touched, and a function that reads the clock itself cannot
// be tested on the boundary it exists to draw.
export const hotspotRows = (
    hotspots: readonly WorkspaceHotspot[],
    modules: readonly WorkspaceKeyModule[],
    window: ChurnWindow,
    nowMs: number,
): HotspotRow[] => {
    const top = hotspots[0]?.score ?? 0;
    // The ranking sorts by the PRODUCT, so neither signal's leader is necessarily the first row, each share is
    // taken against the largest of that signal in the list the user is reading.
    const leader = {
        commits: Math.max(0, ...hotspots.map((hotspot) => hotspot.commits)),
        complexity: Math.max(0, ...hotspots.map((hotspot) => hotspot.complexity)),
    };
    const keyModules = new Set(modules.map((module) => module.path));
    return hotspots.map((hotspot, index) => ({
        ...hotspot,
        ...splitPath(hotspot.path),
        share: top === 0 ? 0 : Math.max(MIN_SHARE, hotspot.score / top),
        ask: hotspotAsk(hotspot, { rank: index + 1, window, leader, keyModule: keyModules.has(hotspot.path), nowMs }),
    }));
};

// One key-module row. `ask` is undefined for most of them: PageRank's top is where a healthy chokepoint lives
// too, and only an outsized export surface is a finding (refactorAsk.ts).
export interface ModuleRow extends WorkspaceKeyModule {
    readonly dir: string;
    readonly name: string;
    readonly ask: RefactorAsk | undefined;
}

export const moduleRows = (modules: readonly WorkspaceKeyModule[]): ModuleRow[] => {
    const medianExports = median(modules.map((module) => module.exports));
    return modules.map((module, index) => ({
        ...module,
        ...splitPath(module.path),
        ask: moduleAsk(module, { rank: index + 1, medianExports }),
    }));
};

// Thousands-separated while the exact number still fits a tile, compact past a million. These are counts a
// reader may want to compare or repeat, so rounding them early ("10k symbols") costs real information for
// space that was never short.
export const formatCount = (value: number): string => (value < 1_000_000 ? value.toLocaleString(`en-US`) : `${(value / 1_000_000).toFixed(1)}M`);

// Branch points per file, the shape "complexity" is actually read in ("this repo averages 9 decisions a file").
// The raw total is meaningless without the denominator, and one file in ten thousand is not a repo-level fact.
export const perFile = (total: number, files: number): string => (files === 0 ? `—` : (total / files).toFixed(1));
