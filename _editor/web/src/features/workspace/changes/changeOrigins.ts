import type { GitDiffSide, LandedMessage, LandedMessageDraft, LandedMessageStep, RepoChanges } from "@intentic/api-contract";

// Attribution layer over each repo's `origins` map (path -> agent ids that landed it, newest first); cleared on commit.
// Only agents are ever named — an unlanded change carries no origin, and absence is the signal, not a "you" badge.

// The legend's row for unattributed files; not a real agent id, so no session uuid can collide with it.
export const YOURS = `yours`;

export const originsOf = (repo: RepoChanges, path: string): readonly string[] => repo.origins?.[path] ?? [];

// One legend entry: an agent with files currently in the tree, and how many.
export interface OriginSummary {
    readonly id: string;
    readonly files: number;
}

// Every side a change can sit on; the legend's scope regardless of index state.
export const ALL_SIDES: readonly GitDiffSide[] = [`conflicted`, `staged`, `unstaged`];

// Counts distinct files (not rows) per agent, across every listed side; a file two agents landed counts for both.
// `sides` narrows what counts — the commit box passes the index alone, since only that will be recorded.
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
    // Busiest agent first; ties break by id so chip order doesn't shuffle between polls.
    const agents = [...files].map(([id, count]) => ({ id, files: count })).toSorted((a, b) => b.files - a.files || (a.id < b.id ? -1 : 1));
    return { agents, yours };
};

// A chip's colour, hashed from the agent id so it's stable across reloads without persisting anything.
// Reuses the file-category hues; this panel draws no file-type colours of its own, so there's no clash.
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

// Either carrier of a landing's message (the agent's card, or the review's origin record); same shape, one lookup.
type MessageCarrier = { readonly landedMessage?: LandedMessage } | undefined;

// Card's message wins: it's written and pushed within seconds of the land, while the review refreshes only on demand.
// Falls back to the review, which keeps the sentence after the agent is archived; undefined means nothing written yet.
export const landedMessage = (card: MessageCarrier, origin: MessageCarrier): LandedMessage | undefined =>
    card?.landedMessage ?? origin?.landedMessage;

// Composes the commit message from a landed message's subject and its Release-Note/Breaking-Note trailers.
// Both trailers share one paragraph — git only reads the message's final block as trailers.
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

// True while a draft has no outcome yet — the state every wait-related surface keys on.
export const draftRunning = (draft: LandedMessageDraft | undefined): boolean => draft !== undefined && draft.outcome === undefined;

// Formats milliseconds as seconds, or `Xm Ys` once past a minute.
const seconds = (ms: number): string => {
    const total = Math.round(ms / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
};

// Strips a trailing release-date stamp from a model id (`claude-haiku-4-5-20251001` -> `claude-haiku-4-5`).
const shortModel = (model: string): string => model.replace(/-\d{8}$/, ``).replace(/-\d{4}-\d{2}-\d{2}$/, ``);

// First clause of a refusal reason: cut at the em-dash vendors use to hang advice off the fact, or at the first
// sentence end.
const headline = (reason: string): string => {
    const dash = reason.indexOf(` — `);
    const head = (dash === -1 ? reason : reason.slice(0, dash)).trim();
    const stop = head.indexOf(`. `);
    return (stop === -1 ? head : head.slice(0, stop)).replace(/\.$/, ``).trim();
};

// One report row, split into columns (status glyph, elapsed, reason) rather than one run-on sentence.
export interface DraftReportRow {
    // Stable across ticks so the row doesn't re-key while its clock moves.
    readonly key: string;
    // A step status, or `reading`/`failed` for the two draft-level rows with no model of their own.
    readonly status: LandedMessageStep[`status`] | `reading` | `failed`;
    // Model name, shortened; absent on the two draft-level rows.
    readonly model?: string;
    // What happened, in a few words: the reason's headline, or the phase.
    readonly detail?: string;
    // Time spent; absent for a skip, which spent none.
    readonly elapsed?: string;
    // The row unabridged, for the tooltip.
    readonly title: string;
}

const stepRow = (step: LandedMessageStep, index: number, now: number): DraftReportRow => {
    const model = shortModel(step.model);
    const elapsed =
        step.status === `asking`
            ? step.at === undefined
                ? undefined
                : seconds(Math.max(0, now - step.at))
            : step.ms === undefined
              ? undefined
              : seconds(step.ms);
    const detail =
        step.status === `asking`
            ? `asking…`
            : step.status === `answered`
              ? `wrote the message`
              : step.reason === undefined
                ? step.status === `skipped`
                    ? `skipped, refused a moment ago`
                    : `refused`
                : headline(step.reason);
    // Tooltip carries the full model id and the vendor's sentence, unabridged.
    const said = step.reason === undefined ? `` : `: ${step.reason}`;
    const title =
        step.status === `asking`
            ? `Asking ${step.model}…${elapsed === undefined ? `` : ` ${elapsed}`}`
            : step.status === `answered`
              ? `${step.model} wrote the message${elapsed === undefined ? `` : ` in ${elapsed}`}`
              : step.status === `refused`
                ? `${step.model} refused${elapsed === undefined ? `` : ` after ${elapsed}`}${said}`
                : `Skipped ${step.model}, refused a moment ago${step.reason === undefined ? `` : `: ${step.reason}`}`;
    return {
        key: `${index}-${step.model}`,
        status: step.status,
        model,
        ...(detail === undefined ? {} : { detail }),
        ...(elapsed === undefined ? {} : { elapsed }),
        title,
    };
};

// One row per step, newest last; empty when nothing was ever asked.
// A failed draft with no matching reason in its steps gets a closing row stating why.
export const draftReport = (draft: LandedMessageDraft | undefined, now: number): readonly DraftReportRow[] => {
    if (draft === undefined) {
        return [];
    }
    if (draft.steps.length === 0 && draft.outcome === undefined) {
        return [{ key: `reading`, status: `reading`, detail: `Reading the landed diff…`, title: `Reading the landed diff…` }];
    }
    const rows = draft.steps.map((step, index) => stepRow(step, index, now));
    if (draft.outcome === `failed` && draft.reason !== undefined && !draft.steps.some((step) => step.reason === draft.reason)) {
        const closing = `No message written: ${draft.reason}`;
        return [...rows, { key: `failed`, status: `failed`, detail: closing, title: closing }];
    }
    return rows;
};

// What the commit box needs to decide its notice: which chip is lit, what it has to file, and box ownership.
export interface ChipMessageState {
    // Lit chip's name; undefined when no chip is lit.
    readonly label: string | undefined;
    // True for the "you" row, whose files have no agent-landed sentence.
    readonly yours: boolean;
    // What that chip would file, if anything exists yet.
    readonly message: string | undefined;
    // The full account of that message being drafted, when one exists (the roster's `landedMessageDraft`).
    readonly draft: LandedMessageDraft | undefined;
    // Box holds user-typed text (commitMessage's `boxIsYours`); the chip's message won't overwrite it.
    readonly boxIsYours: boolean;
}

// Notice explaining why the box didn't fill: ordered by what the user can act on (their own box, then a wait, then
// absence). Undefined when no chip is lit or the chip's message is already in the box.
export const chipMessageNotice = (state: ChipMessageState): string | undefined => {
    if (state.label === undefined) {
        return undefined;
    }
    if (state.yours) {
        return `Your changes -- name this commit yourself`;
    }
    const running = draftRunning(state.draft);
    // Applies whether the message exists yet or is still being written; the box takes neither until cleared.
    if (state.boxIsYours && (state.message !== undefined || running)) {
        return `Keeping your message. Clear the box to use ${state.label}'s.`;
    }
    // The wait only; the report row below covers how it's going.
    if (running) {
        return `Writing a message for ${state.label}…`;
    }
    // No message exists and none is coming; the draft's own report row, if any, explains why.
    return state.message === undefined ? `No message written for ${state.label}` : undefined;
};
