import type { TurnNote } from "@intentic/sandbox-contract";

// Tells a model which repos it can and can't see: an absent directory looks identical to one that never existed, so a
// model left to guess concludes the code is gone. Follows workspace-map.ts's rule: what's excluded is stated
// explicitly, since a list that stops silently reads as complete. Rides the user message on the opening turn and after
// a compaction, not the stable system prefix, since those are the only moments history can't carry it.

export const CONTEXT_NOTE_HEADER = "## Context of this session";
export const CONTEXT_NOTE_TITLE = "Context of this session";

export interface ContextNoteInput {
    // Label (or id) of the persona card the composition read from; absent if set without one.
    readonly persona: string | undefined;
    // Repository ids the conversation carries, in composition order. Root is implied and not listed.
    readonly carried: readonly string[];
    // Live repository ids the conversation does not carry.
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
