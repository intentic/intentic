import { z } from "zod";

// (2026-11-27) How this sandbox takes contacts, read by the daemon's contacts (s2s/, docs/architecture/messages.md) when an
// agent accepts a contact request. Off by default: an agent never makes or accepts a contact on its own, it raises a card
// for a person.
export const ContactsSettingsSchema = z
    .object({
        agentMayAccept: z
            .boolean()
            .default(false)
            .describe(
                "Let an automation's agent accept a contact request by itself, giving it messages only. Off, every accept waits for a person's press on a card.",
            ),
    })
    .prefault({})
    .describe("How this sandbox takes contacts, the other sandboxes it exchanges messages with.");
