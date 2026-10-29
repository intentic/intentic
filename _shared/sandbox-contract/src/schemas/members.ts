// members: the daemon's shared-access roster (GET/POST/DELETE /members), who besides the owner reaches this sandbox
import { z } from "zod";
import type { CapabilityKind } from "./capabilities.js";
import { entryId } from "./internal.js";
import { type GrantedRole, GrantedRoleSchema, type MemberRole, MemberRoleSchema } from "./shared.js";
import { ToolCeilingSchema } from "./tool-ceiling.js";

// WHAT A PERSON MAY RUN BESIDES THEIR OWN WORK, one part of the sandbox at a time. Full access (the maintainer tier) holds
// every one; a person with access of their own holds the ones named on their row, so the owner can hand over who gets in
// without handing over the whole box (docs/architecture/access.md).
// `people`: who has access and to what (the roster, the requests for more, areas, access profiles, who opens previews,
// another member's passkeys). Bounded below Full access by `peopleChangeRefusal`.
// `secrets`: the Secrets page whole: stored secrets, who must approve a use, where a secret may go, and how a command-line
// tool's credential reaches the agent.
// `privacy`: the privacy shield: what it masks, reading masked values back, and forgetting a taught dataset.
// `ownAccounts`: connecting AI accounts of their own. An account a person connected is theirs to run on whatever their
// `aiAccounts` says, and theirs to rename or disconnect (the daemon's auth/members/account-connectors.ts).
export const ManageRightSchema = z.enum(["people", "secrets", "privacy", "ownAccounts"]);
export type ManageRight = z.infer<typeof ManageRightSchema>;
export const MANAGE_RIGHTS: readonly ManageRight[] = ManageRightSchema.options;

/** Whether this person may run one part of the sandbox: the owner and Full access run every part, anyone else what their row names. */
export const holdsRight = (caller: { readonly role: MemberRole; readonly manages?: readonly ManageRight[] | undefined }, right: ManageRight): boolean =>
    caller.role === "owner" || caller.role === "maintainer" || (caller.manages?.includes(right) ?? false);

/**
 * Why someone who manages people may not make this change to one person's access; undefined when they may. The owner and
 * Full access change anyone's, their own included. The People & access right alone changes the access of anyone below
 * Full access but its holder: it never grants Full access, never changes a Full access person's, never its holder's own
 * (that is how a limit set on them holds), and hands out only the rights its holder has. `after` absent is a removal;
 * its `manages` absent keeps the row's, as a grant reads it.
 */
export const peopleChangeRefusal = (
    manager: { readonly email: string; readonly role: MemberRole; readonly manages?: readonly ManageRight[] | undefined },
    target: {
        readonly email: string;
        readonly before?: { readonly role: GrantedRole; readonly manages?: readonly ManageRight[] | undefined } | undefined;
        readonly after?: { readonly role: GrantedRole; readonly manages?: readonly ManageRight[] | undefined } | undefined;
    },
): string | undefined => {
    if (manager.role === "owner" || manager.role === "maintainer") {
        return undefined;
    }
    if (!holdsRight(manager, "people")) {
        return "only the owner, Full access, or someone given People & access changes who has access";
    }
    if (manager.email.toLowerCase() === target.email.toLowerCase()) {
        return "your own access is changed by the owner or someone with Full access";
    }
    if (target.before?.role === "maintainer") {
        return "a Full access person's access is changed by the owner or someone with Full access";
    }
    if (target.after?.role === "maintainer") {
        return "Full access is granted by the owner or someone with Full access";
    }
    const had = new Set(target.before?.manages ?? []);
    const handed = (target.after?.manages ?? []).filter((right) => !had.has(right) && !(manager.manages ?? []).includes(right));
    return handed.length === 0 ? undefined : `you can hand out only the rights you hold yourself, and ${handed.join(", ")} is not one of yours`;
};

// WHAT A PERSON'S CONVERSATIONS MAY SPEND: the connected capabilities (by id) and the stored secrets (by name) an agent
// working for them is handed. Enforced by the daemon, not told to the model: a capability outside it is never mounted
// for their turns, its variables and skill are left out, and every exit that spends a credential (a `{{secret:…}}`
// reference, the credential gateway, an ssh signature, an account's password) refuses it with no card that could lift
// it (secrets/credential-reach.ts). A conversation reaches only what every person who has written in it reaches, so
// a person can never borrow more by replying in somebody else's.
export const CredentialReachSchema = z.object({
    capabilities: z.array(z.string().min(1)).max(500).describe("Connected capability ids their conversations may use."),
    secrets: z.array(z.string().min(1)).max(500).describe("Stored secret names (not a capability's own) their conversations may use."),
});
export type CredentialReach = z.infer<typeof CredentialReachSchema>;

// The capability kinds a reach can hold back, because each one reaches a turn only through something the daemon hands
// it per turn (a mount, a variable, a signature, a gateway request). The rest are the sandbox's own machinery with no
// value to withhold (Docker, a VPN once dialled, a mounted share, a local model, the wallet's owner-approved cards), so a
// reach neither lists nor removes them: a switch for one would be a line on a screen.
export const REACHABLE_CREDENTIAL_KINDS: readonly CapabilityKind[] = [
    "cli",
    "mcp",
    "browser",
    "identity",
    "ssh",
    "device",
    "phone",
    "webext",
    "plugin",
    "extension",
    // The owner's account: a person this sandbox works for may be kept from making sandboxes on it.
    "fleet",
    // Another of the owner's sandboxes: a person may be kept from handing it work.
    "link",
];

// WHICH AI ACCOUNTS A PERSON'S CONVERSATIONS MAY RUN ON: the model accounts that pay for a turn (a Claude or Codex
// subscription, a routed provider's sign-in, an API-key endpoint), as distinct from the connections above, which are
// what a turn's agent works WITH. Kept apart from `credentials` because the two are narrowed for different reasons
// (whose allowance a person spends, against what they may touch) and because narrowing one must never empty the other:
// a reach listing no AI account would leave a person who runs agents unable to run any.
// An entry is `<provider>:<account>`, one account of a provider that holds accounts (its id as the provider's account
// list names it), or `<provider>` alone, every account of that provider including any connected later: how an API-key
// endpoint or an installed agent, which hold no accounts of their own, are named. Enforced where the daemon decides the
// account a turn runs on (agent/run/decide): a turn naming an account outside it is refused, one left to the sandbox's
// pick runs only on an account inside it, and a conversation remembering one outside it is moved onto one inside it.
// A conversation runs only on what every person who has written in it may, as with `credentials`.
export const AiAccountKeySchema = z.string().min(1).max(300);

/** The key an AI account is listed under: the provider alone for every account of it, else `provider:account`. */
export const aiAccountKey = (provider: string, account?: string): string => (account === undefined ? provider : `${provider}:${account}`);

/**
 * Whether a list of AI account keys lets a turn run on one account of a provider. `account` undefined asks about the
 * provider as a whole (one that holds no accounts of its own): only its own key answers yes then.
 */
export const aiAccountAllowed = (keys: Iterable<string>, provider: string, account: string | undefined): boolean => {
    const held = new Set(keys);
    return held.has(provider) || (account !== undefined && held.has(aiAccountKey(provider, account)));
};

// WHAT ONE PERSON MAY DO, as three independent answers rather than one rung of a ladder: whether their conversations
// run agents (`agents`), where they may look (`areas`, the fence their agents run inside too) and where they may change
// files by hand (`edit`), and whether they manage the sandbox (the maintainer tier, which implies every other answer).
// The `role` a row carries is the tier those answers make (`tierOf`), kept because the platform's invite record, the
// presence list and every route's floor read a tier; a row written before the answers existed reads as its role meant
// (`memberAccess`).
// `chat` is the guest's way of working: it talks to the assistants that work in its areas and is shown nothing else of
// the sandbox. `off` watches; `run` drives agents, whose work lands only when somebody who manages the sandbox lands it.
// `home` is the master view's way in, and the only one: the person talks to their own home conversation (an orchestrator
// that delegates, judges and merges for them) and is shown nothing else of the sandbox but what that conversation started.
// Whether its work lands by itself is `lands`, which is also whether they may land it: the agent never holds more.
export const AgentAccessSchema = z.enum(["off", "chat", "run", "home"]);
export type AgentAccess = z.infer<typeof AgentAccessSchema>;

// Where a person may change files by hand: every folder they may see, or the areas named (each one they may see too).
export const EditScopeSchema = z.union([z.literal("all"), z.array(z.string().min(1)).max(20)]);
export type EditScope = z.infer<typeof EditScopeSchema>;

/** A person's access resolved from their row: `see` undefined is the whole workspace, `edit` `none` changes nothing. */
export interface MemberAccess {
    readonly manage: boolean;
    readonly agents: AgentAccess;
    readonly see: readonly string[] | undefined;
    readonly edit: "none" | "all" | readonly string[];
    // A home-only person's answer to whether their home conversation lands what it accepts by itself, and so whether
    // they may land it (`landsHere`). Absent is no; only `agents: "home"` may carry it.
    readonly lands?: boolean | undefined;
    // The parts of the sandbox they run besides their own work (`ManageRightSchema`). Full access holds every one, so
    // its rows never list them; absent is none.
    readonly manages?: readonly ManageRight[] | undefined;
}

// The fields of a row or a grant that decide a person's access.
interface AccessFields {
    readonly role: GrantedRole;
    readonly areas?: readonly string[] | undefined;
    readonly agents?: AgentAccess | undefined;
    readonly edit?: EditScope | undefined;
    readonly lands?: boolean | undefined;
    readonly manages?: readonly ManageRight[] | undefined;
}

/** A row's access: what it says, and for a row written before `agents` and `edit` existed, what its role meant then. */
export const memberAccess = (row: AccessFields): MemberAccess => {
    if (row.role === "maintainer") {
        return { manage: true, agents: "run", see: undefined, edit: "all" };
    }
    const agents = row.agents ?? (row.role === "guest" ? "chat" : row.role === "viewer" ? "off" : "run");
    // A writer from before `edit` changes files where it sees them, which its areas always named.
    const edit = row.edit ?? (row.role === "writer" && row.areas !== undefined ? [...row.areas] : "none");
    const base: MemberAccess = { manage: false, agents, see: row.areas, edit: agents === "chat" || agents === "home" ? "none" : edit };
    const access = row.manages !== undefined && row.manages.length > 0 ? { ...base, manages: [...row.manages] } : base;
    return row.lands === true ? { ...access, lands: true } : access;
};

/**
 * Whether work done for this person lands by itself, and whether they may land it: one answer for both, so the agent that
 * works for them never holds an authority they do not. A maintainer lands everything; a home-only person their own home's
 * work when granted `lands`; anyone else asks a maintainer.
 */
export const landsHere = (access: Pick<MemberAccess, "manage" | "agents" | "lands">): boolean =>
    access.manage || (access.agents === "home" && access.lands === true);

/** The tier an access makes: what every route's floor, the platform's record and the presence list read. */
export const tierOf = (access: MemberAccess): GrantedRole => {
    if (access.manage) {
        return "maintainer";
    }
    if (access.agents === "chat" || access.agents === "home") {
        return "guest";
    }
    if (access.edit !== "none") {
        return "writer";
    }
    return access.agents === "run" ? "collaborator" : "viewer";
};

// Why a way of working cannot carry what else the access says: landing by itself, rights, areas and hand edits each
// belong to some ways of working only.
const workingRefusal = (access: MemberAccess): string | undefined => {
    if (access.lands === true && access.agents !== "home") {
        return "landing their own work by itself is a home-only answer; anyone else's work lands when somebody who manages the sandbox lands it";
    }
    if ((access.manages?.length ?? 0) > 0 && (access.agents === "chat" || access.agents === "home")) {
        return "running part of the sandbox needs someone who sees it: a person who only chats, or works through their home conversation, holds no rights";
    }
    if (access.agents === "chat" && (access.see?.length ?? 0) === 0) {
        return "chatting with assistants needs at least one area: the assistants that work there are the ones they talk to";
    }
    if (access.agents === "home" && access.edit !== "none") {
        return "a home-only person changes nothing by hand: their home conversation does the work";
    }
    return undefined;
};

// Why where a person edits by hand does not fit where they see.
const editRefusal = (access: MemberAccess): string | undefined => {
    if (access.edit === "all") {
        return access.see === undefined ? undefined : "editing everything they see needs the whole workspace; name the areas to edit instead";
    }
    if (access.edit === "none") {
        return undefined;
    }
    if (access.edit.length === 0) {
        return "editing needs at least one area to edit in";
    }
    const seen = access.see;
    const unseen = seen === undefined ? [] : access.edit.filter((area) => !seen.includes(area));
    return unseen.length === 0 ? undefined : `they can only edit where they can see: ${unseen.join(", ")} is not among their areas`;
};

/** Why an access cannot be granted on its face, before any area or assistant is looked up; undefined when it can. */
export const accessRefusal = (access: MemberAccess): string | undefined => (access.manage ? undefined : (workingRefusal(access) ?? editRefusal(access)));

// One person on the roster as the daemon answers it. `areas` fences what of the workspace they reach, and with it which
// assistants they may talk to: absent is the whole workspace, empty is nothing.
export const MemberSchema = z.object({
    email: z.string().describe("Who, lowercased."),
    role: GrantedRoleSchema.describe("The tier their access makes: maintainer when they manage the sandbox, else what `agents` and `edit` add up to."),
    areas: z.array(z.string()).optional().describe("The areas they may see, and their agents work in. Absent means the whole workspace."),
    agents: AgentAccessSchema.optional().describe(
        "Whether their conversations run agents: off (they watch), chat (only with the assistants in their areas, nothing else of the sandbox), run, or home (only their own home conversation, nothing else of the sandbox). Absent means what their role meant.",
    ),
    edit: EditScopeSchema.optional().describe(
        "Where they may change files by hand: everything they see, or these areas. Absent means nowhere, or for a writer its areas.",
    ),
    lands: z
        .boolean()
        .optional()
        .describe("For a home-only person: whether their home conversation lands its work by itself, and so whether they may land it. Absent means no."),
    emailSignIn: z
        .boolean()
        .optional()
        .describe("Whether they may sign in with an email code the platform confirmed, rather than only with Google or a passkey. Absent means no."),
    credentials: CredentialReachSchema.optional().describe(
        "The capabilities and secrets their conversations may spend. Absent means every one, including any connected later.",
    ),
    aiAccounts: z
        .array(AiAccountKeySchema)
        .max(500)
        .optional()
        .describe(
            "The AI accounts their conversations may run on, each `provider:account`, or a provider's id alone for every account of it (how an API-key endpoint is named). Absent means every one, including any connected later.",
        ),
    tools: ToolCeilingSchema.optional().describe(
        "The most their conversations' tools may be, shelf by shelf; a persona only narrows inside it. Absent means no limit.",
    ),
    assistants: z
        .array(entryId)
        .max(50)
        .optional()
        .describe(
            "For a guest who chats: which of the assistants working in their areas they may talk to, by persona id. Absent means every one that works there.",
        ),
    profile: entryId
        .optional()
        .describe(
            "The access profile their answers come from (docs/architecture/access.md). Its answers are written out on this row too, and saving the profile rewrites them. Absent means answers of their own.",
        ),
    manages: z
        .array(ManageRightSchema)
        .optional()
        .describe(
            "The parts of the sandbox they run besides their own work: people and access, secrets, the privacy shield, AI accounts of their own. Never on a maintainer, who runs every part. Absent means none.",
        ),
});
export type Member = z.infer<typeof MemberSchema>;

// What every roster write answers: the roster after it.
export const MembersListSchema = z.object({ members: z.array(MemberSchema) });
export type MembersList = z.infer<typeof MembersListSchema>;

// GET /members: the roster, plus the owner, an identity fact the roster file never holds. Absent before the first
// sign-in, on a loopback or test daemon.
export const MembersRosterSchema = MembersListSchema.extend({ owner: z.string().optional() });
export type MembersRoster = z.infer<typeof MembersRosterSchema>;

// POST /members: the role is required, the tier the grant makes. Areas are optional, their absence being the whole
// workspace; chatting with assistants needs them, since the assistants working there are the whole of that access.
// `emailSignIn` lets the platform's identity assertion open this sandbox for them (policy/identity-assertion.ts): true
// allows it, false takes it back, absent keeps what the row already says, so a re-grade from an editor that predates
// the field never drops it. `credentials` the same way: `all` lifts a reach, a list sets one, absent keeps the row's,
// so a re-grade that never mentions it can never widen what a person's conversations may spend. A maintainer may hold
// a list too: managing the sandbox and spending all of it are separate answers (docs/architecture/access.md).
// `agents` and `edit` decide the rest of the access; absent, the role's own meaning stands, so an editor that predates
// them still grants what it always did. `lands` is written as sent: absent is no, so a re-grade that never mentions it
// can never hand a home-only person's agent the authority to land. The role sent must be the tier the access makes (`tierOf`): two answers to one
// question are refused rather than one of them guessed away. `aiAccounts` reads as `credentials` does: `all` lifts it, a
// list sets it, absent keeps the row's, a maintainer's included. `tools` and `assistants` read the same way, except that
// a maintainer is refused a tool ceiling, since the tier runs every tool.
// `profile` names an access profile instead of answering on the row: the daemon writes that profile's answers out on
// the row and ignores the access fields sent beside it, and the role sent must still be the tier the profile makes.
// Absent is answers of the row's own, so a re-grade from an editor that predates profiles unlinks the row, keeping
// the answers it carried, rather than leaving a link the grant did not mean. A maintainer is refused one.
// `manages` reads as `credentials` does: a list sets the rights, `[]` takes them all back, absent keeps the row's, so a
// profile written over a row and a re-grade from an editor that predates rights keep what the person runs. A maintainer
// holds every right and stores none. Rights ride beside a profile, never in one: like Full access, running part of the
// sandbox is handed to a person, never through something shared.
export const MemberGrantSchema = z.object({
    email: z.string(),
    role: GrantedRoleSchema,
    areas: z.array(z.string().min(1)).max(20).optional(),
    agents: AgentAccessSchema.optional(),
    edit: EditScopeSchema.optional(),
    lands: z.boolean().optional(),
    emailSignIn: z.boolean().optional(),
    credentials: z.union([z.literal("all"), CredentialReachSchema]).optional(),
    aiAccounts: z.union([z.literal("all"), z.array(AiAccountKeySchema).max(500)]).optional(),
    tools: z.union([z.literal("all"), ToolCeilingSchema]).optional(),
    assistants: z.union([z.literal("all"), z.array(entryId).max(50)]).optional(),
    profile: entryId.optional(),
    manages: z.array(ManageRightSchema).max(10).optional(),
});
export type MemberGrant = z.infer<typeof MemberGrantSchema>;

// GET /members/self: what the signed-in person may do here, for an editor that offers only what will be taken. The
// owner reads as managing everything.
export const MemberSelfSchema = z.object({
    role: MemberRoleSchema.describe("Their tier on this sandbox."),
    agents: AgentAccessSchema.describe("Whether their conversations run agents."),
    areas: z.array(z.string()).optional().describe("The areas they may see. Absent means the whole workspace."),
    edit: z.union([z.literal("none"), EditScopeSchema]).describe("Where they may change files by hand."),
    lands: z
        .boolean()
        .optional()
        .describe("Whether work done for them lands by itself and they may land it: a maintainer's everywhere, a home-only person's on their home. Absent means no."),
    aiAccounts: z
        .array(AiAccountKeySchema)
        .optional()
        .describe("The AI accounts their conversations may run on, as the roster keys them, so a picker offers only those. Absent means every one."),
    tools: ToolCeilingSchema.optional().describe("The most their conversations' tools may be. Absent means no limit."),
    assistants: z.array(entryId).optional().describe("For a guest who chats: the assistants they may talk to. Absent means every one in their areas."),
    profile: entryId.optional().describe("The access profile their access comes from. Absent means answers of their own."),
    manages: z
        .array(ManageRightSchema)
        .optional()
        .describe("The parts of the sandbox they run besides their own work: every one for the owner and Full access. Absent means none."),
    askedAt: z
        .number()
        .int()
        .optional()
        .describe("When they asked the owner for more access, while that request is still open (POST /members/requests). Absent when they have not, or it was answered."),
});
export type MemberSelf = z.infer<typeof MemberSelfSchema>;

// ASKING FOR MORE ACCESS, from where the person was refused: the editor draws an "Ask for access" press on a place or an
// action their access refuses, and whoever runs people and access sees each open request beside the roster (Access ▸
// People), where granting the person what they asked for answers it. One open request per person: a later ask replaces
// theirs. `want` is what stood in the way, in the terms a grant answers: a tier (`viewer` is a guest asking to see more),
// running agents (`agents`), or a folder outside their areas (`areas`).
// `aiAccounts`: the AI accounts their turns may run on (`aiAccounts` on their row) leave them nothing to run on that they
// asked for, asked from a model picker with no model of theirs in it.
export const AccessWantSchema = z.enum(["viewer", "collaborator", "writer", "maintainer", "agents", "areas", "aiAccounts"]);
export type AccessWant = z.infer<typeof AccessWantSchema>;

// POST /members/requests: what the person asks for, and where they were when they asked.
export const AccessAskSchema = z.object({
    want: AccessWantSchema.describe("What stood in the way: a tier, running agents, or a folder outside their areas."),
    place: z.string().min(1).max(80).describe("Where they were, as that page or section is titled (\"Secrets\"), so the owner knows what it is for."),
});
export type AccessAsk = z.infer<typeof AccessAskSchema>;

export const AccessRequestSchema = AccessAskSchema.extend({
    email: z.string().describe("Who asked."),
    at: z.number().int().describe("When they asked, in ms since the epoch."),
});
export type AccessRequest = z.infer<typeof AccessRequestSchema>;

// GET /members/requests, and the answer to dismissing one: every open request, newest first.
export const AccessRequestsSchema = z.object({ requests: z.array(AccessRequestSchema) });
export type AccessRequests = z.infer<typeof AccessRequestsSchema>;

// DELETE /members: whose access to take back.
export const MemberEmailSchema = z.object({ email: z.string() });
