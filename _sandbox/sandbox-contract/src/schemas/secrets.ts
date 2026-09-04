// secrets: user-supplied env-var secrets the daemon writes to desired-state/.env
import { z } from "zod";
// The web posts a Cloudflare token / GitHub PAT / another-host SSH key straight to the sandbox daemon (never
// through the platform); `apply` reloads .env each run so a new secret is picked up with NO restart. `list`
// returns KEYS ONLY, the values never leave the sandbox; `reveal` is the one deliberate, owner-only exception.
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

/* A CREDENTIAL THE AGENT MAY NOT USE UNTIL A NAMED PERSON SAYS SO, and who that person is.
 *
 * Masking already answers "can the model SEE this value" (no: it reads a `{{secret:name}}` reference), and
 * the answer was enough while the only question was disclosure. It is not the whole question. A reference the
 * model can write is a credential the model can SPEND, at whatever moment its own reasoning arrives at, and
 * for the small set of credentials where one wrong spend is the incident — the production database's
 * password, the company X account, the card-shaped connector — the owner wants the moment itself decided by a
 * person, not the storage of the value. That is what a gate is: not a second lock on the vault, a REQUIRED
 * CLICK in front of the exit.
 *
 * WHAT IT IS NOT A WALL AGAINST. A shell in this container runs as the workspace's owner and the policy file
 * sits beside the vault it guards; anything that can read one can read the other, and a compromised container
 * is out of scope here exactly as it is for the vault (SECURITY.md). The gate is a wall against the AGENT's
 * own judgment being the last word — a prompt-injected model can ask for a release and cannot grant itself
 * one — and against the ordinary accident of a turn reaching for the live credential when the staging one was
 * meant.
 *
 * THE APPROVERS ARE AN EXACT LIST, not a role floor, and the owner is not on it implicitly. "Only Bob may
 * release the production password" is the sentence people actually mean, and a floor cannot say it: a floor of
 * `maintainer` says "anyone senior enough", which is the thing the owner was trying to narrow. So the list is
 * the list, the owner adds themselves when they mean themselves, and a click from anybody else is refused
 * server-side with the card left standing for whoever can. */
export const CredentialGateScopeSchema = z
    .enum(["use", "conversation"])
    .describe(
        "How far one release goes: `use` asks again every single time (one click releases exactly one use), `conversation` covers the rest of this conversation and is forgotten when the daemon restarts.",
    );
export type CredentialGateScope = z.infer<typeof CredentialGateScopeSchema>;

// What a gate is ABOUT: one stored secret by its reference name, or one whole connected capability (a
// connector's env, a browser account's profile, an MCP server) by its id. Two kinds rather than one because
// they are withheld differently — a secret is refused at the exit it would resolve at, a capability is simply
// never mounted for the turn — and the subject namespaces are disjoint anyway (env keys are SCREAMING_SNAKE).
export const CredentialGateKindSchema = z
    .enum(["secret", "capability"])
    .describe("Whether this gate covers one stored secret, by the name a reference carries, or one whole connected capability, by its id.");
export type CredentialGateKind = z.infer<typeof CredentialGateKindSchema>;

/* WHICH EXIT A RELEASE WAS ASKED FOR, so the card can say what is about to happen in the reader's terms
 * rather than in the daemon's. The three secret exits are the ones the use ledger already names (a shell
 * command, a JS run's script, a browser keystroke); `session` is a whole capability being mounted for the
 * turn (a signed-in browser profile, a connector's env, an MCP server), and `otp` is one derived one-time
 * code off a stored TOTP seed. */
export const CredentialLaneSchema = z
    .enum(["shell", "code", "browser", "session", "otp"])
    .describe("What the credential was about to be used for: a shell command, a script, typing into a page, mounting a connected account, or one one-time code.");
export type CredentialLane = z.infer<typeof CredentialLaneSchema>;

export const CredentialGateSchema = z.object({
    // An env/generated KEY (`DATABASE_URL`), or a capability id (`reddit`, `komodo`). A vault name's field
    // half (`reddit/password`) is deliberately NOT a subject: gating one field of a connected account and not
    // its neighbours would be a gate with a hole in it, so the whole capability is the unit.
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

/* THE AGENT'S OWN DOOR, `secrets request <subject> --why "…"`. A gated capability is ABSENT from a turn
 * rather than refused inside it (its profile is not mounted, its env is not exported), so the model cannot
 * discover the gate by tripping over it the way a secret reference does — it would conclude the account is
 * disconnected and go looking for another road. This route is the road: it raises the same card the exits
 * raise, and a release is worded as a grant for the REST OF THE CONVERSATION, because a session-shaped
 * credential cannot be handed out for one use. */
export const CredentialRequestSchema = z.object({
    subject: z.string().min(1).describe("What to ask for: the secret's name, or the connected capability's id."),
    why: z.string().max(280).optional().describe("One line on what it is for. The only words on the card that are the agent's."),
    // Which conversation's chat the card goes up in, filled by the CLI from the turn's own environment, so
    // the model cannot aim a card at somebody else's conversation.
    conversationId: z.string().optional().describe("Which conversation to raise the card in. The CLI fills this from the running turn."),
});

export const CredentialGrantSchema = z.object({
    granted: z.literal(true).describe("Always true: a refusal is an error with a sentence, never a `false` here."),
    approvedBy: z.string().describe("Who released it."),
    message: z.string().describe("What the grant means in practice, and what to do next."),
});

// One entry per secret the sandbox knows about, across every store: intent env secrets and intentic-generated
// passwords (from the desired-state repo), capability credentials, and AI-provider accounts. Values never ride
// this shape, `revealable` says whether `reveal` can return one (everything but provider accounts).
export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider entries; capability instance id
    // otherwise. Unique within the inventory, several accounts of one provider each get their own entry.
    key: z.string().describe("What identifies it. Unique across the whole inventory, so several accounts of one provider each get their own entry."),
    kind: z
        .enum(["env", "generated", "capability", "provider"])
        .describe("Where it came from: you set it, the sandbox generated it, a connection needs it, or it is a model account's credential."),
    // Display name for provider entries: "<ProviderName> · <accountLabel>". Absent on env/generated entries.
    label: z.string().optional().describe("A friendlier name, for entries that have one."),
    status: z.enum(["missing", "set", "connected"]).describe("Whether it exists and, for a connection, whether it is working."),
    // The artifact resources referencing this secret ({$secret} refs); [] for capability/provider entries.
    requiredBy: z
        .array(z.object({ resourceId: z.string().describe("Which resource."), type: z.string().describe("What kind of resource it is.") }))
        .describe("What is waiting on it. Empty for a connection's or an account's own credential."),
    // Human-readable provenance, e.g. "desired-state/.env", the UI's "where does this live" line.
    storedAt: z.string().describe("Where it actually lives, in words."),
    revealable: z.boolean().describe("Whether its value can be shown at all. Everything except a model account's credential can be."),
    // Forgejo Actions replication state, present only after adopt on env|generated entries.
    ci: z
        .object({
            synced: z.boolean().describe("Whether the pipeline has it."),
            pushedAt: z.string().optional().describe("When it was last sent there."),
        })
        .optional()
        .describe("Whether a copy has been given to the build pipeline."),
    /* The newest row of the use ledger that concerns this entry, when the agent last SPENT it, on which lane
     * (a shell command, a JS run's script, a browser field), and where it went (the head of the command or
     * script, or the page's host). Names and destinations only, never values. Absent while a secret has never
     * been used, which most never are. */
    lastUse: z
        .object({
            at: z.number().describe("When, in milliseconds."),
            lane: z.enum(["shell", "code", "browser"]).describe("How it was used: a command, a script, or typed into a page."),
            detail: z
                .string()
                .optional()
                .describe("Where it went: the start of the command or script, or the site. Names and destinations only, never values."),
            // Who released it, when a gate made that use somebody's decision. Absent on an ungated use, which
            // is nearly all of them: the ledger row records a person only where a person was actually asked.
            approvedBy: z.string().optional().describe("Who released it for that use, when it is gated. Absent when nothing had to be approved."),
        })
        .optional()
        .describe("The last time an agent actually spent this secret. Absent while it never has been, which most never are."),
    /* THE APPROVAL THIS ENTRY IS BEHIND, joined on from the gate policy so the row can say "needs approval
     * from Bob" without a second call. Absent on the overwhelming majority of entries: gating is for the few
     * credentials where one wrong use is the incident, and a sandbox where everything asks is a sandbox where
     * nobody reads the cards. */
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
