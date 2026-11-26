// A brief for an agent run, in four parts in this order:
// subject — what is being worked on.
// why — the measurement's numbers, quoted exactly, then what they mean.
// goal — a direction to move in, not a prescribed design.
// done — falsifiable; checkable in the agent's own worktree.
// Invariants sit between goal and done: constraints on how, restated in full each time.
//
// Shared by every brief the editor and the daemon write for an agent (an extension update's read, a capability audit, a
// device-sync conflict). The maintenance extension's chore prompts were its first users and keep a copy of their own;
// this lived in the contract's `chores` subpath until 2026-11-26, which re-exports it for the extensions built against
// it until extension API 3.0.0.

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
