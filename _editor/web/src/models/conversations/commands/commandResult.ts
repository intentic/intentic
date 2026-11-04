import { type Ref, ref } from "vue";
import type { Conversation } from "../session/conversation";
import type { SlashRow } from "./slashCommands";

// WHAT A `/` COMMAND THE COMPOSER ANSWERED SAYS BACK, held per conversation and drawn over its composer
// (ChatCommandResult), the way Claude Code prints a local command's answer under the prompt without sending anything.
// Never part of the transcript: it is this window's answer to this reader, gone on dismissal, on the next send, or with
// the window. The readouts (usage, context, status, the checklist, the effort levels) are read live by the card, so an
// answer left open keeps saying what is true; only `help` keeps the list it was asked against.

export type CommandResult = { readonly typed: string } & (
    | { readonly kind: `help`; readonly rows: readonly SlashRow[] }
    | { readonly kind: `usage` | `context` | `status` | `todos` | `effort` }
    // A sentence: what a command did ("Renamed"), or why it did nothing ("Nothing is running").
    | { readonly kind: `note`; readonly text: string; readonly tone?: `warning` }
);

const results = new WeakMap<Conversation, Ref<CommandResult | undefined>>();

/** This conversation's last answer, created on first ask; a conversation nobody asked anything holds none. */
export const commandResultOf = (conversation: Conversation): Ref<CommandResult | undefined> => {
    const held = results.get(conversation);
    if (held !== undefined) {
        return held;
    }
    const fresh = ref<CommandResult>();
    results.set(conversation, fresh);
    return fresh;
};
