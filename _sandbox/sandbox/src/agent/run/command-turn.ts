import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { splitTurnPreamble } from "../../sessions/vocabulary/prompt-envelope.js";
import type { TurnSpec } from "../providers/agent-request.js";

// A turn whose words open with a published slash command (TurnSpec.command). The CLI parses a command only at the very
// start of the message, and the daemon's notes go in front of the words, so every such message used to reach the model
// as prose: `/compact` never compacted, and `/code-review` ran only if the model chose to call the skill itself. Such a
// turn sends its words alone. Its notes reach the model as the UserPromptSubmit hook's context, which the CLI attaches
// to a command it expands (a skill, a prompt command, its forked review agent included) and skips for one it answers
// itself (`/compact`, `/cost`), where no model reads them.

export interface CommandWire {
    // What the CLI is sent: the words alone on a command turn, the composed prompt on every other.
    readonly prompt: string;
    // The notes the words were cut from, for the hook to say; absent when nothing was cut.
    readonly notes?: string;
}

export const commandWire = (spec: Pick<TurnSpec, "prompt" | "command">): CommandWire => {
    if (spec.command === undefined) {
        return { prompt: spec.prompt };
    }
    const { notes, words } = splitTurnPreamble(spec.prompt);
    return notes === "" ? { prompt: spec.prompt } : { prompt: words, notes };
};

// The hook fires for every prompt the session takes, steered ones included; the notes belong to the first only.
export const commandNotesHooks = (notes: string | undefined) => {
    if (notes === undefined) {
        return {} satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    }
    let told = false;
    return {
        UserPromptSubmit: [
            {
                hooks: [
                    async () => {
                        if (told) {
                            return {};
                        }
                        told = true;
                        return { hookSpecificOutput: { hookEventName: "UserPromptSubmit" as const, additionalContext: notes } };
                    },
                ],
            },
        ],
    } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
};
