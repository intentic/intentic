// members: the daemon's shared-access roster (GET/POST/DELETE /members), who besides the owner reaches this sandbox
import { z } from "zod";
import type { CapabilityKind } from "./capabilities.js";
import { GrantedRoleSchema } from "./shared.js";

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
];

// One person on the roster as the daemon answers it. `areas` fences what of the workspace they reach, and with it which
// assistants they may talk to: absent is the whole workspace, empty is nothing.
export const MemberSchema = z.object({
    email: z.string().describe("Who, lowercased."),
    role: GrantedRoleSchema.describe("The tier they were granted."),
    areas: z.array(z.string()).optional().describe("The areas they are fenced to. Absent means the whole workspace."),
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

// POST /members: a grant is a role decision, so the role is required. Areas are optional, their absence being the whole
// workspace; a writer and a guest are refused without them, since for those two tiers the fence is the tier.
// `emailSignIn` lets the platform's identity assertion open this sandbox for them (policy/identity-assertion.ts): true
// allows it, false takes it back, absent keeps what the row already says, so a re-grade from an editor that predates
// the field never drops it. `credentials` the same way: `all` lifts a reach, a list sets one, absent keeps the row's,
// so a re-grade that never mentions it can never widen what a person's conversations may spend. A maintainer is refused
// a list: that tier reads every credential.
export const MemberGrantSchema = z.object({
    email: z.string(),
    role: GrantedRoleSchema,
    areas: z.array(z.string().min(1)).max(20).optional(),
    emailSignIn: z.boolean().optional(),
    credentials: z.union([z.literal("all"), CredentialReachSchema]).optional(),
});
export type MemberGrant = z.infer<typeof MemberGrantSchema>;

// DELETE /members: whose access to take back.
export const MemberEmailSchema = z.object({ email: z.string() });
