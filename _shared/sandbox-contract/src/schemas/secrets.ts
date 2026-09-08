// secrets: user-supplied env-var secrets the daemon writes to desired-state/.env
import { z } from "zod";
// Straight to the sandbox daemon, never through the platform; `apply` reloads .env with no restart. `list` returns keys
// only; `reveal` is the one owner-only exception that returns a value.
export const SecretSetSchema = z.object({
    key: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128)
        .describe("The name to store it under, which is the name a process will find it by."),
    value: z.string().min(1).describe("The value. It goes straight to your sandbox and never through the platform."),
});
export const SecretKeysSchema = z.object({
    keys: z.array(z.string()).describe("The names that exist here. Only the names: the values never leave the sandbox."),
});
export const SecretKeyParamSchema = z.object({ key: z.string().describe("Which secret, by name.") });
export const SecretRevealSchema = z.object({ value: z.string().describe("The value itself. The only place in this API one is ever returned.") });

// A wall against the agent's own judgment, not a compromised container: a shell here can read the policy same as the
// vault. Approvers are an exact list, never a role floor; the owner isn't on it unless added.
export const CredentialGateScopeSchema = z
    .enum(["use", "conversation"])
    .describe(
        "How far one release goes: `use` asks again every single time (one click releases exactly one use), `conversation` covers the rest of this conversation and is forgotten when the daemon restarts.",
    );
export type CredentialGateScope = z.infer<typeof CredentialGateScopeSchema>;

// Withheld differently: a secret is refused at the exit it would resolve at, a capability is simply never mounted for
// the turn.
export const CredentialGateKindSchema = z
    .enum(["secret", "capability"])
    .describe("Whether this gate covers one stored secret, by the name a reference carries, or one whole connected capability, by its id.");
export type CredentialGateKind = z.infer<typeof CredentialGateKindSchema>;

export const CredentialLaneSchema = z
    .enum(["shell", "code", "browser", "session", "otp"])
    .describe("What the credential was about to be used for: a shell command, a script, typing into a page, mounting a connected account, or one one-time code.");
export type CredentialLane = z.infer<typeof CredentialLaneSchema>;

export const CredentialGateSchema = z.object({
    // Never a vault field (`reddit/password`): gating part of a capability and not the rest would be a gate with a hole
    // in it.
    subject: z.string().min(1).describe("What is gated: a secret's name, or a connected capability's id."),
    kind: CredentialGateKindSchema,
    approvers: z
        .array(z.string().min(3))
        .min(1)
        .describe(
            "Exactly who may release it, by email, from the people on the Access roster. Not a seniority floor: nobody outside this list can release it, the owner included, unless the owner is on it.",
        ),
    scope: CredentialGateScopeSchema,
});
export type CredentialGate = z.infer<typeof CredentialGateSchema>;

export const CredentialGatesSchema = z.object({
    gates: z
        .array(CredentialGateSchema)
        .describe("Every gate in force. Names, subjects and approver addresses only: this answer never carries a credential."),
});
export type CredentialGates = z.infer<typeof CredentialGatesSchema>;

export const CredentialGateSubjectParamSchema = z.object({
    subject: z.string().min(1).describe("Which gate, by the secret name or capability id it covers."),
});

// A gated capability is absent from a turn, not refused inside it, so the model can't discover the gate by tripping
// over it. A release here covers the rest of the conversation, since a session credential can't be single-use.
export const CredentialRequestSchema = z.object({
    subject: z.string().min(1).describe("What to ask for: the secret's name, or the connected capability's id."),
    why: z.string().max(280).optional().describe("One line on what it is for. The only words on the card that are the agent's."),
    // Filled by the CLI itself, so the model cannot aim a card at somebody else's conversation.
    conversationId: z.string().optional().describe("Which conversation to raise the card in. The CLI fills this from the running turn."),
});

export const CredentialGrantSchema = z.object({
    granted: z.literal(true).describe("Always true: a refusal is an error with a sentence, never a `false` here."),
    approvedBy: z.string().describe("Who released it."),
    message: z.string().describe("What the grant means in practice, and what to do next."),
});

// Across every store: env/generated secrets, capability credentials, AI-provider accounts. Values never ride this
// shape; `revealable` says whether `reveal` can return one (everything but provider accounts).
export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider; capability instance id otherwise.
    key: z.string().describe("What identifies it. Unique across the whole inventory, so several accounts of one provider each get their own entry."),
    kind: z
        .enum(["env", "generated", "capability", "provider"])
        .describe("Where it came from: you set it, the sandbox generated it, a connection needs it, or it is a model account's credential."),
    // e.g. "<ProviderName> · <accountLabel>" for provider entries; absent on env/generated.
    label: z.string().optional().describe("A friendlier name, for entries that have one."),
    status: z.enum(["missing", "set", "connected"]).describe("Whether it exists and, for a connection, whether it is working."),
    // Resources referencing it via `{$secret}` refs.
    requiredBy: z
        .array(z.object({ resourceId: z.string().describe("Which resource."), type: z.string().describe("What kind of resource it is.") }))
        .describe("What is waiting on it. Empty for a connection's or an account's own credential."),
    // e.g. "desired-state/.env".
    storedAt: z.string().describe("Where it actually lives, in words."),
    revealable: z.boolean().describe("Whether its value can be shown at all. Everything except a model account's credential can be."),
    // Forgejo Actions only, and only after adopt, on env|generated entries.
    ci: z
        .object({
            synced: z.boolean().describe("Whether the pipeline has it."),
            pushedAt: z.string().optional().describe("When it was last sent there."),
        })
        .optional()
        .describe("Whether a copy has been given to the build pipeline."),
    // Records only the lane and a destination (command/script head, or page host) — never values.
    lastUse: z
        .object({
            at: z.number().describe("When, in milliseconds."),
            lane: z.enum(["shell", "code", "browser"]).describe("How it was used: a command, a script, or typed into a page."),
            detail: z
                .string()
                .optional()
                .describe("Where it went: the start of the command or script, or the site. Names and destinations only, never values."),
            approvedBy: z.string().optional().describe("Who released it for that use, when it is gated. Absent when nothing had to be approved."),
        })
        .optional()
        .describe("The last time an agent actually spent this secret. Absent while it never has been, which most never are."),
    // Joined from the gate policy, so the row can name the approver without a second call.
    gate: z
        .object({
            approvers: z.array(z.string()).describe("Who may release it, by email. Nobody else can, whatever their role."),
            scope: CredentialGateScopeSchema,
        })
        .optional()
        .describe("Who has to release this before the agent can use it, and for how long one release lasts. Absent when it is not gated."),
});
export type SecretInventoryEntry = z.infer<typeof SecretInventoryEntrySchema>;
export const SecretInventorySchema = z.object({
    entries: z
        .array(SecretInventoryEntrySchema)
        .describe("One entry per secret this sandbox knows about, from every place they live. No values, ever."),
});
