// Every generated prompt has four parts, in this order:
// subject — what is being worked on.
// why — the measurement's numbers, quoted exactly, then what they mean.
// goal — a direction to move in, not a prescribed design.
// done — falsifiable; checkable via `iq` in the agent's own worktree.
// Invariants sit between goal and done: constraints on how, restated in full each time.

export interface Ask {
    readonly subject: string;
    readonly why: string;
    readonly diagnosis: string;
    readonly goal: string;
    readonly invariants: string;
    readonly done: string;
}

export const composeAsk = ({ subject, why, diagnosis, goal, invariants, done }: Ask): string =>
    [subject, `Why: ${why} ${diagnosis}`, goal, `${invariants} ${done}`].join(`\n\n`);

// Findings are claims to verify, not tasks to execute; acting on all of them is worse than acting on none.
export const TRIAGE_NOTE =
    `The measurement woke you; it did not decide anything. Read the repository before you touch it, and treat every ` +
    `finding as a claim to verify rather than a task to execute. If a finding is wrong, say why in one line and leave ` +
    `it. A run that verifies ten and fixes two is a good run.`;

// Constraints for a change-making turn: every change must be explainable on its own line of the summary.
export const CHORE_INVARIANTS =
    `Keep it mechanical and separately explainable: nothing lands that you could not justify on its own line of the ` +
    `summary. Do not reformat, rename or "while I was in here" anything the finding did not name. Run the repository's ` +
    `own type-check and tests before you finish, and if you cannot make them pass, leave the change out and say so.`;

// Constraints for a look-only turn, stated explicitly so a report chore never quietly starts editing.
export const REPORT_INVARIANTS =
    `Change nothing. This is a survey: the output is your findings, cited file:line, and a recommendation the owner ` +
    `can act on or dismiss. Where you would propose an edit, describe it and where it would go instead of making it.`;

// Constraints for a one-file refactor turn; scope covers whatever it splits into, not just this one file.
export const REFACTOR_INVARIANTS =
    `Read it first. Behaviour stays identical. Changes affect only this file, whatever it splits into, and the ` +
    `importers that must follow. Leave no re-export shims behind.`;
