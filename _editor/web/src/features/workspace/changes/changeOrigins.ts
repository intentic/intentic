import {
    landedCommitMessage,
    type GitDiffSide,
    type LandedMessage,
    type LandedMessageDraft,
    type LandedMessageStep,
    type RepoChanges,
    UNATTRIBUTED_ORIGIN,
} from "@intentic/sandbox-contract";
import type { TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";

// Attribution layer over each repo's `origins` map (path -> agent ids that landed it, newest first); cleared on commit.
// Only agents are ever named — an unlanded change carries no origin, and absence is the signal, not a "you" badge.

// The legend's row for unattributed files. The daemon's own name for them, so a scope sent with it resolves to exactly
// the files this row counts.
export const YOURS = UNATTRIBUTED_ORIGIN;

export const originsOf = (repo: RepoChanges, path: string): readonly string[] => repo.origins?.[path] ?? [];

// Whether a path is that origin's: a session it landed, or for YOURS a path no session did.
export const isFrom = (repo: RepoChanges, path: string, id: string): boolean => {
    const ids = originsOf(repo, path);
    return id === YOURS ? ids.length === 0 : ids.includes(id);
};

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
    // The legend chip once it is lit (it stages and narrows to that work): a denser plate of the same hue with an edge
    // drawn in it, so on and off differ in fill, outline and weight at once rather than by one small glyph.
    readonly chipOn: string;
}

// Full class strings, never interpolated: Tailwind's scanner only sees literals.
export const ORIGIN_HUES: readonly OriginHue[] = [
    { text: `text-file-code`, chip: `bg-file-code/15 text-file-code`, chipOn: `bg-file-code/30 border-file-code/70 text-file-code` },
    { text: `text-file-style`, chip: `bg-file-style/15 text-file-style`, chipOn: `bg-file-style/30 border-file-style/70 text-file-style` },
    { text: `text-file-config`, chip: `bg-file-config/15 text-file-config`, chipOn: `bg-file-config/30 border-file-config/70 text-file-config` },
    { text: `text-file-data`, chip: `bg-file-data/15 text-file-data`, chipOn: `bg-file-data/30 border-file-data/70 text-file-data` },
    { text: `text-file-image`, chip: `bg-file-image/15 text-file-image`, chipOn: `bg-file-image/30 border-file-image/70 text-file-image` },
    { text: `text-file-doc`, chip: `bg-file-doc/15 text-file-doc`, chipOn: `bg-file-doc/30 border-file-doc/70 text-file-doc` },
    { text: `text-file-shell`, chip: `bg-file-shell/15 text-file-shell`, chipOn: `bg-file-shell/30 border-file-shell/70 text-file-shell` },
    { text: `text-file-archive`, chip: `bg-file-archive/15 text-file-archive`, chipOn: `bg-file-archive/30 border-file-archive/70 text-file-archive` },
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

// A live card is the answer, message or none: it is written and pushed within seconds of the land, while the review
// refreshes only on demand, so a card whose message a newer land cleared must not fall back to the review's copy of the
// sentence it replaced (that is how one land's subject headed the next land's commit). Only an agent off the roster
// (archived) is read from the review, which keeps its sentence; undefined means nothing written yet.
export const landedMessage = (card: MessageCarrier, origin: MessageCarrier): LandedMessage | undefined =>
    card === undefined ? origin?.landedMessage : card.landedMessage;

// The commit message a landed message makes (landedCommitMessage), or undefined when nothing is written yet.
export const commitMessageOf = (landed: LandedMessage | undefined): string | undefined => (landed === undefined ? undefined : landedCommitMessage(landed));

// True while a draft has no outcome yet — the state every wait-related surface keys on.
export const draftRunning = (draft: LandedMessageDraft | undefined): boolean => draft !== undefined && draft.outcome === undefined;

// Formats milliseconds as seconds, or `Xm Ys` once past a minute.
const seconds = (ms: number): string => {
    const total = Math.round(ms / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
};

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
    // What the model is called (providerCatalog.modelLabelFor); absent on the two draft-level rows.
    readonly model?: string;
    // What happened, in a few words: the reason's headline, or the phase.
    readonly detail?: string;
    // Time spent; absent for a skip, which spent none.
    readonly elapsed?: string;
    // The hover: the full model id and the time a step took, or a failure's whole reason. Absent where the row says it all.
    readonly tip?: TooltipValue;
}

const stepRow = (step: LandedMessageStep, index: number, now: number): DraftReportRow => {
    const model = modelLabelFor(step.provider, step.model);
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
            ? t(`workspace.changeOrigins.askingNow`)
            : step.status === `answered`
              ? t(`workspace.changeOrigins.wroteMessage`)
              : step.reason === undefined
                ? step.status === `skipped`
                    ? t(`workspace.changeOrigins.skippedRefused`)
                    : t(`workspace.changeOrigins.refusedLower`)
                : headline(step.reason);
    // The row already shows the model's name, the reason's headline and the time; the card adds the full model id.
    const phase =
        step.status === `asking`
            ? t(`workspace.changeOrigins.asking`)
            : step.status === `answered`
              ? t(`workspace.changeOrigins.answered`)
              : t(`workspace.changeOrigins.refused`);
    return {
        key: `${index}-${step.model}`,
        status: step.status,
        model,
        ...(detail === undefined ? {} : { detail }),
        ...(elapsed === undefined ? {} : { elapsed }),
        tip: { title: step.model, rows: [{ label: phase, value: elapsed ?? `` }] },
    };
};

// One row per step, newest last; empty when nothing was ever asked.
// A failed draft with no matching reason in its steps gets a closing row stating why.
export const draftReport = (draft: LandedMessageDraft | undefined, now: number): readonly DraftReportRow[] => {
    if (draft === undefined) {
        return [];
    }
    if (draft.steps.length === 0 && draft.outcome === undefined) {
        return [
            {
                key: `reading`,
                status: `reading`,
                detail: t(`workspace.changeOrigins.readingLandedDiff`),
            },
        ];
    }
    const rows = draft.steps.map((step, index) => stepRow(step, index, now));
    if (draft.outcome === `failed` && draft.reason !== undefined && !draft.steps.some((step) => step.reason === draft.reason)) {
        const closing = t(`workspace.changeOrigins.noMessageWritten`, { reason: draft.reason });
        return [...rows, { key: `failed`, status: `failed`, detail: closing, tip: draft.reason }];
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

// The model the draft is waiting on right now: its newest step, while that step is still out. Undefined while the diff is
// still being read, and between a refusal and the next ask.
export const askingModel = (draft: LandedMessageDraft | undefined): string | undefined => {
    const step = draft?.steps.at(-1);
    return step?.status === `asking` ? modelLabelFor(step.provider, step.model) : undefined;
};

// Notice explaining why the box didn't fill: ordered by what the user can act on (their own box, then a wait, then
// absence). Undefined when no chip is lit or the chip's message is already in the box.
export const chipMessageNotice = (state: ChipMessageState): string | undefined => {
    if (state.label === undefined) {
        return undefined;
    }
    if (state.yours) {
        return t(`workspace.changeOrigins.yourChangesNameIt`);
    }
    const running = draftRunning(state.draft);
    // Applies whether the message exists yet or is still being written; the box takes neither until cleared.
    if (state.boxIsYours && (state.message !== undefined || running)) {
        return t(`workspace.changeOrigins.keepingYourMessage`, { origin: state.label });
    }
    // The wait, naming the model being asked when there is one: this placeholder is the only place the box says who is
    // writing. Then it leaves the origin to the lit chip under the box, so the line stays one line in a sidebar. The
    // step-by-step rides the box's progress mark.
    if (running) {
        const model = askingModel(state.draft);
        return model === undefined
            ? t(`workspace.changeOrigins.writingMessageFor`, { origin: state.label })
            : t(`workspace.changeOrigins.modelWritingFor`, { model });
    }
    // No message exists and none is coming; the draft's own report row, if any, explains why.
    return state.message === undefined ? t(`workspace.changeOrigins.noMessageFor`, { origin: state.label }) : undefined;
};
