import { titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import type { PasswordWake } from "../secrets/device/keyring-needs.js";
import { deliverWake } from "../seams/wake-delivery.js";

// When a Passwords request on an owner's computer turns allowed, the conversation that asked hears it the way a need
// wake does (2026-10-20): steer if its turn is live, else a turn of its own or queued behind what runs.
export const passwordWakeOf =
    (whole: () => Services, logger: Pick<Logger, "warn">): ((wake: PasswordWake) => Promise<void>) =>
    async ({ conversationId, need, name }) => {
        const services = whole();
        const entry = services.agents.entry(conversationId);
        if (entry === undefined) {
            return;
        }
        const place = titleForOrigin(need.origin);
        const prompt = [
            "Need met: a person gave you what you asked for.",
            `Need: Password for ${place}`,
            `Need id: ${need.id}`,
            need.detail,
            `Allowed on ${need.machine ?? "the owner's computer"}: use the secret named ${name}. Write {{secret:${name}}} wherever it goes.`,
            "Continue the task that needed it.",
        ].join("\n");
        const receipt = await deliverWake(
            { turns: services.turns },
            { conversationId, prompt, voice: "sandbox", source: "passwords", profile: conversationProfile(entry) },
        );
        if (!("delivered" in receipt)) {
            logger.warn({ conversationId, receipt }, "passwords: the conversation took nothing");
        }
    };
