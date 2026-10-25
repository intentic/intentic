import type { GitChange, WorkspaceModule } from "@intentic/sandbox-contract/schemas/git/git";
import { moduleOf } from "@intentic/sandbox-contract/models/module-of";

// WHICH PACKAGES A CONVERSATION'S CHANGES FALL IN, for the card: the board colours a session by the package it works in
// and names it above the title, so two sessions on the same view read as kin at a glance. Read off the very changes the
// diff stat counts, bucketed by the rule the review panel groups the same files by (moduleOf), so the card's count,
// its package and the review's headings can't disagree.

// How many the card is given. One colours it, the rest only say "and more".
const MODULES_SHOWN = 3;

export interface DiffStat {
    files: number;
    insertions: number;
    deletions: number;
    // Each package's count of changed files, by the name the package declares; absent where nothing was counted.
    modules?: Record<string, number> | undefined;
}

// One repository's stat. A file no package claims counts toward the repository by its name, except in the workspace
// root (`root`), whose loose files (an agent's notes, a top-level config) are no package of anyone's.
export const diffStatOf = (changes: readonly GitChange[], modules: readonly WorkspaceModule[], repo: string): DiffStat => {
    const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
    const tally: Record<string, number> = {};
    for (const change of changes) {
        stat.files += 1;
        stat.insertions += change.additions ?? 0;
        stat.deletions += change.deletions ?? 0;
        const name = moduleOf(change.path, modules)?.name ?? (repo === `root` ? undefined : repo);
        if (name !== undefined) {
            tally[name] = (tally[name] ?? 0) + 1;
        }
    }
    return Object.keys(tally).length === 0 ? stat : { ...stat, modules: tally };
};

// Several repositories' stats as one conversation's.
export const sumDiffStats = (stats: readonly DiffStat[]): DiffStat => {
    const sum: DiffStat = { files: 0, insertions: 0, deletions: 0 };
    const tally: Record<string, number> = {};
    for (const stat of stats) {
        sum.files += stat.files;
        sum.insertions += stat.insertions;
        sum.deletions += stat.deletions;
        for (const [name, files] of Object.entries(stat.modules ?? {})) {
            tally[name] = (tally[name] ?? 0) + files;
        }
    }
    return Object.keys(tally).length === 0 ? sum : { ...sum, modules: tally };
};

// The card's count alone: the tally rides the stored landing, never the wire's `diff`, which has `modules` of its own.
export const countsOf = (stat: DiffStat | undefined): Omit<DiffStat, "modules"> | undefined =>
    stat === undefined ? undefined : { files: stat.files, insertions: stat.insertions, deletions: stat.deletions };

// The names the card is given, most-changed first; a tie goes to the name, so the order is the same on every read.
// Undefined for nothing counted, which is a card with no package rather than an empty list.
export const rankedModules = (tally: Readonly<Record<string, number>> | undefined): string[] | undefined => {
    const ranked = Object.entries(tally ?? {})
        .filter(([, files]) => files > 0)
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .slice(0, MODULES_SHOWN)
        .map(([name]) => name);
    return ranked.length === 0 ? undefined : ranked;
};
