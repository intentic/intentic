import type { GitDiffSide, LandedMessage, RepoChanges } from "@intentic-app/api-contract";

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
// `sides` narrows WHICH changes are counted, for the caller that asks a different question: the commit box's
// "a session hasn't finished" warning is about what the commit will RECORD, so for a plain Commit it counts the
// index alone. The legend takes every side.
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

// Either carrier of a landing's drafted message: the agent's own card, and the review's origin record. Both
// hold the same shape, which is what lets the rule below be one lookup instead of two branches.
type MessageCarrier = { readonly landedMessage?: LandedMessage } | undefined;

/* WHICH COPY OF THE SENTENCE THE CHIP READS — the card's, then the review's.
 *
 * THE CARD FIRST, because it is the one that is LIVE. This sentence is written by a model that starts when the
 * work lands and answers seconds later, which is exactly the window in which someone walks over to the Changes
 * panel and clicks the chip waiting for it. The roster is pushed the moment it is written; the review is a
 * workspace-wide rescan that refreshes only when something asks. Reading it out of the review alone left the
 * box empty until an unrelated write happened to refresh the panel — a message that existed, that the user had
 * been promised, and that nothing was ever going to deliver.
 *
 * THE REVIEW SECOND, because the roster drops an archived agent while its landed lines are still in the tree,
 * and land → archive → commit at leisure is an ordinary flow. Same rule the chip's title and logo already
 * follow, for the same two reasons.
 *
 * Undefined ⇒ neither has one: nothing was written for this landing, or it is still being written (the card's
 * `draftingSubject` is what tells those apart). The chip then files nothing and simply filters. */
export const landedMessage = (card: MessageCarrier, origin: MessageCarrier): LandedMessage | undefined =>
    card?.landedMessage ?? origin?.landedMessage;

/* THE MESSAGE AS A COMMIT MESSAGE — the subject, and the `Release-Note:` / `Breaking-Note:` trailers under it
 * when this landing had them (a repo that keeps a changelog, and a change its users would notice — or lose).
 *
 * Composed HERE rather than stored joined, because a subject is one line everywhere it is SHOWN — the chip in
 * the legend is one line — and the parts only become a commit message at this moment.
 *
 * The two trailers share ONE paragraph, joined by a single newline: git only reads the message's final block as
 * trailers, so a blank line between them would demote the first to body text and the release harvest would
 * never see it. */
export const commitMessageOf = (landed: LandedMessage | undefined): string | undefined => {
    if (landed === undefined) {
        return undefined;
    }
    const trailers = [
        landed.note === undefined ? `` : `Release-Note: ${landed.note}`,
        landed.breaking === undefined ? `` : `Breaking-Note: ${landed.breaking}`,
    ]
        .filter((line) => line !== ``)
        .join(`\n`);
    return [landed.subject, trailers].filter((part) => part !== ``).join(`\n\n`);
};
