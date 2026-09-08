import type { WorkspaceHotspot, WorkspaceKeyModule } from "@intentic/api-contract";
import { hotspotAsk, moduleAsk, type RefactorAsk } from "./refactorAsk";

// Pure-function arithmetic behind the Codebase Health tab: the component binds, this computes, so the numbers
// are testable without mounting anything. Each row's refactor offer is derived from these same figures
// (refactorAsk.ts), decided and tested here, not in the template.

// `all` is the default: a hotspot ranking wants every commit a file ever took. The narrower windows answer a
// different question, what's hot now.
export type ChurnWindow = "all" | "90d" | "30d" | "7d";
// Mutable by design; <SegmentedControl> takes its options array as-is.
export const CHURN_WINDOWS: { label: string; value: ChurnWindow; title: string }[] = [
    { label: `All`, value: `all`, title: `Every commit in the repository's history` },
    { label: `90d`, value: `90d`, title: `Commits from the last 90 days` },
    { label: `30d`, value: `30d`, title: `Commits from the last 30 days` },
    { label: `7d`, value: `7d`, title: `Commits from the last 7 days` },
];

// Splits a path at its last separator, so a row can dim the directory while the filename (the part that
// identifies it) survives truncation.
export const splitPath = (path: string): { dir: string; name: string } => {
    const cut = path.lastIndexOf(`/`);
    return { dir: cut === -1 ? `` : path.slice(0, cut + 1), name: path.slice(cut + 1) };
};

// Ranking's numbers plus the bar's length; `share` is scaled against the leader, since a ranked list is read
// by comparing rows, not an axis.
export interface HotspotRow extends WorkspaceHotspot {
    readonly dir: string;
    readonly name: string;
    // 0..1 of the top row's score; never 0 for a file that placed, so a vanished bar can't read as no risk.
    readonly share: number;
    // Which refactor this row's figures call for, and the turn that starts it.
    readonly ask: RefactorAsk;
}

const MIN_SHARE = 0.02;

// Median of a set of counts, used for the peer group a module's export surface compares against; a mean would
// be dragged by the very outlier being looked for.
export const median = (values: readonly number[]): number => {
    if (values.length === 0) {
        return 0;
    }
    const sorted = values.toSorted((first, second) => first - second);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
};

// `nowMs` is passed in, not read live, so a row's dormancy posture can be tested at its boundary. Key modules
// are cross-referenced since a file in both lists is a different problem than either alone.
export const hotspotRows = (
    hotspots: readonly WorkspaceHotspot[],
    modules: readonly WorkspaceKeyModule[],
    window: ChurnWindow,
    nowMs: number,
): HotspotRow[] => {
    const top = hotspots[0]?.score ?? 0;
    // Ranking sorts by the product; each share compares against that signal's own max, not necessarily row one.
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

// `ask` is undefined for most rows: PageRank's top is also where a healthy chokepoint lives, and only an
// outsized export surface is a finding.
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

// Thousands-separated up to a million, then compact; these are counts a reader may want to compare or repeat,
// so early rounding costs real information.
export const formatCount = (value: number): string => (value < 1_000_000 ? value.toLocaleString(`en-US`) : `${(value / 1_000_000).toFixed(1)}M`);

// Branch points per file, since a raw total is meaningless without the file count and not a repo-level fact on its own.
export const perFile = (total: number, files: number): string => (files === 0 ? `—` : (total / files).toFixed(1));
