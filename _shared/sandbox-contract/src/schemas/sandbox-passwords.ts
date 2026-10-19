import { z } from "zod";
import { KeyringOriginSchema, KeyringRememberSchema, KeyringShareModeSchema } from "./keyring.js";

// THE SANDBOX'S SIDE OF PASSWORDS (2026-10-19): an agent asking for a credential by where it is to be used (`secrets
// want`, `type_secret` aimed at a page or a window), and the hosted Passwords view's three reads. The vault and its
// management stay on the owner's computers; what a sandbox learns of an entry is the pointer its keyring shared here.

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

/** One need this sandbox raised, as its record and the hosted view's Requests keep it. */
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

/** One of the owner's computers as the hosted Passwords view shows its keyring. */
export const SandboxPasswordsKeyringSchema = z.object({
    machine: z.string(),
    online: z.boolean(),
    setUp: z.boolean().describe("Answering, set up, and trusted by this sandbox: it can be asked."),
    locked: z.boolean().optional(),
    remember: KeyringRememberSchema.optional(),
});
export type SandboxPasswordsKeyring = z.infer<typeof SandboxPasswordsKeyringSchema>;

/** One password this sandbox may use: a pointer one of the owner's keyrings shares here. Never a value. */
export const SandboxPasswordSchema = z.object({
    name: z.string(),
    title: z.string(),
    kind: z.enum(["password", "text"]),
    origins: z.array(KeyringOriginSchema).describe("Where it works, from the entry's rules."),
    anyField: z.boolean(),
    machine: z.string().describe("The computer whose keyring keeps it."),
    mode: KeyringShareModeSchema.describe("How this sandbox may use it."),
    online: z.boolean(),
    updatedAt: z.number(),
    lastUsedAt: z.number().optional().describe("This sandbox's last use of it, from its own use ledger."),
});
export type SandboxPassword = z.infer<typeof SandboxPasswordSchema>;

export const SandboxPasswordsSchema = z.object({
    sandbox: z.string().describe("This sandbox's own address, as the keyrings name it."),
    items: z.array(SandboxPasswordSchema),
    keyrings: z.array(SandboxPasswordsKeyringSchema),
});
export type SandboxPasswords = z.infer<typeof SandboxPasswordsSchema>;

/** One use of a keyring-held password by this sandbox, from its use ledger. */
export const SandboxPasswordUseSchema = z.object({
    at: z.number(),
    name: z.string(),
    lane: z.string(),
    detail: z.string().optional(),
    approvedBy: z.string().optional(),
});
export const SandboxPasswordsActivitySchema = z.object({ lines: z.array(SandboxPasswordUseSchema) });
