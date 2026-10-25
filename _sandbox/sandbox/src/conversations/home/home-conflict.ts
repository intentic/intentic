import { agentBlockers, blockersOf, landConflictPrompt } from "@intentic/sandbox-contract/events/land-conflict";
import type { LandConflict } from "@intentic/sandbox-contract/schemas/agents";
import type { Services } from "../../composition.js";
import { deliverWake } from "../../seams/wake-delivery.js";
import { conversationProfile } from "../registry/agents-store.js";

// A home conversation's land that clashed with the main tree goes back to the home to resolve, as the app's Resolve
// press sends any other conversation's: its person only chats with it, and is never the one asked to rebase. Said as the
// sandbox, through the door every wake takes; the land runs after the turn's steering is hushed (turn-close.ts), so
// it opens the home's next turn on the same session, and that turn's own land re-lands the work.
//
// Never for a clash only the person's own uncommitted edits make, which no rebase reaches: the home's card stays in
// conflict and its next turn reads it. Nor for the resolve turn's own land (the caller's `resolving`): a resolve that
// clashed again is not asked once more, the next turn the person starts lands the branch again.

const SOURCE = "home-land";

export const resolveHomeConflict = async (
    services: Pick<Services, "agents" | "turns" | "logger">,
    conversationId: string,
    conflicts: readonly LandConflict[] | undefined,
): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    if (entry?.identity.home !== true || agentBlockers(blockersOf(conflicts)).length === 0) {
        return;
    }
    try {
        const receipt = await deliverWake(
            { turns: services.turns },
            {
                conversationId,
                prompt: landConflictPrompt(conflicts),
                voice: "sandbox",
                errand: "land-conflict",
                source: SOURCE,
                profile: conversationProfile(entry),
            },
        );
        if (!("delivered" in receipt)) {
            services.logger.warn({ conversationId, receipt }, "home land: the conflict could not be handed back, the home took nothing");
        }
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "home land: the conflict could not be handed back");
    }
};
