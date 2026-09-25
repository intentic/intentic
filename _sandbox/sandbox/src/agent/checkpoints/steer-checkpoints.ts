import type { Services } from "../../composition.js";
import { isIsolated, type PersistedAgent } from "../../conversations/registry/agents-store.js";
import { checkpointWorktree } from "./checkpoint-worktree.js";
import type { TurnCheckpoint } from "./turn-checkpoints.js";

// A steered message's before-state checkpoint is reserved as an empty box the instant the turn accepts it; it fills in
// once the capture resolves. The boxes are the conversation's actor's (`steer-reserved`, `steers-taken`), in the order
// the turn accepted the messages, so a slow capture can't file one message's state under another's index.

// Captures the workspace as the steered message finds it, in whichever form (tree/worktree) this conversation's
// placement uses. Never throws: a capture fault costs the message its bookmark, not the steer itself.
const stateNow = async (
    services: Pick<Services, "agentWorktrees" | "history" | "logger">,
    conversationId: string,
    entry: PersistedAgent,
): Promise<TurnCheckpoint | undefined> => {
    try {
        if (isIsolated(entry)) {
            // Titled for what it is (mid-answer, not a turn boundary), so the log isn't a run of identical commit
            // titles.
            const anchored = await checkpointWorktree(services, conversationId, entry.placement.repos, "Agent: before this steered message");
            return anchored.length > 0 ? { kind: "worktree", repos: anchored } : undefined;
        }
        // Undefined `snapshot` means nothing changed since the last capture; the newest checkpoint is then this
        // moment's state.
        const id = (await services.history.snapshot("turn")) ?? (await services.history.list())[0]?.id;
        return id === undefined ? undefined : { kind: "tree", snapshot: id };
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "checkpoints: pinning a steered message failed");
        return undefined;
    }
};

// Reserves its box synchronously, before the first await, so the Nth box pairs with the Nth steered row. The box is
// always taken, even if it stays empty: skipping one would shift every later message's index. A remote conversation
// fills none: its local mirror is stale, and a wrong state is worse than none.
export const checkpointSteeredMessage = async (
    services: Pick<Services, "agents" | "conversations" | "agentWorktrees" | "history" | "logger">,
    conversationId: string,
): Promise<void> => {
    const slot = services.conversations.send(conversationId, { kind: "steer-reserved" }).reply;
    const entry = services.agents.entry(conversationId);
    // No box past the cap, nothing to checkpoint against, or the conversation's state is on another machine.
    if (slot === undefined || entry === undefined || (entry.placement.kind === "worktree" && entry.placement.runner !== undefined)) {
        return;
    }
    const checkpoint = await stateNow(services, conversationId, entry);
    if (checkpoint !== undefined) {
        services.conversations.send(conversationId, { kind: "steer-captured", slot, checkpoint });
    }
};
