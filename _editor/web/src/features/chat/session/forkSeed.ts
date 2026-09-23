import type { Conversation } from "./conversation";

// A fork of `source` cut before `index`, seeded into a fresh conversation: the turns above the cut and the source's
// picks ride across, no session does. `files`: "now" keeps the current workspace; "then" checks out the cut's files.
export const seedFork = (fork: Conversation, source: Conversation, index: number, files: "then" | "now"): void => {
    fork.pendingForkOf.value = { conversationId: source.conversationId, keep: fork.transcript.cutFrom(source.transcript, index), files };
    fork.selection.apply({ kind: `adopt`, from: source.selection.state.value });
    // "Files as they were" is only sayable in the fork's own checkout, so that choice carries isolation with it.
    fork.isolated.value = files === `then` ? true : source.isolated.value;
    // Left null so a send names the fork after its own first message; two tabs sharing a title is hard to find.
    fork.title.value = null;
};
