import { z } from "zod";

// A need: something an agent cannot finish its task without that only a person can provide (a connection, a secret's
// value, wider reach, a tool in the image). Unlike a parked card it outlives the turn that raised it: the sandbox keeps
// it until someone answers, draws it wherever it is waiting, and wakes the conversation when it is met
// (docs/architecture/needs.md). Every word on a need is the daemon's except `why`, the agent's own case.

export const NEED_KINDS = ["capability", "secret", "grant", "release", "environment"] as const;
export const NeedKindSchema = z.enum(NEED_KINDS).describe("What is being asked for: a connection, a secret's value, wider reach, a gated credential, or a tool in the image.");
export type NeedKind = z.infer<typeof NeedKindSchema>;

// `working` is a yes still being carried out: a connection whose form is open, an overlay approved but not yet built.
export const NeedStatusSchema = z
    .enum(["open", "working", "met", "declined", "cancelled"])
    .describe(
        "Where it stands: open (waiting on a person), working (a person said yes and it is being set up), met, declined, or cancelled (the agent withdrew it, or its conversation went away).",
    );
export type NeedStatus = z.infer<typeof NeedStatusSchema>;

export const OPEN_NEED_STATUSES: readonly NeedStatus[] = ["open", "working"];
export const isOpenNeed = (need: { readonly status: NeedStatus }): boolean => OPEN_NEED_STATUSES.includes(need.status);

// A setting value as a form holds it: every field of a catalog entry is a string on the way in.
const FieldValuesSchema = z.record(z.string(), z.string());

export const CapabilityNeedModeSchema = z
    .enum(["connect", "reconnect", "change"])
    .describe("Connect something new, give a connected one a credential that works again, or change a setting on a connected one.");
export type CapabilityNeedMode = z.infer<typeof CapabilityNeedModeSchema>;

export const CapabilityNeedSchema = z.object({
    kind: z.literal("capability"),
    entry: z.string().min(1).describe("The catalog entry, as the catalog names it."),
    name: z.string().describe("What the catalog calls it, never the agent's spelling."),
    mode: CapabilityNeedModeSchema,
    instance: z.string().optional().describe("The connection a reconnect or a change is about."),
    target: z.string().optional().describe("The site, host or address the connection is for, when the entry can hold several."),
    prefill: FieldValuesSchema.optional().describe(
        "Settings the agent could fill in for a new connection, never a credential: the daemon keeps only the entry's own non-secret fields.",
    ),
    changes: FieldValuesSchema.optional().describe("For a change: each setting and the value it would take. Never a credential."),
    reason: z.string().optional().describe("The daemon's own sentence on why this is the ask, such as the refusal a connected credential keeps getting."),
    reported: z
        .boolean()
        .optional()
        .describe(
            "The agent reported the credential refused while the connection still probes as working, so only a person's word that it is fixed meets it: the probe could not see the refusal in the first place.",
        ),
});
export type CapabilityNeed = z.infer<typeof CapabilityNeedSchema>;

// The alphabet a `{{secret:NAME}}` reference resolves; a pasted value is stored under exactly this name.
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const SecretNeedSchema = z.object({
    kind: z.literal("secret"),
    name: z.string().regex(SECRET_NAME).describe("The name it is stored under, and what `{{secret:NAME}}` will resolve."),
    where: z.string().max(200).optional().describe("How it will be used: the header, the command, the site it goes to."),
    link: z
        .string()
        .url()
        .refine((url) => url.startsWith("https://"), "only an https link")
        .optional()
        .describe("Where a person gets one, shown as a link on the card."),
    hint: z.string().max(120).optional().describe("What a valid one looks like, so a wrong paste is caught by eye."),
    replace: z.boolean().optional().describe("One is stored under this name and is being refused: the ask is for a new value in its place."),
});
export type SecretNeed = z.infer<typeof SecretNeedSchema>;

export const GrantSubjectSchema = z
    .enum(["capability", "folder", "shelf", "site"])
    .describe(
        "A connected capability the persona leaves out, a folder outside the conversation's reach, a whole shelf of tools, or a site in the person's own browser, which only their browser extension can allow.",
    );
export type GrantSubject = z.infer<typeof GrantSubjectSchema>;

// A site as a person's browser grants it: the host alone, whatever scheme, path or pattern it was written with
// ("https://github.com/*" and "github.com" are one site). What a site grant need is keyed and met by.
export const grantSite = (origin: string): string =>
    origin
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
        .replace(/[/?#].*$/, "")
        .toLowerCase();

export const GRANT_SHELVES = ["files", "shell", "code", "web", "browser", "delegate", "sandbox"] as const;
export const GrantShelfSchema = z.enum(GRANT_SHELVES);
export type GrantShelf = z.infer<typeof GrantShelfSchema>;

export const GrantScopeSchema = z
    .enum(["conversation", "persona"])
    .describe("How far a yes goes: this conversation only, or the persona itself, for every conversation that wears it.");
export type GrantScope = z.infer<typeof GrantScopeSchema>;

export const GrantNeedSchema = z.object({
    kind: z.literal("grant"),
    subject: GrantSubjectSchema,
    what: z.string().min(1).describe("The capability's id, the folder, or the shelf."),
    label: z.string().describe("What it is, in the daemon's words: the account and its kind, the folder, the shelf's name."),
    persona: z.string().optional().describe("The persona that withholds it, when one does."),
    scope: GrantScopeSchema.optional().describe("How far the yes went, once there was one."),
});
export type GrantNeed = z.infer<typeof GrantNeedSchema>;

export const ReleaseNeedSchema = z.object({
    kind: z.literal("release"),
    subject: z.string().min(1).describe("The gated account or connector."),
    approvers: z.array(z.string()).describe("Who may release it. Anyone else's answer is refused and leaves it waiting."),
});
export type ReleaseNeed = z.infer<typeof ReleaseNeedSchema>;

export const EnvironmentNeedSchema = z.object({
    kind: z.literal("environment"),
    tool: z.string().min(1).describe("What the steps install, the name the proposal is filed under."),
    steps: z.string().min(1).describe("The Dockerfile steps proposed for the image's custom section: RUN and ENV lines only."),
    approvedHash: z.string().optional().describe("The overlay these steps were approved into; met once the running container was built from it."),
});
export type EnvironmentNeed = z.infer<typeof EnvironmentNeedSchema>;

export const NeedSubjectSchema = z
    .discriminatedUnion("kind", [CapabilityNeedSchema, SecretNeedSchema, GrantNeedSchema, ReleaseNeedSchema, EnvironmentNeedSchema])
    .describe("What exactly is asked for.");
export type NeedSubject = z.infer<typeof NeedSubjectSchema>;

// How the agent learned the outcome: the call it raised the need with, words into its live turn, a turn of its own, or
// queued behind what the conversation was doing.
export const NeedToldSchema = z.enum(["call", "turn", "queued"]);
export type NeedTold = z.infer<typeof NeedToldSchema>;

export const NeedSchema = z.object({
    id: z.string().describe("The need's handle, the one `needs cancel` takes."),
    conversationId: z.string().describe("The conversation that asked, and the one its answer wakes."),
    subject: NeedSubjectSchema,
    title: z.string().describe("The one line it leads with, in the daemon's words."),
    why: z.string().max(280).optional().describe("The agent's case for it, and the only words on a need that are the agent's."),
    status: NeedStatusSchema,
    createdAt: z.number().describe("When it was raised, in milliseconds."),
    updatedAt: z.number().describe("When it last moved, in milliseconds."),
    answeredBy: z.string().optional().describe("Who answered it, as the sandbox verified them."),
    outcome: z.string().optional().describe("How it ended, in the daemon's words, once it has."),
    told: NeedToldSchema.optional().describe("How the agent heard the outcome, once it has."),
    unattended: z.boolean().optional().describe("Raised by a turn nobody was watching, so the card waited for whoever came next."),
});
export type Need = z.infer<typeof NeedSchema>;

// What an agent may send: the kind and what it can know about it. Names, titles and every other field the card shows are
// the daemon's to fill in, from the catalog, the persona, the gate policy.
export const NeedAskSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("capability"),
        entry: z.string().min(1).describe("The catalog entry or a connected instance's id."),
        target: z.string().max(200).optional().describe("The site, host or address it is for."),
        set: FieldValuesSchema.optional().describe("Settings to fill in, or to change on a connected one. Credentials are refused."),
        reconnect: z
            .boolean()
            .optional()
            .describe("It is connected, but its credential is being refused: ask for a new one rather than being told to use it."),
    }),
    SecretNeedSchema,
    z.object({
        kind: z.literal("grant"),
        subject: GrantSubjectSchema,
        what: z.string().min(1).max(400),
    }),
    z.object({ kind: z.literal("release"), subject: z.string().min(1) }),
    z.object({ kind: z.literal("environment"), tool: z.string().min(1).max(64), steps: z.string().min(1).max(20_000) }),
]);
export type NeedAsk = z.infer<typeof NeedAskSchema>;

// The longest a raising call holds: under the agent shell's 110-second cutoff, so the answer returns on the call.
export const NEED_WAIT_MAX_S = 100;
export const NEED_WAIT_DEFAULT_S = 90;

export const NeedRaiseSchema = z.object({
    ask: NeedAskSchema,
    why: z.string().max(280).optional(),
    wait: z
        .number()
        .int()
        .min(0)
        .max(NEED_WAIT_MAX_S)
        .optional()
        .describe("Seconds to hold the call for an answer. Absent is 90 for a watched turn and 0 for an unattended one."),
});
export type NeedRaise = z.infer<typeof NeedRaiseSchema>;

// How a raising call ended. `met`: usable now, exit 0. `open`: asked and still waiting, exit 3; the answer arrives in the
// conversation by itself. `refused`: nothing was raised or it was declined, exit 1.
export const NeedRaisedSchema = z.object({
    state: z.enum(["met", "open", "refused"]),
    message: z.string().describe("The sentence the CLI prints, written for the agent to act on."),
    need: NeedSchema.optional(),
    code: z.string().optional().describe("A refusal's type, for a script to branch on."),
});
export type NeedRaised = z.infer<typeof NeedRaisedSchema>;

// A person's answer, by what the card offered. A secret's value travels on its own route (needs.contract.ts), never here.
export const NeedAnswerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("decline"), note: z.string().max(500).optional().describe("Why not, passed to the agent.") }),
    // A connection's yes before its form is saved: moves the need to working, so the board keeps saying so.
    z.object({ kind: z.literal("accept") }),
    // A change to a connected capability's settings, applied as the card showed it.
    z.object({ kind: z.literal("apply") }),
    z.object({ kind: z.literal("grant"), scope: GrantScopeSchema }),
    z.object({ kind: z.literal("release") }),
    z.object({ kind: z.literal("approve") }),
]);
export type NeedAnswer = z.infer<typeof NeedAnswerSchema>;

export const NeedIdParamSchema = z.object({ id: z.string().min(1).describe("Which need.") });
export const NeedAnswerInputSchema = NeedIdParamSchema.extend({ answer: NeedAnswerSchema });
export const NeedSecretInputSchema = NeedIdParamSchema.extend({
    value: z.string().min(1).max(64_000).describe("The secret's value. Stored, never echoed, never written into a transcript."),
});
export const NeedsQuerySchema = z.object({
    conversationId: z.string().optional().describe("One conversation's needs. Absent is every conversation's."),
    open: z.boolean().optional().describe("Only the ones still waiting."),
});
export const NeedsListSchema = z.object({ needs: z.array(NeedSchema).describe("Newest first.") });

// What `capabilities list` reads (GET /capabilities/connectable, a raw route): shared by the daemon's handler and the
// CLI's suite, so the two cannot drift apart again the way a renamed field once left the command printing nothing.
export const CapabilityConnectableSchema = z.object({
    entries: z.array(
        z.object({
            entry: z.string().describe("The catalog entry's id, what `capabilities request` takes."),
            name: z.string(),
            description: z.string(),
            connected: z.boolean().describe("Whether an instance of it is live, not merely added."),
        }),
    ),
    suggested: z
        .array(
            z.object({
                entry: z.string(),
                claim: z.string().describe("What the workspace seems to want, in words."),
                evidence: z.string().describe("What was read to say so, verbatim: a file, a remote."),
            }),
        )
        .default([]),
});
export type CapabilityConnectable = z.infer<typeof CapabilityConnectableSchema>;

// One open need as the conversation's card lists it: enough for the board to say what the agent waits on.
export const AgentNeedSchema = z.object({
    id: z.string(),
    kind: NeedKindSchema,
    title: z.string(),
    status: NeedStatusSchema,
});
export type AgentNeed = z.infer<typeof AgentNeedSchema>;

// What a person allowed one conversation beyond its persona and area, from a grant need's card
// (personas/conversation-grants.ts). Honoured from that conversation's next turn on, and revocable on the Grants page.
export const ConversationGrantSchema = z.object({
    capabilities: z.array(z.string()).default([]).describe("Connected capabilities it may use although its persona leaves them out."),
    folders: z.array(z.string()).default([]).describe("Workspace folders its file tools may touch beyond its fence."),
    shelves: z.array(GrantShelfSchema).default([]).describe("Shelves of tools opened for it."),
    // Answered on an install card's "Allow installs for this conversation", read live by the command gate, so it holds
    // from the install that asked onward, this turn included, and across restarts.
    installs: z
        .boolean()
        .default(false)
        .describe("Whether its own dependency installs run without asking, where the owner's setting would otherwise ask first."),
    // Answered on a host guard's card, "Allow <secret> anywhere in this conversation", read live by the host guard.
    secrets: z
        .array(z.string())
        .default([])
        .describe("Secrets whose host guard it may send past without asking, by registry name."),
    // Answered on any permission card's Allow menu, read live by the card registry: every later request a person could
    // have allowed once settles as allowed. A request that always asks still asks.
    everything: z
        .boolean()
        .default(false)
        .describe("Whether every request an allow-once could settle is allowed without asking, until somebody takes it back."),
    updatedAt: z.number().describe("When it last changed, in milliseconds."),
    by: z.string().optional().describe("Who last allowed something here."),
});
export type ConversationGrant = z.infer<typeof ConversationGrantSchema>;

// Every yes still standing, by conversation: what its grants widened past its persona or area, and which gated
// credentials a named person released to it. Reviewed and taken back from Needs you.
export const StandingGrantsSchema = z.object({
    conversations: z.array(
        z.object({
            conversationId: z.string(),
            capabilities: z.array(z.string()).describe("Connected capabilities allowed although its persona leaves them out."),
            folders: z.array(z.string()).describe("Workspace folders its file tools may touch beyond its fence."),
            shelves: z.array(GrantShelfSchema).describe("Shelves of tools opened for it."),
            installs: z.boolean().default(false).describe("Whether its own dependency installs run without asking."),
            secrets: z.array(z.string()).default([]).describe("Secrets it may send past their host guard without asking."),
            everything: z.boolean().default(false).describe("Whether every request an allow-once could settle is allowed without asking."),
            by: z.string().optional().describe("Who last allowed one of those."),
            updatedAt: z.number().optional().describe("When one of those last changed, in milliseconds."),
            releases: z
                .array(z.object({ subject: z.string(), approvedBy: z.string(), at: z.number() }))
                .describe("Gated credentials released to it, until somebody takes one back."),
        }),
    ),
});
export type StandingGrants = z.infer<typeof StandingGrantsSchema>;

export const GrantRevokeSchema = z.object({
    conversationId: z.string(),
    kind: z
        .enum(["capability", "folder", "shelf", "release", "install", "secret", "everything"])
        .describe(
            "Which kind of yes: a grant past the persona or area, a credential's release, letting its installs run unasked, a secret sent past its host guard, or allowing everything.",
        ),
    what: z.string().describe("The capability id, folder, shelf, released credential or secret it named; empty for installs and everything."),
});
export type GrantRevoke = z.infer<typeof GrantRevokeSchema>;

// The file the needs store keeps: every open need and the recent closed ones, by id.
export const NeedsFileSchema = z.record(z.string(), NeedSchema);
export type NeedsFile = z.infer<typeof NeedsFileSchema>;
