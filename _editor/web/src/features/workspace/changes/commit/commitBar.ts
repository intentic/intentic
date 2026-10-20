import { phaseWords, type RunLine } from "./runLine";

// WHAT THE PRESS BAR'S ONE READING LINE SAYS, decided here and nowhere else. The bar under a Changes panel's message
// box has room for one line beside its presses, and every source of news wants it: a stage or commit run, a conflict
// that stops Commit, a commit under way, why a press was refused, a push in flight or just done, why a lit chip left the
// box alone, a branch with no upstream. It was a hand-ordered `v-else-if` chain fed by sources that did not know about
// each other, so a new one (a run's own row) drew beside an old one ("Committing…" twice) or was silenced by a flag
// emitted back up and an empty template. Here each state is one case of one union, picked by one function, most
// pressing first, and the template draws the case it is handed.

export type BarLine =
    /** A run this tab follows: its phase, its count and, once slow, its Stop. */
    | { readonly kind: `run`; readonly line: RunLine }
    /** An unresolved conflict stops every commit. */
    | { readonly kind: `conflicts` }
    /** A commit of this box's repos before its run is read, or one another tab is making: the run's words, so the line
     * does not change when the run is read. */
    | { readonly kind: `committing`; readonly words: string }
    /** Why the last press (Ctrl+Enter included) did nothing. */
    | { readonly kind: `refused`; readonly reason: string }
    /** A push in flight, or just done. */
    | { readonly kind: `push` }
    /** Why the lit chip left the box alone, when the box holds the reader's own text and its placeholder cannot say. */
    | { readonly kind: `chip`; readonly notice: string }
    /** The branch has no upstream to count against. */
    | { readonly kind: `no-upstream` }
    | { readonly kind: `rest` };

export interface BarFacts {
    /** Uncommitted changes listed. */
    readonly changes: number;
    readonly conflicts: boolean;
    readonly run: RunLine | undefined;
    /** This box's repos with a commit going (this tab's press, or the daemon's own word for another's). */
    readonly committing: readonly string[];
    readonly refused: string | undefined;
    /** The push control's state: in flight or just done, a refusal standing, or an offer. */
    readonly outgoing: `flow` | `held` | `offer` | undefined;
    /** The lit chip's answer, when the box holds the reader's own text. */
    readonly chipNotice: string | undefined;
    /** An offer to sync with nothing to count: no upstream yet. */
    readonly noUpstream: boolean;
}

export const barLine = (facts: BarFacts): BarLine => {
    if (facts.run !== undefined) {
        return { kind: `run`, line: facts.run };
    }
    if (facts.changes > 0 && facts.conflicts) {
        return { kind: `conflicts` };
    }
    if (facts.committing.length > 0) {
        return { kind: `committing`, words: phaseWords(facts.committing.join(`, `), undefined) };
    }
    if (facts.refused !== undefined) {
        return { kind: `refused`, reason: facts.refused };
    }
    if (facts.outgoing === `flow`) {
        return { kind: `push` };
    }
    if (facts.changes > 0 && facts.chipNotice !== undefined) {
        return { kind: `chip`, notice: facts.chipNotice };
    }
    return facts.noUpstream ? { kind: `no-upstream` } : { kind: `rest` };
};
