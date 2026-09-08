import type { Services } from "../../composition.js";
import { isIsolated, type PersistedAgent } from "../../agents/registry/agents-store.js";
import { anchorWorktree } from "./anchor-worktree.js";
import type { TurnAnchor } from "./turn-anchors.js";

// A steered message's before-state anchor is reserved as an empty box the instant the turn accepts it; it fills in once
// the capture resolves. Queue of boxes, not resolved anchors: two captures finishing out of order can't file one
// message's state under another's index, since position is fixed at reserve time.

interface Slot {
    anchor: TurnAnchor | undefined;
}

// conversationId → the boxes for this turn's steers, in the order the turn accepted them.
const reserved = new Map<string, Slot[]>();

// Bounds runaway steering per conversation; a settling turn empties the queue, this guards one that never does.
const MAX_PENDING = 200;

// Captures the workspace as the steered message finds it, in whichever form (tree/worktree) this conversation's
// placement uses. Never throws: a capture fault costs the message its bookmark, not the steer itself.
const stateNow = async (
    services: Pick<Services, "agentWorktrees" | "history" | "logger">,
    conversationId: string,
    entry: PersistedAgent,
): Promise<TurnAnchor | undefined> => {
    try {
        if (isIsolated(entry)) {
            // Titled for what it is (mid-answer, not a turn boundary), so the log isn't a run of identical commit
            // titles.
            const anchored = await anchorWorktree(services, conversationId, entry.repos ?? [], "Agent: before this steered message");
            return anchored.length > 0 ? { kind: "worktree", repos: anchored } : undefined;
        }
        // Undefined `snapshot` means nothing changed since the last capture; the newest checkpoint is then this
        // moment's state.
        const id = (await services.history.snapshot("turn")) ?? (await services.history.list())[0]?.id;
        return id === undefined ? undefined : { kind: "tree", snapshot: id };
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "anchors: pinning a steered message failed");
        return undefined;
    }
};

// Reserves its box synchronously, before the first await, so the Nth box pairs with the Nth steered row. A remote
// conversation takes none: its local mirror is stale, and a wrong state is worse than none.
export const anchorSteeredMessage = async (
    services: Pick<Services, "agents" | "agentWorktrees" | "history" | "logger">,
    conversationId: string,
): Promise<void> => {
    const slots = reserved.get(conversationId) ?? [];
    if (slots.length >= MAX_PENDING) {
        return;
    }
    // The box is always taken, even if the anchor stays empty; skipping one would shift every later message's index.
    // Only the MAX_PENDING cap may skip safely, since it only ever bites at the tail.
    const slot: Slot = { anchor: undefined };
    slots.push(slot);
    reserved.set(conversationId, slots);
    const entry = services.agents.entry(conversationId);
    // Nothing to anchor against, or the conversation's state is on another machine.
    if (entry === undefined || entry.runner !== undefined) {
        return;
    }
    slot.anchor = await stateNow(services, conversationId, entry);
};

// Empties the conversation's queue in order, for the settle pass that knows each box's row. Always drains, so a turn
// that recorded nothing doesn't leave boxes for the next turn to misread.
export const takeSteerAnchors = (conversationId: string): readonly (TurnAnchor | undefined)[] => {
    const slots = reserved.get(conversationId);
    reserved.delete(conversationId);
    return (slots ?? []).map((slot) => slot.anchor);
};
