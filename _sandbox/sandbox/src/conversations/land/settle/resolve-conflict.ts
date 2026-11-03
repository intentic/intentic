import { agentBlockers, blockersOf, landConflictPrompt } from "@intentic/sandbox-contract/events/land-conflict";
import type { LandConflict } from "@intentic/sandbox-contract/schemas/agents";
import type { Services } from "../../../composition.js";
import { deliverWake } from "../../../seams/wake-delivery.js";
import { conversationProfile } from "../../registry/agents-store.js";

// A land that clashed with the main tree goes back to its conversation to resolve, at once, where nobody would press
// Resolve for it: a home conversation, whose person only chats with it, and any conversation whose finished work lands
// by itself ("Land finished work automatically", ../turn-landing.ts decides which). Said as the sandbox, through the door
// every wake takes; the land runs after the turn's steering is hushed (turn-close.ts), so it opens the next turn on the
// same session, its cache and context still warm, and that turn's own land re-lands the work.
// (2026-11) Only a home was sent back. Every other auto-landing conversation's clash waited on its card for a Resolve
// press, up to ten hours later on one sandbox, by which time the agent had to re-read everything it had just written.
//
// Never for a clash only the person's own uncommitted edits make, which no rebase reaches: the card stays in conflict
// and its next turn reads it. Nor for the resolve turn's own land (the caller checks): a resolve that clashed again is
// not asked once more, the next land is pressed or the next turn lands the branch again.

export const resolveConflictNow = async (
    services: Pick<Services, "agents" | "turns" | "logger">,
    conversationId: string,
    conflicts: readonly LandConflict[] | undefined,
): Promise<void> => {
    const entry = services.agents.entry(conversationId);
    if (entry === undefined || agentBlockers(blockersOf(conflicts)).length === 0) {
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
                source: entry.identity.home === true ? "home-land" : "auto-land",
                profile: conversationProfile(entry),
            },
        );
        if (!("delivered" in receipt)) {
            services.logger.warn({ conversationId, receipt }, "land: the conflict could not be handed back, the conversation took nothing");
        }
    } catch (error) {
        services.logger.warn({ err: error, conversationId }, "land: the conflict could not be handed back");
    }
};
