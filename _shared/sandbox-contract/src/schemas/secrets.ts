// secrets: user-supplied env-var secrets the daemon writes to desired-state/.env
import { BrokerRuleSchema } from "@intentic/extension-manifest";
import { z } from "zod";
import { KEYRING_PROGRAMS_MAX, KeyringPackageSchema, KeyringProgramSchema, KeyringShareModeSchema, KeyringSourceSchema } from "./keyring.js";
import { SECRET_HOST_MAX, SECRET_HOST_PATTERN_RE, SECRET_HOSTS_MAX } from "../policy/secret-hosts.js";
// Straight to the sandbox daemon, never through the platform; `apply` reloads .env with no restart. `list` returns keys
// only; `reveal` is the one owner-only exception that returns a value.
// An env var name, as a shell exports it. Exported so the browser validates against this rather than restating it:
// stated twice, the two drifted, and a box with no limit fed a rejection the user could not have predicted.
export const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_KEY_MAX = 128;
const secretKey = z.string().regex(SECRET_KEY_RE).max(SECRET_KEY_MAX);

export const SecretSetSchema = z.object({
    key: secretKey.describe("The name to store it under, which is the name a process will find it by."),
    value: z.string().min(1).describe("The value. It goes straight to your sandbox and never through the platform."),
});
export const SecretKeysSchema = z.object({
    keys: z.array(z.string()).describe("The names that exist here. Only the names: the values never leave the sandbox."),
});
// Same rule as `set`: one name rule for a secret, whichever verb is asking about it.
export const SecretKeyParamSchema = z.object({ key: secretKey.describe("Which secret, by name.") });
export const SecretRevealSchema = z.object({ value: z.string().describe("The value itself. The only place in this API one is ever returned.") });

// A secret nobody has to find or paste: a session key, a webhook signing secret, a database password the task sets up
// itself. The sandbox makes it and keeps it; the caller gets its reference and length, never the value.
export const SECRET_FORMATS = ["hex", "base64url", "alnum"] as const;
export const SecretGenerateSchema = z.object({
    key: secretKey.describe("The name to store it under: a name nothing here holds yet, since a new value would break whatever uses the old one."),
    bytes: z
        .number()
        .int()
        .min(16)
        .max(128)
        .default(32)
        .describe("How much randomness, in bytes. 32 unless whatever reads it demands a particular length."),
    format: z
        .enum(SECRET_FORMATS)
        .default("hex")
        .describe("How it is spelled: `hex` (0-9, a-f), `base64url` (letters, digits, - and _), or `alnum` (letters and digits only, for readers that refuse symbols)."),
});
export const SecretGeneratedSchema = z.object({
    key: z.string().describe("The name it is stored under."),
    length: z.number().int().describe("How many characters it is, which a reader's validation may care about."),
    stored: z.enum(["env", "sandbox"]).describe("Where it was kept: desired-state/.env once DevOps is active, the sandbox's own store before that."),
});

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
    .enum(["shell", "code", "browser", "session", "otp", "gateway", "ssh", "device", "desktop"])
    .describe(
        "What the credential was about to be used for: a shell command, a script, typing into a page, mounting a connected account, one one-time code, a request the credential gateway attaches it to, a signature the sandbox's ssh agent makes with a held key, typing into a window or phone app on one of the owner's computers, or typing into a window on the sandbox's own desktop.",
    );
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

export const CredentialGuardSubjectParamSchema = z.object({
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

// The host guard: the second way a secret can need a person, beside a named approver. On, a use goes unasked only when
// every host its text names is on the secret's list; one aimed anywhere else, or anywhere its text does not show, waits
// for a person's click, whatever the safety judge says and whether or not it could be asked. Off, the guard never asks.
// Keyed like a gate: a secret by its name, a connected capability by its id, covering every field of it.
export const SecretHostSchema = z
    .string()
    .max(SECRET_HOST_MAX)
    .regex(SECRET_HOST_PATTERN_RE)
    .describe(
        "One host, `api.github.com`, or every host under a domain, `*.github.com` (which does not include github.com itself). Lowercase, no scheme or port.",
    );

export const SecretHostSourceSchema = z
    .enum(["owner", "connector", "keyring"])
    .describe(
        "Who set it: the owner, the connector the credential belongs to (whose guard is on with its own service's hosts until the owner changes it), or the keyring on the computer that holds the secret, whose list is changed there.",
    );
export type SecretHostSource = z.infer<typeof SecretHostSourceSchema>;

export const SecretHostGuardSchema = z.object({
    subject: z.string().min(1).describe("Which secret, by the name its reference carries, or which connected capability, by its id."),
    kind: CredentialGateKindSchema,
    guard: z.boolean().describe("On: a use off the list, or whose destination cannot be read, asks a person first. Off: it never asks."),
    hosts: z
        .array(SecretHostSchema)
        .max(SECRET_HOSTS_MAX)
        .describe("Where it goes without asking while the guard is on. Empty with the guard on: every use asks. Kept while it is off, for turning it back on."),
    source: SecretHostSourceSchema,
});
export type SecretHostGuard = z.infer<typeof SecretHostGuardSchema>;

export const SecretHostGuardsSchema = z.object({
    guards: z
        .array(SecretHostGuardSchema)
        .describe("Every secret whose host guard has been set, or that a connector guards by default. One not listed has its guard off. Names and hosts only, never a value."),
});

export const SecretHostGuardSetSchema = z.object({
    subject: z.string().min(1).describe("Which secret, by name, or which connected capability, by id."),
    kind: CredentialGateKindSchema.optional().describe("Whether the subject is a secret or a capability. Worked out from the name when absent."),
    guard: z.boolean().describe("Whether a use off the list, or whose destination cannot be read, must ask a person first."),
    hosts: z
        .array(SecretHostSchema)
        .max(SECRET_HOSTS_MAX)
        .describe(
            "The whole new list. Turning the guard on or taking hosts away is open to anybody who may use secrets; turning it off or adding a host is the owner's to approve.",
        ),
    // Filled by the CLI itself, so the model cannot aim the owner's card at somebody else's conversation.
    conversationId: z
        .string()
        .optional()
        .describe("Which conversation to ask the owner in, when the change needs them. The CLI fills this from the running turn."),
});

export const SecretHostGuardSetResultSchema = z.object({
    guard: z.boolean().describe("Whether the guard is on now."),
    hosts: z.array(z.string()).describe("Where it goes without asking while the guard is on."),
    approvedBy: z.string().optional().describe("Who approved the change, when it needed the owner's click. Absent when nobody had to."),
});

// Across every store: env/generated secrets, capability credentials, AI-provider accounts. Values never ride this
// shape; `revealable` says whether `reveal` can return one (everything but provider accounts).
// How the agent gets one connection's credential, and what it may do with it there. `gateway` is the default for every
// connector that declares gateway routes: the credential never enters the agent's shell, and the rules below are
// enforced where it is attached. `raw` is the owner's explicit choice for a tool that needs the real value; `direct` is a
// connector with no gateway route at all (a database's wire protocol, a mail server, a request signature) or an SSH
// machine signed into with a password; `ssh-agent` is an SSH machine's key, which the sandbox's ssh agent signs with.
export const CredentialDeliveryModeSchema = z
    .enum(["gateway", "raw", "direct", "ssh-agent"])
    .describe(
        "How the agent gets this connection's credential: `gateway` keeps it in the sandbox's credential gateway, which attaches it to each request the agent sends and checks the rules first; `raw` hands it to the agent because the owner chose that for a tool needing the real value; `direct` hands it over because nothing can use it on the agent's behalf (a database, a mail server, an SSH password); `ssh-agent` keeps an SSH key in the sandbox's ssh agent, which signs for the agent's ssh and never hands the key over.",
    );
export type CredentialDeliveryMode = z.infer<typeof CredentialDeliveryModeSchema>;

export const CredentialPolicySchema = z.object({
    subject: z.string().describe("The connection's id."),
    delivery: CredentialDeliveryModeSchema,
    rules: z
        .array(BrokerRuleSchema)
        .describe("What the credential may do through the gateway, checked in order, the first covering rule deciding; a request none covers is allowed."),
    rulesFrom: z
        .enum(["connector", "owner"])
        .describe("Whose rules these are: the connector's own defaults, or the owner's, which replace them whole."),
});
export type CredentialPolicy = z.infer<typeof CredentialPolicySchema>;

export const CredentialPolicySetSchema = z.object({
    subject: z.string().describe("The connection's id."),
    delivery: z
        .enum(["gateway", "raw"])
        .optional()
        .describe("Hand the agent the credential itself (`raw`), or keep it in the gateway (`gateway`). Leave it out to keep what is set."),
    rules: z
        .array(BrokerRuleSchema)
        .nullable()
        .optional()
        .describe("The owner's own rules, replacing the connector's whole; `null` goes back to the connector's. Leave it out to keep what is set."),
});
export type CredentialPolicySet = z.infer<typeof CredentialPolicySetSchema>;

// The program guard: the host guard's counterpart for typing into windows. A sandbox-held secret typed into a window on
// one of the owner's computers goes unasked only into a program on its list and, unless `anyField`, only into a field the
// program marks as a password field; anywhere else it waits for a person. A keyring entry carries its own list, kept on
// that computer (schemas/keyring.ts), which the sandbox can show and never widen.
export const SecretProgramsSchema = z.object({
    programs: z.array(KeyringProgramSchema).max(KEYRING_PROGRAMS_MAX).describe("Programs, by executable name or whole path, it may be typed into unasked."),
    packages: z.array(KeyringPackageSchema).max(KEYRING_PROGRAMS_MAX).describe("Android apps, by package name, it may be typed into unasked."),
    anyField: z.boolean().describe("Whether it may go into a field not marked as a password field without asking."),
    source: z.enum(["owner", "keyring"]).describe("Who keeps the list: the owner, here, or the keyring on the computer that holds the secret."),
});
export type SecretPrograms = z.infer<typeof SecretProgramsSchema>;

export const SecretProgramGuardSchema = SecretProgramsSchema.omit({ source: true }).extend({
    subject: z.string().min(1).describe("Which secret, by the name its reference carries."),
});
export type SecretProgramGuard = z.infer<typeof SecretProgramGuardSchema>;

export const SecretProgramGuardsSchema = z.object({
    guards: z.array(SecretProgramGuardSchema).describe("Every sandbox-held secret whose program list has been set. Names and programs only, never a value."),
});

export const SecretProgramGuardSetSchema = SecretProgramGuardSchema.extend({
    conversationId: z.string().optional().describe("Which conversation to ask the owner in, when the change needs them. The CLI fills this from the running turn."),
});

export const SecretProgramGuardSetResultSchema = SecretProgramsSchema.omit({ source: true }).extend({
    approvedBy: z.string().optional().describe("Who approved the change, when it needed the owner's click. Absent when nobody had to."),
});

// The owner's Type into…: one secret typed into whatever has focus on one of their computers, after a countdown that
// leaves time to put the cursor there. Through that computer's keyring, which still asks when its entry's mode says to.
export const SecretTypeIntoSchema = z.object({
    key: secretKey.describe("Which secret, by name."),
    device: z.string().min(1).describe("Which computer, by its device card (`rog`, or `rog::wsl:archlinux` for a distro's own keyring)."),
    countdownSeconds: z.number().int().min(0).max(10).default(3).describe("How long to wait before typing, for the cursor to be put in place."),
});
export const SecretTypeIntoResultSchema = z.object({
    program: z.string().describe("What it was typed into."),
    field: z.enum(["password", "text"]).describe("Whether the focused field was a password field."),
    asked: z.boolean().describe("Whether the person at the computer was asked."),
});

// The keyrings on the owner's computers this sandbox can reach: where a secret can be kept or typed, and which two can be
// paired to keep one set of entries.
export const SandboxKeyringSchema = z.object({
    machine: z.string().describe("The computer, by its device card."),
    online: z.boolean().describe("Whether it answers now."),
    locked: z.boolean().optional().describe("Whether its keyring is locked, as last heard. Absent while offline."),
    setUp: z
        .boolean()
        .optional()
        .describe("Whether its keyring answers with a vault this sandbox trusts, so a value can be kept there. Absent while offline, and from a daemon older than 2026-10-19."),
    version: z.string().optional().describe("The keyring's release, as last heard."),
    pendingInbox: z.number().int().nonnegative().optional().describe("Values sent to be kept there that wait for its next unlock."),
    shared: z.number().int().nonnegative().describe("How many of its entries are shared with this sandbox."),
    sync: z
        .object({
            fingerprint: z.string().describe("Its sync key's fingerprint, to compare with what the other computer shows when pairing."),
            peers: z.array(z.string()).describe("The computers it is paired with, by device card."),
        })
        .optional()
        .describe("Its pairing with the owner's other keyrings. Absent while offline or before it was heard."),
});
export type SandboxKeyring = z.infer<typeof SandboxKeyringSchema>;
export const SandboxKeyringsSchema = z.object({ keyrings: z.array(SandboxKeyringSchema) });

export const SandboxKeyringPairSchema = z.object({
    a: z.string().min(1).describe("One computer, by its device card."),
    b: z.string().min(1).describe("The other."),
});
export const SandboxKeyringPairResultSchema = z.object({
    fingerprints: z.object({ a: z.string(), b: z.string() }).describe("Each keyring's sync-key fingerprint, as both prompts showed them."),
});

export const SecretInventoryEntrySchema = z.object({
    // Env-var key for env|generated; `<provider>:<accountId>` for provider; capability instance id otherwise.
    key: z.string().describe("What identifies it. Unique across the whole inventory, so several accounts of one provider each get their own entry."),
    kind: z
        .enum(["env", "generated", "capability", "provider", "device"])
        .describe(
            "Where it came from: you set it, the sandbox generated it, a connection needs it, it is a model account's credential, or it lives in the keyring on one of your computers and this sandbox holds only a pointer to it.",
        ),
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
            lane: z
                .enum(["shell", "code", "browser", "gateway", "ssh", "device", "desktop"])
                .describe(
                    "How it was used: a command, a script, typed into a page, attached by the credential gateway to a request the agent sent, a key the sandbox's ssh agent signed with for the agent, typed into a window or app on one of the owner's computers, or typed into a window on the sandbox's desktop.",
                ),
            detail: z
                .string()
                .optional()
                .describe("Where it went: the start of the command or script, or the site. Names and destinations only, never values."),
            approvedBy: z.string().optional().describe("Who released it for that use, when it is gated. Absent when nothing had to be approved."),
        })
        .optional()
        .describe("The last time an agent actually spent this secret. Absent while it never has been, which most never are."),
    // Joined from the credential gateway's policy, on a connection's row only.
    credential: CredentialPolicySchema.omit({ subject: true })
        .optional()
        .describe(
            "How the agent gets this connection's credential and what it may do with it. Absent on everything but a connected command-line tool or SSH machine.",
        ),
    // Joined from the gate policy, so the row can name the approver without a second call.
    gate: z
        .object({
            approvers: z.array(z.string()).describe("Who may release it, by email. Nobody else can, whatever their role."),
            scope: CredentialGateScopeSchema,
        })
        .optional()
        .describe("Who has to release this before the agent can use it, and for how long one release lasts. Absent when it is not gated."),
    // Joined from the host guards, the owner's and a connector's own, so the row can say where it may go.
    hosts: z
        .object({
            guard: z.boolean().describe("Whether a use off the list, or whose destination cannot be read, asks a person first."),
            list: z.array(z.string()).describe("The hosts it goes to unasked while the guard is on, each exact or `*.domain`."),
            source: SecretHostSourceSchema,
        })
        .optional()
        .describe("Its host guard. Absent when none was ever set and no connector sets one: the guard is off."),
    // Joined from the program guards: which windows and phone apps a use may type it into unasked.
    programs: SecretProgramsSchema.optional().describe(
        "Which programs on the owner's computers, and which phone apps, it may be typed into without asking. Absent when none was set: typing it into any window asks first.",
    ),
    // A device row only: the keyring entry the pointer names. Everything here is the keyring's to change, on that computer.
    device: z
        .object({
            machine: z.string().describe("Which computer's keyring holds it, by its device card."),
            mode: KeyringShareModeSchema,
            online: z.boolean().describe("Whether that computer answers now. Offline, an `each-use` or `while-here` secret cannot be used until it does."),
            locked: z.boolean().optional().describe("Whether the keyring there is locked, as last heard. Absent while the computer is offline."),
            source: KeyringSourceSchema,
        })
        .optional()
        .describe("Where a secret held on one of your computers lives and how it is shared. Present on `device` rows only."),
});
export type SecretInventoryEntry = z.infer<typeof SecretInventoryEntrySchema>;
export const SecretInventorySchema = z.object({
    entries: z
        .array(SecretInventoryEntrySchema)
        .describe("One entry per secret this sandbox knows about, from every place they live. No values, ever."),
});
