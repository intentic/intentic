import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { MAIN_MOVED_SOURCE } from "@intentic/sandbox-contract/events/agent-ui";

/* KEEPING A RUNNING TURN ON THE MAIN LINE, so another conversation's land costs it no separate conflict turn. */

// A turn is rebased onto the main line as it opens and once more before its land. Between the two, it works on the main
// line as it was. Whatever lands meanwhile meets this turn's work at its own land, and every clash there used to become a
// separate Resolve turn: a cold cache, the agent re-reading what it already had. Two moments close most of that:
// - mid-turn, after a tool call, a main line that moved is taken in at once, but only where nothing it moved is a file
//   this turn changed (sync.ts `clear`). That rebase cannot conflict. It is not announced to the model: an earlier note
//   about a routine rebase sent it re-verifying builds unprompted (turn-preamble.ts). Claude Code says what it needs by
//   itself: a file the model read and the rebase changed comes back as a short "changed on disk since you last read it"
//   with the diff, and its Edit refuses a file changed since it was read.
// - at the first Stop, the land's own pre-sync runs early. Where it cannot rebase, the land would refuse, so the model is
//   asked to resolve it now, in the turn that still holds the context, once. Asked a second time it could become a gate.
// A turn that changed a file the main line also moved simply carries on. That clash, if it is one, is the Stop's to find.

// One repo whose branch would not rebase onto the main line: the sha it was tried onto and the paths both sides changed.
export interface StopConflict {
    readonly repo: string;
    readonly onto: string;
    readonly overlap: readonly string[];
}

/** What a placement offers a running turn (worktree-placement.ts); absent for a turn in the shared tree. */
export interface MainCatchUp {
    // Takes in a main line that moved since the turn last looked, where that is clear. `quiet` is asked only once the
    // main line moved, so the ordinary call costs a few file reads. Answers the worktree frame if the branch moved.
    readonly midTurn: (quiet: () => Promise<boolean>) => Promise<AgentEvent | undefined>;
    // The land's pre-sync, run as the turn is about to stop: the repos that would not rebase, none if every one did.
    readonly atStop: () => Promise<readonly StopConflict[]>;
}

// Enough of the clash to start on; git names the rest as the rebase stops on each.
const NAMED_PATHS = 20;

const short = (sha: string): string => sha.slice(0, 12);

const repoLines = ({ repo, onto, overlap }: StopConflict): string[] => {
    const named = overlap.slice(0, NAMED_PATHS).map((path) => `  - ${path}`);
    const rest = overlap.length - named.length;
    return [
        `${repo}: \`git rebase ${short(onto)}\``,
        ...(named.length === 0 ? ["  (git names the conflicting files as the rebase stops on them)"] : named),
        ...(rest > 0 ? [`  - … +${rest} more`] : []),
    ];
};

/** What the model is told at the Stop: that its branch no longer rebases, what to run, and the files both sides changed.
 *  Kept to the clash: nothing in it invites re-checking work the main line did not touch. */
export const mainMovedNote = (conflicts: readonly StopConflict[]): string =>
    [
        "Before you stop: the main line moved while you worked, and your branch no longer rebases onto it cleanly, so this work would not land as it stands. Resolve it now, in this turn. In each repo below (`root` is your working directory, any other name that subdirectory of it):",
        [
            "1. `git add -A && git commit -m wip`: a rebase refuses to start on a dirty tree.",
            "2. Rebase onto the commit named for that repo, the main line as it stands now. If the rebase gets away from you: `git rebase --abort`, then `git merge` that commit instead.",
            "3. Resolve each conflict keeping the intent of BOTH sides: your change and what moved underneath it.",
        ].join("\n"),
        conflicts.flatMap(repoLines).join("\n"),
        "Then re-run the tests of the files you resolved, and only those; nothing else needs re-checking. Stay inside your own worktree. Your work lands by itself when the turn ends.",
    ].join("\n\n");

/** The transcript's row where that was said: one line for the reader, the note itself behind it. */
const mainMovedNotice = (conflicts: readonly StopConflict[], sent: string): AgentEvent => {
    const files = conflicts.reduce((total, conflict) => total + conflict.overlap.length, 0);
    const where = conflicts.map((conflict) => conflict.repo).join(", ");
    return {
        kind: "agent_notice",
        level: "info",
        source: MAIN_MOVED_SOURCE,
        text: `The main line moved under this turn and its branch no longer rebases (${where}${files > 0 ? `, ${files} file${files === 1 ? "" : "s"} changed on both sides` : ""}). The agent was asked to resolve it before stopping.`,
        sent,
    };
};

// What this module adds to the loop's hook set (claude-code-runner.ts mergeHooks): one PostToolUse matcher, or nothing.
export interface CatchUpHooks {
    readonly PostToolUse?: HookCallbackMatcher[];
}

/** The mid-turn catch-up as a PostToolUse matcher: after each of the main thread's tool calls, before the model reads
 *  the result, so the rebase is done before the model's next step and Claude Code's changed-on-disk note can see it.
 *  A subagent's calls are left alone (its context is its own), and one catch-up runs at a time. */
export const catchUpHooks = (
    catchUp: MainCatchUp | undefined,
    quiet: () => Promise<boolean>,
    push: (event: AgentEvent) => void,
): CatchUpHooks => {
    if (catchUp === undefined) {
        return {};
    }
    let running = false;
    return {
        PostToolUse: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse" || input.agent_id !== undefined || running) {
                            return {};
                        }
                        running = true;
                        try {
                            const frame = await catchUp.midTurn(quiet);
                            if (frame !== undefined) {
                                push(frame);
                            }
                        } catch {
                            // allow(silent-catch): optional; the placement logs its own faults, and a missed catch-up is
                            // only the land's rebase doing this later, as it always did.
                        } finally {
                            running = false;
                        }
                        return {};
                    },
                ],
            },
        ],
    };
};

/** The Stop's first step (turn-checks.ts runs it before the repositories' checks): the reason to keep the turn going
 *  once, or undefined to let it end. Asked once per turn, whatever it found. */
export const stopCatchUp = (catchUp: MainCatchUp | undefined, push: (event: AgentEvent) => void): (() => Promise<string | undefined>) | undefined => {
    if (catchUp === undefined) {
        return undefined;
    }
    let asked = false;
    return async () => {
        if (asked) {
            return undefined;
        }
        asked = true;
        const conflicts = await catchUp.atStop().catch((): readonly StopConflict[] => []);
        if (conflicts.length === 0) {
            return undefined;
        }
        const note = mainMovedNote(conflicts);
        push(mainMovedNotice(conflicts, note));
        return note;
    };
};
