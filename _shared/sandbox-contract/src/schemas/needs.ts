import { z } from "zod";
import { KeyringShareModeSchema } from "./keyring.js";
import { NeedKindSchema } from "./need-kinds.js";
import { AutomationSchema, WatchKindSchema } from "./automations.js";
import { DeployNeedAskSchema, DeployNeedSchema } from "./stack-grants.js";
import { HostPowerFindingSchema } from "./host-power.js";
import { WslMemoryNeedSchema } from "./wsl-memory.js";
import { RedirectNeedSchema } from "./redirect-need.js";
import { ContactNeedAskSchema, ContactNeedSchema } from "./contact-need.js";
import { entryId } from "./internal.js";
import { PASS_SCOPES } from "../protocol/doors/pass-scopes.js";
import { SECRET_HOSTS_MAX } from "../policy/secret-hosts.js";
import { SecretHostSchema } from "./secrets.js";

// A need: something an agent cannot finish its task without that only a person can provide (a connection, a secret's
// value, wider reach, a tool in the image). Unlike a parked card it outlives the turn that raised it: the sandbox keeps
// it until someone answers, draws it wherever it is waiting, and wakes the conversation when it is met
// (docs/architecture/needs.md). Every word on a need is the daemon's except `why`, the agent's own case.

export { NEED_KINDS, type NeedKind, NeedKindSchema } from "./need-kinds.js";
export { REDIRECT_WORDS_MAX, type RedirectNeed, RedirectNeedSchema } from "./redirect-need.js";

// `working` is a yes still being carried out: a connection whose form is open, an overlay approved but not yet built.
export const NeedStatusSchema = z
    .enum(["open", "working", "met", "declined", "cancelled"])
    .describe(
        "Where it stands: open (waiting on a person), working (a person said yes and it is being set up), met (a person's answer, the daemon's own check, or the agent's word where no check can see it), declined, or cancelled (the agent withdrew it, or its conversation went away).",
    );
export type NeedStatus = z.infer<typeof NeedStatusSchema>;

export const OPEN_NEED_STATUSES: readonly NeedStatus[] = ["open", "working"];
export const isOpenNeed = (need: { readonly status: NeedStatus }): boolean => OPEN_NEED_STATUSES.includes(need.status);

// A setting value as a form holds it: every field of a catalog entry is a string on the way in.
const FieldValuesSchema = z.record(z.string(), z.string());

export const CapabilityNeedModeSchema = z
    .enum(["connect", "reconnect", "change", "remove"])
    .describe(
        "Connect something new, give a connected one a credential that works again, change a setting on a connected one, or remove a connected one.",
    );
export type CapabilityNeedMode = z.infer<typeof CapabilityNeedModeSchema>;

export const CapabilityNeedSchema = z.object({
    kind: z.literal("capability"),
    entry: z.string().min(1).describe("The catalog entry, as the catalog names it."),
    name: z.string().describe("What the catalog calls it, never the agent's spelling."),
    mode: CapabilityNeedModeSchema,
    instance: z.string().optional().describe("The connection a reconnect, a change or a removal is about."),
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

// A `{{secret:name}}` reference wherever it stands in text, capturing the name. Wider than SECRET_NAME, since a
// reference also names the other stores' entries (`<capability>/<field>`). Not global, so a shared instance carries no
// `lastIndex` between callers: a site that replaces or spans every one derives its own /g copy from it. The terminal
// filter (@intentic/output-cleaners, builtins only) keeps a copy, pinned to this one by the daemon's
// src/secrets/terminal-masking-parity.test.ts.
// `{{secret:NAME|file}}` (the second capture) resolves to the path of a private file holding the value instead of the
// value itself: the way a multi-line value, or one with quotes, reaches a command without being spliced into its source.
// Group 1 is the name in both forms, so every reader that only needs the name reads both alike.
export const SECRET_REFERENCE = /\{\{secret:([A-Za-z0-9_./-]+)(?:\|(file))?\}\}/;

// A secret's host guard list as a card starts it (needs/kinds/secret-need.ts in the sandbox).
const SecretHostsSchema = z.array(SecretHostSchema).max(SECRET_HOSTS_MAX);
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
    multiline: z
        .boolean()
        .optional()
        .describe("A value with lines (a key file, a whole .env): the card takes it in a box with lines and keeps it exactly as pasted."),
    // The agent's proposal: what a person keeps on the card starts the secret guarded, rather than off until someone acts.
    hosts: SecretHostsSchema.min(1)
        .optional()
        .describe(
            "Where it will be sent, as the agent proposes it. The card shows each host for the person to keep or drop, and the secret's host guard starts on with the ones they keep: it goes unasked only there, and anywhere else asks first.",
        ),
});
export type SecretNeed = z.infer<typeof SecretNeedSchema>;

export const GrantSubjectSchema = z
    .enum(["capability", "folder", "shelf", "site"])
    .describe(
        "A connected capability the conversation's role or access leaves out, a folder outside its reach, a whole shelf of tools, or a site in the person's own browser, which only their browser extension can allow.",
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

// How far a yes went on a grant answered before 2026-11-18, when a card could lift what a role (then called a persona)
// withheld. Kept so those needs still read, under the words they were stored with; nothing answers with it any more.
export const GrantScopeSchema = z
    .enum(["conversation", "persona"])
    .describe("How far a yes went, on a need answered before a role's limits became access: this conversation only, or the role itself (stored as `persona`).");
export type GrantScope = z.infer<typeof GrantScopeSchema>;

// A role a grant need offers to switch the conversation to: one whose access allows what was asked for.
export const GrantRoleSchema = z.object({
    id: entryId.describe("The role's id, or a built-in's."),
    label: z.string().describe("Its name on screen."),
});
export type GrantRole = z.infer<typeof GrantRoleSchema>;

// What a role withholds is access (docs/architecture/access.md), and no card lifts access. What a card offers instead
// is to switch the conversation to a role that has it: `roles` lists them, and the answer names one.
export const GrantNeedSchema = z.object({
    kind: z.literal("grant"),
    subject: GrantSubjectSchema,
    what: z.string().min(1).describe("The capability's id, the folder, or the shelf."),
    label: z.string().describe("What it is, in the daemon's words: the account and its kind, the folder, the shelf's name."),
    // Stored as `persona` until 2026-11-18 (needs-store.ts converts it).
    role: z.string().optional().describe("The role that withholds it, when one does."),
    // Added 2026-11-18, optional: a need raised before offered a grant instead.
    roles: z
        .array(GrantRoleSchema)
        .max(50)
        .optional()
        .describe("The roles whose access allows it, any of which the conversation may be switched to. Empty or absent for a site."),
    scope: GrantScopeSchema.optional().describe("How far the yes went, on a need answered before roles were switched instead."),
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

// What its check sees today, run once as the automation was proposed, so the person deciding reads the watch working
// rather than a promise that it would. Absent for a guard command, which the agent ran itself before asking: run here
// it would carry the proposed role's credentials before anyone approved them.
export const AutomationFirstCheckSchema = z.object({
    pass: z.boolean().describe("Whether the check passes today, which for a watch waiting on one thing means it would fire at once."),
    saw: z.string().describe("What it saw, or what it is still waiting for."),
    at: z.number().describe("When it ran, in milliseconds."),
});
export type AutomationFirstCheck = z.infer<typeof AutomationFirstCheckSchema>;

export const AutomationNeedSchema = z.object({
    kind: z.literal("automation"),
    automation: AutomationSchema.describe("The automation as it would be saved, switched on, the moment a person approves it."),
    replaces: z.boolean().optional().describe("An automation of this id already exists, and approving replaces it."),
    firstCheck: AutomationFirstCheckSchema.optional(),
    // (2026-11-26) The declaration of the kind its source names, when an extension declares it, so the card says what the
    // watch looks at in that kind's own words. Absent for a page, a guard, and from a daemon before contributed kinds.
    watchKind: WatchKindSchema.optional(),
});
export type AutomationNeed = z.infer<typeof AutomationNeedSchema>;

// The longest rule one proposal adds: a sentence or two the owner said, never a document. Every turn pays for AGENTS.md.
export const INSTRUCTION_MAX = 1000;

// A rule the owner stated once ("from now on…", "remember…") that an agent proposes keeping in an AGENTS.md, which the
// daemon composes into every later conversation's instructions (2026-11-19, the shinobi-society audit: one preference
// restated in six conversations, rules given in replies that died with them). Nothing is written until a person approves;
// the yes appends `text` to the file on the main tree, exactly as `diff` shows it.
export const InstructionNeedSchema = z.object({
    kind: z.literal("instruction"),
    file: z.string().min(1).describe("The AGENTS.md it goes into, relative to the workspace root: `AGENTS.md`, or a repository's `<repo>/AGENTS.md`."),
    text: z.string().min(1).max(INSTRUCTION_MAX).describe("The rule as it would be added, word for word."),
    diff: z.string().describe("The change as a unified diff against the file as it stood when proposed: what approving writes."),
    creates: z.boolean().optional().describe("The file does not exist yet: approving creates it holding this rule alone."),
});
export type InstructionNeed = z.infer<typeof InstructionNeedSchema>;

// The computer this sandbox runs on would sleep through work just booked on it (2026-11-22, host-power.ts). Raised by the
// daemon itself in the booking conversation; a yes runs `power-stay-on` and the chosen answer to a Windows Update restart
// (`remedy`). Told to nobody: a woken turn would run the booked work early.
export const HostPowerNeedSchema = z.object({
    kind: z.literal("host-power"),
    device: z.string().min(1).describe("The connected computer this sandbox runs on, by its device id."),
    findings: z.array(HostPowerFindingSchema).describe("What its OS would do to the work, as read when the card was raised."),
    dueAt: z.number().optional().describe("When the booked work that raised it is due, in milliseconds."),
    utcOffsetMinutes: z.number().int().optional().describe("The computer's local time minus UTC when read: what places its findings' local hours on another clock."),
});
export type HostPowerNeed = z.infer<typeof HostPowerNeedSchema>;

// A project claimed for this sandbox (docs/architecture/account-routing.md): the owner's other sandboxes then report the
// problems they see in it here (`projects report`), into this sandbox's issues inbox. Only the owner, signed in to the
// platform, writes a claim, so the agent proposes it and the owner's press makes it; one sandbox per project on an
// account, so a claim another sandbox held moves here.
export const ClaimNeedSchema = z.object({
    kind: z.literal("claim"),
    project: z.string().min(1).describe("The project, as its repository: github.com/owner/repo."),
    heldBy: z.string().optional().describe("The sandbox on the owner's account that claims it now, which a yes moves it from."),
});
export type ClaimNeed = z.infer<typeof ClaimNeedSchema>;

// A person's leave for this sandbox to route as them into another one (docs/architecture/account-routing.md, 2026-11-24):
// every scope but a report needs the pairing secret that person minted at the target and handed here, so the platform's
// pass alone opens nothing but an inbox. Only that person can press it: their editor, signed in to both sandboxes, mints
// the secret over there and stores it here. Met once this sandbox holds a secret for (target, person).
export const RouteNeedSchema = z.object({
    kind: z.literal("route"),
    target: z.string().min(1).max(40).describe("The target sandbox's tunnel id."),
    targetName: z.string().max(120).describe("Its name, as the platform gave it."),
    person: z.string().min(1).max(254).describe("The one person this sandbox would route as, and the only one who can allow it."),
    scopes: z.array(z.enum(PASS_SCOPES)).min(1).describe("What the routing is for: drop, read or task."),
    address: z.string().max(400).optional().describe("The target's address, as the platform gave it, which the card reaches it at."),
    from: z.string().max(40).optional().describe("This sandbox's own tunnel id, which the target keys the pairing on."),
});
export type RouteNeed = z.infer<typeof RouteNeedSchema>;

export const NeedSubjectSchema = z
    .discriminatedUnion("kind", [
        CapabilityNeedSchema,
        SecretNeedSchema,
        GrantNeedSchema,
        ReleaseNeedSchema,
        EnvironmentNeedSchema,
        AutomationNeedSchema,
        InstructionNeedSchema,
        HostPowerNeedSchema,
        WslMemoryNeedSchema,
        ClaimNeedSchema,
        RouteNeedSchema,
        RedirectNeedSchema,
        DeployNeedSchema,
        ContactNeedSchema,
    ])
    .describe("What exactly is asked for.");
export type NeedSubject = z.infer<typeof NeedSubjectSchema>;

// How the agent learned the outcome: the call it raised the need with, words into its live turn, its own turn, or queued.
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
    byAgent: z
        .boolean()
        .optional()
        .describe("The agent closed it as met on its own word (`needs done`), after a person said in the chat it was fixed and a retry worked."),
    outcome: z.string().optional().describe("How it ended, in the daemon's words, once it has."),
    told: NeedToldSchema.optional().describe("How the agent heard the outcome, once it has."),
    unattended: z.boolean().optional().describe("Raised by a turn nobody was watching, so the card waited for whoever came next."),
});
export type Need = z.infer<typeof NeedSchema>;

// What an agent may send: the kind and what it can know about it. Names, titles and every other field the card shows are
// the daemon's to fill in, from the catalog, the role, the gate policy.
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
        remove: z
            .boolean()
            .optional()
            .describe("Take a connection away: the person removes it in one press on the card, as the Capabilities page's Remove does."),
    }),
    SecretNeedSchema,
    z.object({
        kind: z.literal("grant"),
        subject: GrantSubjectSchema,
        what: z.string().min(1).max(400),
    }),
    z.object({ kind: z.literal("release"), subject: z.string().min(1) }),
    z.object({ kind: z.literal("environment"), tool: z.string().min(1).max(64), steps: z.string().min(1).max(20_000) }),
    // Everything the agent proposes, switched on; the daemon checks it as the Automations page would save it, runs a
    // source's check once for the card, and saves it only on a person's approval.
    z.object({ kind: z.literal("automation"), automation: AutomationSchema }),
    // The file and the words; the daemon checks the file is an AGENTS.md in the workspace and draws the diff itself.
    z.object({
        kind: z.literal("instruction"),
        file: z.string().min(1).max(400).describe("The AGENTS.md, relative to the workspace root."),
        text: z.string().trim().min(1).max(INSTRUCTION_MAX).describe("The rule, as it should read in the file."),
    }),
    // The project as the agent has it: github.com/owner/repo or any remote URL of it; the daemon normalises it.
    z.object({ kind: z.literal("claim"), project: z.string().trim().min(1).max(400).describe("The project's repository, or any remote URL of it.") }),
    // The target as the agent has it (its name or id); the person is the one the raising conversation acts for, never named here.
    z.object({
        kind: z.literal("route"),
        target: z.string().trim().min(1).max(120).describe("The sandbox to route into, by its name or id."),
        scopes: z
            .array(z.enum(PASS_SCOPES))
            .min(1)
            .optional()
            .describe("What it is for: drop, read or task (all three when left out)."),
    }),
    // Where the person's message belongs, as the agent has it: a sandbox by name or id, or a project whose claim finds it.
    // The words and the person are the daemon's, never named here.
    z.object({
        kind: z.literal("redirect"),
        target: z.string().trim().min(1).max(120).optional().describe("The sandbox the message belongs in, by its name or id."),
        project: z.string().trim().min(1).max(400).optional().describe("Or the project it is about: the sandbox claiming it is the target."),
    }),
    DeployNeedAskSchema,
    ContactNeedAskSchema,
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
    // A change to a connected capability's settings, or its removal, applied as the card showed it.
    z.object({ kind: z.literal("apply") }),
    // 2026-11-18: was `{ scope }`, a yes that lifted what the role withheld; now the role the conversation switches to.
    z.object({ kind: z.literal("grant"), role: entryId.describe("Which of the need's roles the conversation switches to.") }),
    z.object({ kind: z.literal("release") }),
    // (2026-11-27) `remedy`: a host-power card's answer to a Windows Update restart (POWER_REMEDY); absent is the pause.
    z.object({ kind: z.literal("approve"), remedy: z.enum(["update-pause", "before-sign-in"]).optional() }),
]);
export type NeedAnswer = z.infer<typeof NeedAnswerSchema>;

export const NeedIdParamSchema = z.object({ id: z.string().min(1).describe("Which need.") });
// POST /needs/{id}/done: the agent closing its own need as met, where nothing the daemon checks could see it met.
export const NeedDoneInputSchema = NeedIdParamSchema.extend({
    how: z.string().trim().min(1).max(280).describe("What showed the agent it works now: the call it retried and what came back."),
});
export const NeedAnswerInputSchema = NeedIdParamSchema.extend({ answer: NeedAnswerSchema });
// POST /needs/{id}/release: a release need's own answer, from the people its gate names, whatever their tier.
export const NeedReleaseInputSchema = NeedIdParamSchema.extend({
    answer: z.enum(["release", "decline"]).describe("Release the credential to the conversation, or decline it."),
});
export const NeedSecretInputSchema = NeedIdParamSchema.extend({
    value: z.string().min(1).max(64_000).describe("The secret's value. Stored, never echoed, never written into a transcript."),
    // "Keep it on my computer": the value is sealed to that computer's keyring inbox (schemas/keyring.ts) and kept there,
    // and this sandbox holds a pointer to it; nothing is stored here. Absent: stored in the sandbox, as before.
    keepOn: z
        .object({
            device: z.string().min(1).describe("Which computer's keyring keeps it, by its device card."),
            mode: KeyringShareModeSchema.describe("How that keyring answers this sandbox for it."),
        })
        .optional()
        .describe("Keep it in the keyring on one of your computers instead of in the sandbox."),
    hosts: SecretHostsSchema.optional().describe(
        "The hosts you let it go to unasked, of those the agent proposed: its host guard starts on with them. Absent or empty leaves its host guard as it is, and a guard already on is never widened from here. Ignored with keepOn, whose keyring keeps its own list.",
    ),
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

// A credential gateway card's "Allow requests like this with <name> in this conversation": the `ask` rule it answered
// stops asking that conversation, until somebody takes it back. Kept by the rule's own content, so editing the rule
// asks again.
export const BrokerRulePassSchema = z.object({
    capability: z.string().describe("The capability whose rule asked, by id."),
    rule: z.string().describe("The rule's own identity (its content), so an edited rule is a different one and asks again."),
    said: z.string().describe('The request in a person\'s words, as the card put it: "GET api.github.com/repos/x with GitHub".'),
});
export type BrokerRulePass = z.infer<typeof BrokerRulePassSchema>;

// What a person allowed one conversation (roles/conversation-grants.ts), revocable on the Grants page. Each is a
// release inside its access, never a widening of it: until 2026-11-18 it also held capabilities, folders and shelves a
// card lifted past the conversation's role, retired when a role's limits became access.
export const ConversationGrantSchema = z.object({
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
    // Put on from the conversation's card, read live by the card registry (schemas/auto-approve.ts): wider than
    // `everything`, it answers the owner's hard rules too, and the conversations this one starts follow it.
    autoApprove: z
        .boolean()
        .default(false)
        .describe("Whether every permission it or a subagent it starts asks for is approved without asking, the owner's hard rules included."),
    // Answered on a credential gateway card, read live by the gateway as each request its rules would ask about arrives.
    rules: z
        .array(BrokerRulePassSchema)
        .default([])
        .describe("Credential gateway rules that no longer ask before its requests, each with the words a person allowed it in."),
    updatedAt: z.number().describe("When it last changed, in milliseconds."),
    by: z.string().optional().describe("Who last allowed something here."),
});
export type ConversationGrant = z.infer<typeof ConversationGrantSchema>;

// A yes that names no conversation: it applies to the whole sandbox, so it is listed beside the per-conversation ones and
// taken back from the same place (docs/architecture/needs.md). Each is kept off the workspace, where no agent writes.
export const OWNER_GRANT_KINDS = ["command-policy", "hook-set", "extension"] as const;
export const OwnerGrantKindSchema = z.enum(OWNER_GRANT_KINDS);
export type OwnerGrantKind = z.infer<typeof OwnerGrantKindSchema>;

export const OwnerGrantSchema = z.discriminatedUnion("kind", [
    // A permission card's "Always: <line>" on a command: the line joins the owner's policy for the safety judge, in every
    // conversation, until somebody takes it back.
    z.object({
        kind: z.literal("command-policy"),
        line: z.string().describe("The policy line the judge reads, exactly as it was accepted on the card."),
        at: z.number().describe("When it was allowed, in milliseconds."),
        by: z.string().optional().describe("Who allowed it, off the verified reply."),
    }),
    // A set of Claude Code hooks approved by its digest (guard/hook-approvals.ts): turns run its hooks until it is taken back.
    z.object({
        kind: z.literal("hook-set"),
        digest: z.string().describe("The set's fingerprint, what taking it back names."),
        hooks: z.array(z.string()).describe("Each hook in the set in the daemon's words: when it runs and what it runs."),
        at: z.number().describe("When it was approved, in milliseconds."),
    }),
    // A workspace extension approved for the powers it declared then (capabilities/extension-inventory/extension-approvals.ts).
    z.object({
        kind: z.literal("extension"),
        id: z.string().describe("The extension, by its publisher.name id."),
        powers: z.array(z.string()).describe("What it was approved to do, one power per entry."),
        at: z.number().describe("When it was approved, in milliseconds."),
    }),
]);
export type OwnerGrant = z.infer<typeof OwnerGrantSchema>;

// Every yes still standing, by conversation, and which gated credentials a named person released to it. Reviewed and
// taken back from Needs you.
export const StandingGrantsSchema = z.object({
    conversations: z.array(
        z.object({
            conversationId: z.string(),
            installs: z.boolean().default(false).describe("Whether its own dependency installs run without asking."),
            secrets: z.array(z.string()).default([]).describe("Secrets it may send past their host guard without asking."),
            everything: z.boolean().default(false).describe("Whether every request an allow-once could settle is allowed without asking."),
            autoApprove: z.boolean().default(false).describe("Whether it and its subagents are approved without asking, the owner's hard rules included."),
            rules: z.array(BrokerRulePassSchema).default([]).describe("Credential gateway rules that no longer ask before its requests."),
            by: z.string().optional().describe("Who last allowed one of those."),
            updatedAt: z.number().optional().describe("When one of those last changed, in milliseconds."),
            releases: z
                .array(z.object({ subject: z.string(), approvedBy: z.string(), at: z.number() }))
                .describe("Gated credentials released to it, until somebody takes one back."),
        }),
    ),
    ownerWide: z
        .array(OwnerGrantSchema)
        .default([])
        .describe("Yeses that name no conversation: command policy lines allowed with Always, approved hook sets, approved workspace extensions."),
    unreadable: z
        .array(OwnerGrantKindSchema)
        .default([])
        .describe("Kinds of owner-wide yes whose record this build could not read: none of that kind stands, and none is listed, until the file is fixed."),
});
export type StandingGrants = z.infer<typeof StandingGrantsSchema>;

export const ConversationGrantRevokeSchema = z.object({
    conversationId: z.string(),
    kind: z
        .enum(["release", "install", "secret", "everything", "auto-approve", "rule"])
        .describe(
            "Which kind of yes: a credential's release, letting its installs run unasked, a secret sent past its host guard, allowing everything, its auto-approve mark, or a credential gateway rule that stopped asking.",
        ),
    what: z.string().describe("The released credential or secret it named, or the rule's identity; empty for installs, everything and auto-approve."),
    capability: z.string().optional().describe("For a rule, the capability whose rule it is; a rule's identity alone does not say."),
});
export type ConversationGrantRevoke = z.infer<typeof ConversationGrantRevokeSchema>;

// Taking back a yes that names no conversation: the kind says which list, `what` which entry of it.
export const OwnerGrantRevokeSchema = z.object({
    kind: OwnerGrantKindSchema.describe("Which kind of owner-wide yes: a command policy line, an approved hook set, or an approved extension."),
    what: z.string().min(1).describe("The policy line, the hook set's digest, or the extension's id."),
});
export type OwnerGrantRevoke = z.infer<typeof OwnerGrantRevokeSchema>;

export const GrantRevokeSchema = z.union([ConversationGrantRevokeSchema, OwnerGrantRevokeSchema]);
export type GrantRevoke = z.infer<typeof GrantRevokeSchema>;

// The file the needs store keeps: every open need and the recent closed ones, by id.
export const NeedsFileSchema = z.record(z.string(), NeedSchema);
export type NeedsFile = z.infer<typeof NeedsFileSchema>;
