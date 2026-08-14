import type { GitDiffSide, LandedMessage, LandedMessageDraft, LandedMessageStep, RepoChanges } from "@intentic-app/api-contract";

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
 * `landedMessageDraft` is what tells those apart). The chip then files nothing and simply filters. */
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

// A draft with no outcome yet is one being written right now — the state every wait-related surface keys on.
export const draftRunning = (draft: LandedMessageDraft | undefined): boolean => draft !== undefined && draft.outcome === undefined;

// Seconds, said like a person: under a minute plain, above it minutes+seconds — a refusal that burned 58s and
// one that burned 8 must not read alike.
const seconds = (ms: number): string => {
    const total = Math.round(ms / 1000);
    return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
};

/* ONE STEP OF THE DRAFT, ONE LINE — the walk's own record said in the user's terms, model named, time and
 * reason attached. The four statuses are the four things that can happen to a model in the chain, and each
 * earns different words:
 *   asking   — in flight, with a ticking elapsed read against `now` so the wait is visibly moving;
 *   answered — done, with what it cost;
 *   refused  — done, with what it cost AND its own words, because "refused" alone sends the user hunting;
 *   skipped  — never asked, on the strength of its own refusal minutes ago — the memo working, said as such. */
const draftStepLine = (step: LandedMessageStep, now: number): string => {
    switch (step.status) {
        case `asking`:
            return `Asking ${step.model}… ${step.at === undefined ? `` : seconds(Math.max(0, now - step.at))}`.trimEnd();
        case `answered`:
            return `${step.model} answered${step.ms === undefined ? `` : ` in ${seconds(step.ms)}`}`;
        case `refused`:
            return `${step.model} refused${step.ms === undefined ? `` : ` after ${seconds(step.ms)}`}${step.reason === undefined ? `` : ` — ${step.reason}`}`;
        case `skipped`:
            return `Skipped ${step.model} — refused a moment ago${step.reason === undefined ? `` : `: ${step.reason}`}`;
    }
};

/* THE FULL REPORT, one line per fact, newest last — what "surface everything that is happening" renders to.
 * Empty for no draft at all (nothing has ever been asked; the notice below covers that in one line). A draft
 * with no steps yet is the diff being read, which is a real phase and gets its line. The failure line closes a
 * failed report with the one-line reason when the steps alone don't already say it (a chain spent to the
 * bottom repeats its rungs' reasons — repeating them again would say less, not more). */
export const draftReportLines = (draft: LandedMessageDraft | undefined, now: number): readonly string[] => {
    if (draft === undefined) {
        return [];
    }
    const lines = draft.steps.map((step) => draftStepLine(step, now));
    if (draft.steps.length === 0 && draft.outcome === undefined) {
        return [`Reading the landed diff…`];
    }
    if (draft.outcome === `failed` && draft.reason !== undefined && !draft.steps.some((step) => step.reason === draft.reason)) {
        return [...lines, `No message was written — ${draft.reason}`];
    }
    return lines;
};

// What the commit box knows about the lit chip when it is deciding what to say: who is lit, what that chip has
// to file, and whether the box is free to take it.
export interface ChipMessageState {
    // The lit chip's name, or undefined when no chip is lit — nothing is being asked of the box, nothing to say.
    readonly label: string | undefined;
    // The lit chip is the "you" row, whose files no agent landed and which therefore has no sentence to file.
    readonly yours: boolean;
    // What that chip would file, if anything exists yet.
    readonly message: string | undefined;
    // The full account of that message being drafted, when one exists (the roster's `landedMessageDraft`).
    readonly draft: LandedMessageDraft | undefined;
    // The box holds something the user wrote, so a fill would be declined (commitMessage's `boxIsYours`).
    readonly boxIsYours: boolean;
    // The reader's clock, for the in-flight step's ticking elapsed.
    readonly now: number;
}

/* WHY THE BOX DID NOT JUST FILL ITSELF — said in the box, at the moment of the click that expected it.
 *
 * Every one of these states was already correct and every one of them looked identical: the user clicks a From
 * chip, the list narrows, and the commit box does not change. Nothing was wrong, and nothing said so. The
 * receipts report the drafting's two edges wherever the user is standing (draftingReceipts.ts) — but a receipt
 * is a moment, and the click routinely comes minutes after it, or before the drafting ever started, or over a
 * box the user has since typed in. The question "why didn't it fill?" is asked HERE and has to be answered here.
 *
 * Ordered by what the user can DO about it. A box they own comes first because it is the only refusal that is
 * about them rather than about the sentence — and the only one with a remedy in their hands, which is why it
 * names it. Then the wait, then the absence, both of which are the daemon's news and neither of which is
 * actionable beyond writing the line yourself.
 *
 * Undefined ⇒ nothing to explain: no chip is lit, or the chip's message is already in the box, where it speaks
 * for itself. */
export const chipMessageNotice = (state: ChipMessageState): string | undefined => {
    if (state.label === undefined) {
        return undefined;
    }
    if (state.yours) {
        return `Your own changes — name this commit yourself`;
    }
    const running = draftRunning(state.draft);
    // Said whether the sentence exists yet or is still being written: either way this box is not taking it, and
    // the same clearing lets the one that arrives land.
    if (state.boxIsYours && (state.message !== undefined || running)) {
        return `Keeping your message — clear the box to use ${state.label}'s`;
    }
    /* The wait, as it stands THIS second: the walk's newest step, not a generic "writing…". The report list
     * under the box carries the whole story; this is its last line, in the place the eye is already resting. */
    if (running) {
        const latest = state.draft === undefined ? undefined : draftReportLines(state.draft, state.now).at(-1);
        return `Writing a message for ${state.label} — ${latest ?? `starting…`}`;
    }
    // Nothing was written and nothing is coming: the draft failed (its report below says exactly how), no
    // quick model answered, or the work landed before anything was writing these. The honest answer is that
    // there is nothing to file — and the same words the receipt used when the draft ended empty.
    return state.message === undefined ? `No message was written for ${state.label} — name the commit yourself` : undefined;
};
