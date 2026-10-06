import type { Logger } from "pino";
import type { Services } from "../../../composition.js";
import { conversationProfile } from "../../../conversations/registry/agents-store.js";
import type { HeldCardWake } from "../../../guard/held-cards.js";
import { deliverWake } from "./wake-delivery.js";

// The sandbox's words to a conversation whose turn held for a device card (guard/held-cards.ts), delivered as every
// other wake is: queued behind the turn that held for it, whose close has already hushed its steering, so it opens the
// next turn on the same session. Reads the finished services per call, since a card settles long after boot.
const SOURCE = "device-card";

export const heldCardWake =
    (whole: () => Pick<Services, "agents" | "turns" | "conversations">, logger: Pick<Logger, "warn">): HeldCardWake =>
    async (conversationId, prompt) => {
        const services = whole();
        const entry = services.agents.entry(conversationId);
        if (entry === undefined) {
            logger.warn({ conversationId }, "device card: the conversation it was held for is gone, so nobody was told");
            return;
        }
        try {
            const receipt = await deliverWake(
                { turns: services.turns, sessionIdOf: (id) => services.conversations.sessionIdOf(id) },
                { conversationId, prompt, voice: "sandbox", source: SOURCE, profile: conversationProfile(entry) },
            );
            if (!("delivered" in receipt)) {
                logger.warn({ conversationId, receipt }, "device card: the conversation took nothing");
            }
        } catch (error) {
            logger.warn({ err: error, conversationId }, "device card: the wake could not be delivered");
        }
    };
