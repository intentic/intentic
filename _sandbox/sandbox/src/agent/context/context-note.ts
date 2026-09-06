import type { TurnNote } from "@intentic/sandbox-contract";

/* WHAT THIS SESSION CAN SEE, told to a model that would otherwise assume it sees everything.
 *
 * A conversation wearing a persona card that names its context stands in a tree that holds some of the
 * workspace's repositories and not others,
 * and a directory that is not there reads, to a model, exactly like a directory that never existed. Left to
 * itself it concludes the code is gone, or clones it, or asks the user why the repo was deleted. The map that
 * opens a conversation (agent/workspace-map.ts) draws the rule this note follows: what was left out is counted
 * out loud, because a list that stops silently reads as a complete list, and that is the one way a description
 * of the tree is actively misleading.
 *
 * It rides the user message like the map and for the same reason, it is computed per conversation and must not
 * sit in the byte-stable system prefix, on the opening turn and again after a compaction, the two moments
 * nothing in the session's own history can be relied on to carry it. */

export const CONTEXT_NOTE_HEADER = "## Context of this session";
export const CONTEXT_NOTE_TITLE = "Context of this session";

export interface ContextNoteInput {
    // The label (or id) of the persona card the composition was read off, absent when it was set without one.
    readonly persona: string | undefined;
    // Repository ids the conversation carries, in composition order. Root is implied and not listed.
    readonly carried: readonly string[];
    // Live repository ids the conversation does NOT carry.
    readonly absent: readonly string[];
    // Repository ids the composition names that the workspace does not have.
    readonly missing: readonly string[];
}

const list = (ids: readonly string[]): string => ids.map((id) => `\`${id}\``).join(", ");
const repositories = (count: number): string => (count === 1 ? "repository" : "repositories");

export const contextNote = (input: ContextNoteInput): TurnNote => {
    const from = input.persona === undefined ? "" : ` (wearing the \`${input.persona}\` persona)`;
    const carried =
        input.carried.length === 0
            ? "the workspace root and none of its nested repositories"
            : `the workspace root and ${input.carried.length === 1 ? "one nested repository" : `${input.carried.length} nested repositories`}: ${list(input.carried)}`;
    const lines = [`${CONTEXT_NOTE_HEADER}`, "", `This conversation carries a chosen part of the workspace${from}: ${carried}.`];
    if (input.absent.length > 0) {
        lines.push(
            "",
            `Not checked out here: ${input.absent.length} other ${repositories(input.absent.length)}, ${list(input.absent)}. A path under one of ` +
                "those does not exist in this tree and no listing will find it. If the task genuinely needs one, stop and " +
                "say which rather than cloning it or working around it.",
        );
    }
    if (input.missing.length > 0) {
        lines.push("", `Named by the persona but not in this workspace: ${list(input.missing)}.`);
    }
    return { title: CONTEXT_NOTE_TITLE, text: lines.join("\n") };
};
