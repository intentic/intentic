// members: the daemon's shared-access roster (GET/POST/DELETE /members), who besides the owner reaches this sandbox
import { z } from "zod";
import type { CapabilityKind } from "./capabilities.js";
import { type GrantedRole, GrantedRoleSchema, MemberRoleSchema } from "./shared.js";

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

// WHAT ONE PERSON MAY DO, as three independent answers rather than one rung of a ladder: whether their conversations
// run agents (`agents`), where they may look (`areas`, the fence their agents run inside too) and where they may change
// files by hand (`edit`), and whether they manage the sandbox (the maintainer tier, which implies every other answer).
// The `role` a row carries is the tier those answers make (`tierOf`), kept because the platform's invite record, the
// presence list and every route's floor read a tier; a row written before the answers existed reads as its role meant
// (`memberAccess`).
// `chat` is the guest's way of working: it talks to the assistants that work in its areas and is shown nothing else of
// the sandbox. `off` watches; `run` drives agents, whose work lands only when somebody who manages the sandbox lands it.
export const AgentAccessSchema = z.enum(["off", "chat", "run"]);
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
}

// The fields of a row or a grant that decide a person's access.
interface AccessFields {
    readonly role: GrantedRole;
    readonly areas?: readonly string[] | undefined;
    readonly agents?: AgentAccess | undefined;
    readonly edit?: EditScope | undefined;
}

/** A row's access: what it says, and for a row written before `agents` and `edit` existed, what its role meant then. */
export const memberAccess = (row: AccessFields): MemberAccess => {
    if (row.role === "maintainer") {
        return { manage: true, agents: "run", see: undefined, edit: "all" };
    }
    const agents = row.agents ?? (row.role === "guest" ? "chat" : row.role === "viewer" ? "off" : "run");
    // A writer from before `edit` changes files where it sees them, which its areas always named.
    const edit = row.edit ?? (row.role === "writer" && row.areas !== undefined ? [...row.areas] : "none");
    return { manage: false, agents, see: row.areas, edit: agents === "chat" ? "none" : edit };
};

/** The tier an access makes: what every route's floor, the platform's record and the presence list read. */
export const tierOf = (access: MemberAccess): GrantedRole => {
    if (access.manage) {
        return "maintainer";
    }
    if (access.agents === "chat") {
        return "guest";
    }
    if (access.edit !== "none") {
        return "writer";
    }
    return access.agents === "run" ? "collaborator" : "viewer";
};

/** Why an access cannot be granted on its face, before any area or assistant is looked up; undefined when it can. */
export const accessRefusal = (access: MemberAccess): string | undefined => {
    if (access.manage) {
        return undefined;
    }
    if (access.agents === "chat" && (access.see?.length ?? 0) === 0) {
        return "chatting with assistants needs at least one area: the assistants that work there are the ones they talk to";
    }
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

// One person on the roster as the daemon answers it. `areas` fences what of the workspace they reach, and with it which
// assistants they may talk to: absent is the whole workspace, empty is nothing.
export const MemberSchema = z.object({
    email: z.string().describe("Who, lowercased."),
    role: GrantedRoleSchema.describe("The tier their access makes: maintainer when they manage the sandbox, else what `agents` and `edit` add up to."),
    areas: z.array(z.string()).optional().describe("The areas they may see, and their agents work in. Absent means the whole workspace."),
    agents: AgentAccessSchema.optional().describe(
        "Whether their conversations run agents: off (they watch), chat (only with the assistants in their areas, nothing else of the sandbox), or run. Absent means what their role meant.",
    ),
    edit: EditScopeSchema.optional().describe(
        "Where they may change files by hand: everything they see, or these areas. Absent means nowhere, or for a writer its areas.",
    ),
    emailSignIn: z
        .boolean()
        .optional()
        .describe("Whether they may sign in with an email code the platform confirmed, rather than only with Google or a passkey. Absent means no."),
    credentials: CredentialReachSchema.optional().describe(
        "The capabilities and secrets their conversations may spend. Absent means every one, including any connected later.",
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
// so a re-grade that never mentions it can never widen what a person's conversations may spend. A maintainer is refused
// a list: that tier reads every credential.
// `agents` and `edit` decide the rest of the access; absent, the role's own meaning stands, so an editor that predates
// them still grants what it always did. The role sent must be the tier the access makes (`tierOf`): two answers to one
// question are refused rather than one of them guessed away.
export const MemberGrantSchema = z.object({
    email: z.string(),
    role: GrantedRoleSchema,
    areas: z.array(z.string().min(1)).max(20).optional(),
    agents: AgentAccessSchema.optional(),
    edit: EditScopeSchema.optional(),
    emailSignIn: z.boolean().optional(),
    credentials: z.union([z.literal("all"), CredentialReachSchema]).optional(),
});
export type MemberGrant = z.infer<typeof MemberGrantSchema>;

// GET /members/self: what the signed-in person may do here, for an editor that offers only what will be taken. The
// owner reads as managing everything.
export const MemberSelfSchema = z.object({
    role: MemberRoleSchema.describe("Their tier on this sandbox."),
    agents: AgentAccessSchema.describe("Whether their conversations run agents."),
    areas: z.array(z.string()).optional().describe("The areas they may see. Absent means the whole workspace."),
    edit: z.union([z.literal("none"), EditScopeSchema]).describe("Where they may change files by hand."),
});
export type MemberSelf = z.infer<typeof MemberSelfSchema>;

// DELETE /members: whose access to take back.
export const MemberEmailSchema = z.object({ email: z.string() });
