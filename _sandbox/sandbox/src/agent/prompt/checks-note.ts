import type { TurnNote } from "@intentic/sandbox-contract";

// What a turn is told about checks: nothing holds its work back, a repository's own end-of-turn checks may say back once
// what its change added (agent/run/turn-checks.ts) and nothing else checks it when it finishes or after it lands, the
// checks worth running are the ones scoped to what it changed, and CI checks what the owner pushes, with one fix agent on
// whatever fails on main (ci/main-fixer.ts). Said with "may" to every runtime, since only an isolated turn of the Claude
// Code loop meets those checks. Sent on the opening message and after a compaction, like every standing note
// (turn-premise.ts); it names no failures, so nothing it says goes stale between turns.

export const LANDING_CHECKS_NOTE_TITLE = "Checks after landing";
export const LANDING_CHECKS_NOTE_HEADER = "## Checks after landing";

// The note this one replaced, still parsed out of prompts records hold (turn-preamble.ts), never sent.
export const LEGACY_TURN_ENDING_NOTE_TITLE = "Automatic end-of-turn checks";
export const LEGACY_TURN_ENDING_NOTE_HEADER = "## Automatic end-of-turn checks";

export const LANDING_CHECKS_NOTE: TurnNote = {
    title: LANDING_CHECKS_NOTE_TITLE,
    text: [
        LANDING_CHECKS_NOTE_HEADER,
        "",
        "Nothing holds your work back: you decide when it is done. When you finish in a checkout of your own, a repository you changed may run its own end-of-turn checks once, and what they find in your change is said back to you: fix what is yours, or say why not. Nothing else checks your work when you finish or after it lands. Run the checks that cover what you changed while you work (the tests for it, its package's typecheck), never the whole repository's suite: this machine is shared. Once the owner pushes, CI checks it, and one fix agent takes whatever fails on main.",
        "",
        "A failure in code you did not touch may be main's own rather than yours: say so, and leave it unless your task is about it.",
    ].join("\n"),
};
