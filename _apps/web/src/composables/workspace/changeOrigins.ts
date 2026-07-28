import type { GitDiffSide, RepoChanges } from "@intentic-app/api-contract";

/* WHO PUT THIS FILE IN THE TREE — the Changes panel's attribution layer over the daemon's per-repo `origins`
 * map (path → agent ids that landed it, newest land first; derived from the landed shas in
 * agents/origins.ts, and retired the moment the user commits).
 *
 * Only agents are ever named. A main-tree turn, a terminal edit and your own typing never pass through land,
 * so they carry no origin — and the panel draws NOTHING for them rather than badging them "you": a badge on
 * nine rows out of ten is noise, and it would put a claim on rows where the daemon genuinely doesn't know.
 * Absence is the signal, and the legend states it once ("you N") so the rule is legible instead of implied. */

// The legend's own row for unattributed files, and the value the filter uses for it. Not an agent id, and no
// conversation uuid can collide with it.
export const YOURS = `yours`;

export const originsOf = (repo: RepoChanges, path: string): readonly string[] => repo.origins?.[path] ?? [];

// One legend entry: an agent with work sitting in the tree right now, and how many files it owns.
export interface OriginSummary {
    readonly id: string;
    readonly files: number;
}

// Every side a change can sit on — the legend's scope, because the legend answers "whose work is in my tree"
// and the index has no bearing on that question.
export const ALL_SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

// The legend, across every repo in the review. Counts DISTINCT FILES, not rows: a path that is staged and
// edited again is two rows and one file, and "3 files from this agent" must not read 4 because one of them was
// half-staged. A file two agents landed counts for both — that is the whole reason origins is a list.
//
// `sides` narrows WHICH changes are counted, for the one caller that asks a different question: the commit box's
// suggested subject (commitSuggestion.ts) describes what the commit will RECORD, so with something staged it
// counts the index alone. The legend takes every side.
export const summarizeOrigins = (
    repos: readonly RepoChanges[],
    sides: readonly GitDiffSide[] = ALL_SIDES,
): { agents: readonly OriginSummary[]; yours: number } => {
    const files = new Map<string, number>();
    let yours = 0;
    for (const repo of repos) {
        for (const path of new Set(sides.flatMap((side) => repo[side]).map((change) => change.path))) {
            const ids = originsOf(repo, path);
            if (ids.length === 0) {
                yours += 1;
                continue;
            }
            for (const id of ids) {
                files.set(id, (files.get(id) ?? 0) + 1);
            }
        }
    }
    // Busiest agent first — the legend is read as "who has the most work waiting on me", and a stable tiebreak
    // keeps the chip order from shuffling between polls.
    const agents = [...files].map(([id, count]) => ({ id, files: count })).toSorted((a, b) => b.files - a.files || (a.id < b.id ? -1 : 1));
    return { agents, yours };
};

/* The chip's colour. Agents have no colour of their own, so it is hashed from the id — stable across reloads
 * and across browsers without anything being persisted, which a per-session assignment could not manage.
 *
 * The eight file-category hues are reused deliberately: they are the design system's ONLY set of hues already
 * proven to work as a group in every theme and both colour schemes, and this panel draws no file-type colours
 * at all (its rows are status letter + path), so nothing here can be mistaken for one. */
export interface OriginHue {
    readonly text: string;
    readonly chip: string;
    readonly rail: string;
}

// Full class strings, never interpolated: Tailwind's scanner only sees literals.
export const ORIGIN_HUES: readonly OriginHue[] = [
    { text: `text-file-code`, chip: `bg-file-code/15 text-file-code`, rail: `bg-file-code` },
    { text: `text-file-style`, chip: `bg-file-style/15 text-file-style`, rail: `bg-file-style` },
    { text: `text-file-config`, chip: `bg-file-config/15 text-file-config`, rail: `bg-file-config` },
    { text: `text-file-data`, chip: `bg-file-data/15 text-file-data`, rail: `bg-file-data` },
    { text: `text-file-image`, chip: `bg-file-image/15 text-file-image`, rail: `bg-file-image` },
    { text: `text-file-doc`, chip: `bg-file-doc/15 text-file-doc`, rail: `bg-file-doc` },
    { text: `text-file-shell`, chip: `bg-file-shell/15 text-file-shell`, rail: `bg-file-shell` },
    { text: `text-file-archive`, chip: `bg-file-archive/15 text-file-archive`, rail: `bg-file-archive` },
];

export const originHue = (id: string): OriginHue => {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) {
        hash = (hash * 31 + id.charCodeAt(index)) % 1_000_003;
    }
    return ORIGIN_HUES[hash % ORIGIN_HUES.length]!;
};
