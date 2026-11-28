import { z } from "zod";
import { S2S_NOTE_MAX, S2sAddressSchema, S2sGrantsSchema, S2sRefSchema } from "./s2s-identity.js";

// The `contact` need (schemas/needs.ts, docs/architecture/messages.md): an agent never makes or accepts a contact itself,
// it raises a card a person presses. Its own module, importing only the identity shapes, since needs.ts is imported by
// modules the s2s wire shapes import in turn. Re-exported from schemas/s2s.ts.

export const ContactNeedSchema = z.object({
    kind: z.literal("contact"),
    address: S2sAddressSchema.describe("The sandbox to add, or the one whose request to accept."),
    action: z.enum(["add", "accept"]),
    contactId: S2sRefSchema.optional().describe("The waiting request's contact, for an accept."),
    grants: S2sGrantsSchema.describe("What this sandbox would let it do here."),
    note: z.string().max(S2S_NOTE_MAX).optional().describe("The note the request carries, for an add."),
});
export type ContactNeed = z.infer<typeof ContactNeedSchema>;
// What the agent may send: the address (or the waiting contact) and the grants it proposes; the daemon resolves the rest.
export const ContactNeedAskSchema = z.object({
    kind: z.literal("contact"),
    action: z.enum(["add", "accept"]),
    address: z.string().trim().min(1).max(300).optional().describe("The sandbox to add, as the agent has it."),
    contactId: S2sRefSchema.optional().describe("The waiting request to accept."),
    grants: S2sGrantsSchema.prefault({}).describe("What it proposes the contact may do here; messages only when left out."),
    note: z.string().max(S2S_NOTE_MAX).optional(),
});
export type ContactNeedAsk = z.infer<typeof ContactNeedAskSchema>;
