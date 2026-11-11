import { z } from "zod";
import { KeyringOriginSchema } from "./keyring.js";

// THE SANDBOX'S SIDE OF PASSWORDS (2026-10-19): an agent asking for a credential by where it is to be used (`secrets
// want`, `type_secret` aimed at a page or a window), and the wants still waiting, which the Secrets view lists. Passwords
// itself, the vault and its management, is on the owner's computers alone (2026-11-11): a sandbox deals in secrets, and
// what it learns of an entry is the pointer its keyring shared here, which the secret inventory lists like any other.

/** `secrets want`: a credential by the place it is for, asked of the owner's keyrings. */
export const SecretWantSchema = z
    .object({
        origin: KeyringOriginSchema.describe("Where it is to be used: a site, a program on the owner's computer, an ssh target, a git host."),
        username: z.string().max(256).optional().describe("The account wanted, when the agent knows it."),
        why: z.string().min(1).max(300).describe("What it is for, in words for the person's prompt."),
        // Filled by the CLI itself, from the running turn, so the prompt names the conversation that asked.
        conversationId: z.string().max(200).optional(),
    })
    .strict();
export type SecretWant = z.infer<typeof SecretWantSchema>;

export const SecretWantResultSchema = z.discriminatedUnion("state", [
    z.object({
        state: z.literal("allowed"),
        name: z.string().describe("The name a secret reference uses from now on."),
        machine: z.string().describe("The computer whose keyring shares it."),
        message: z.string(),
    }),
    z.object({ state: z.literal("pending"), id: z.string(), machine: z.string(), message: z.string().describe("Where the owner's answer is awaited.") }),
    z.object({ state: z.literal("denied"), message: z.string() }),
    z.object({ state: z.literal("unknown"), message: z.string().describe("No keyring had it and nobody typed it once, or none could be asked.") }),
]);
export type SecretWantResult = z.infer<typeof SecretWantResultSchema>;

/** One need this sandbox raised, as its record keeps it and the Secrets view lists it while it waits. */
export const SandboxNeedSchema = z.object({
    id: z.string(),
    origin: KeyringOriginSchema,
    username: z.string().optional(),
    detail: z.string(),
    conversation: z.string().optional(),
    machine: z.string().optional().describe("The computer it was answered on, or waits on."),
    state: z.enum(["pending", "allowed", "denied", "unknown"]),
    name: z.string().optional().describe("The entry it was answered with, once allowed."),
    at: z.number().int(),
});
export type SandboxNeed = z.infer<typeof SandboxNeedSchema>;
export const SandboxNeedsSchema = z.object({ needs: z.array(SandboxNeedSchema) });
