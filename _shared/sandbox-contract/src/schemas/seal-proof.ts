// The owner's signed yes to opening a private conversation without asking (seal.ts SealOpenDocumentSchema). Apart from
// seal.ts because the passkey shapes live in system.ts, whose event frames import the conversation summary, which imports
// seal.ts: keeping this here is what keeps that a line rather than a circle.
import { z } from "zod";
import { SealIdSchema } from "./seal.js";
import { AuthenticationResponseSchema } from "./system.js";

export const SealOpenProofSchema = SealIdSchema.extend({
    document: z.string().min(1).max(4096).describe("The document text, byte for byte what the challenge hashed."),
    assertion: AuthenticationResponseSchema,
});
export type SealOpenProof = z.infer<typeof SealOpenProofSchema>;
