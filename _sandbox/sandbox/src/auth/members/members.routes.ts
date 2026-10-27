import { noteAudit } from "../../audit/audit-http.js";
import {
    AccessAskSchema,
    accessRefusal,
    type AgentAccess,
    type CredentialReach,
    type EditScope,
    type MemberSelf,
    MemberGrantSchema,
    memberAccess,
    tierOf,
} from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole } from "@intentic/sandbox-contract/schemas/shared";
import { orgMembersOnlyRefusal } from "@intentic/sandbox-contract/policy/org-locks";
import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { assistantsRefusal, type PersonaReachDeps, reachablePersonas } from "../../personas/persona-reach.js";
import { profileGrant } from "../../access/profile-grant.js";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { ownershipDenied, unavailableIfUnreadable } from "../owner-gates.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { orgAdmits } from "../../org/org-roster.js";
import { revokeHeld } from "./revoke-held.js";
import { callerLands } from "../operator.js";
import { opt } from "../../opt.js";
import { publishRuntimeChange } from "../../seams/runtime-feed.js";

// The shared-access roster (/members): who besides the owner may reach this sandbox, and at what tier.
// Owner-gated by ownership rather than the maintainer-equivalent operating gate, since membership is the one thing a
// revokable grant must not change.

export type MembersRoutesDeps = Pick<Services, "auth" | "members" | "ownerEmail" | "wsTickets" | "mediaTickets" | "personas" | "areas"> &
    Partial<Pick<Services, "orgPolicy" | "accessProfiles" | "accessRequests">>;

// A person's request for more access was answered or withdrawn: by a grant, a removal, or the owner dismissing it. The
// owner's list and the asker's "asked" move with it.
const settleRequest = async (services: MembersRoutesDeps, email: string): Promise<void> => {
    if (services.accessRequests === undefined || (await services.accessRequests.of(email)) === undefined) {
        return;
    }
    await services.accessRequests.settle(email);
    publishRuntimeChange("access-requests");
};

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
};

// A grant request's email + role + the areas it is fenced to (the contract's MemberGrantSchema), or undefined if any is
// missing or malformed. Role is required: a grant is a role decision, and a default here would be a policy nobody
// chose. Areas are optional, and their absence is the whole workspace — which is also every assistant, since which
// cards a person may wear is read off their fence (personas/persona-reach.ts) rather than listed per person.
// `emailSignIn` lets the platform's identity assertion open this sandbox for them; absent keeps what their row says.
const memberGrant = async (c: Context): Promise<MemberGrantRequest | undefined> => {
    const body = MemberGrantSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
        return undefined;
    }
    const { email, role, areas, agents, edit, lands, emailSignIn, credentials, aiAccounts, tools, assistants, profile } = body.data;
    return { email: email.toLowerCase(), role, areas, agents, edit, lands, emailSignIn, credentials, aiAccounts, tools, assistants, profile };
};

// A grant as the route reads it: who, at what tier, fenced to what, whether email sign-in is theirs, what their
// conversations may spend and which AI accounts they run on (absent: what their row already says).
interface MemberGrantRequest {
    readonly email: string;
    readonly role: GrantedRole;
    readonly areas?: readonly string[] | undefined;
    readonly agents?: AgentAccess | undefined;
    readonly edit?: EditScope | undefined;
    readonly lands?: boolean | undefined;
    readonly emailSignIn?: boolean | undefined;
    readonly credentials?: CredentialReach | "all" | undefined;
    readonly aiAccounts?: readonly string[] | "all" | undefined;
    readonly tools?: ToolCeiling | "all" | undefined;
    readonly assistants?: readonly string[] | "all" | undefined;
    readonly profile?: string | undefined;
}

// What the audit trail keeps of a grant: the tier it made and the one it replaced, and the shape of the fence (area ids
// are the owner's own names, no personal data), never the credentials it lists.
const grantDetails = (grant: MemberGrantRequest, previous: GrantedRole | undefined) => ({
    role: grant.role,
    previousRole: previous ?? "none",
    areas: grant.areas ?? "all",
    ...opt("home", grant.agents === "home" ? (grant.lands === true ? "lands" : "asks") : undefined),
    ...opt("profile", grant.profile),
});

// The refusals an access makes on its face, in the order a reader fixes them: a writer named with nowhere to write (what
// an editor that predates `edit` sends), an access no grant could make (chatting with no area, editing outside what they
// see), and a role that is not the tier the access makes. For each, the grant is refused rather than one of its two
// answers guessed away: an absent area list resolves to the whole workspace, which is not a narrower grant of a tier
// but a different one nobody chose.
const accessRefused = (grant: MemberGrantRequest): string | undefined => {
    const access = memberAccess(grant);
    if (grant.role === "writer" && access.edit === "none") {
        return "a writer needs at least one area to write in";
    }
    if (grant.role === "guest" && access.agents === "chat" && (grant.areas?.length ?? 0) === 0) {
        return "a guest needs at least one area: the assistants that work there are the ones it speaks through";
    }
    const refused = accessRefusal(access);
    if (refused !== undefined) {
        return refused;
    }
    const tier = tierOf(access);
    return tier === grant.role ? undefined : `the role does not match the access granted, which makes a ${tier}`;
};

// Why a fence cannot be written, or undefined when it can. Every area named exists, since a row pointing at an area
// nobody wrote resolves to a fence admitting nothing, and somebody would have to guess whether that was intended.
// A maintainer is not fenceable: the tier carries the owner's operating authority, reads every credential and drives
// every conversation, so a folder fence over it would be a line on a screen rather than a boundary.
const areaRefusal = async (services: Pick<Services, "areas">, grant: MemberGrantRequest): Promise<string | undefined> => {
    const editing = grant.edit === undefined || grant.edit === "all" ? [] : grant.edit;
    if (grant.areas === undefined && editing.length === 0) {
        return undefined;
    }
    if (grant.role === "maintainer") {
        return "a maintainer holds the owner's operating authority and cannot be fenced to part of the workspace";
    }
    const known = new Set((await services.areas.list()).map((area) => area.id));
    const missing = [...new Set([...(grant.areas ?? []), ...editing])].filter((id) => !known.has(id));
    return missing.length === 0 ? undefined : `no such area: ${missing.join(", ")}`;
};

// A maintainer operates the box as the owner does, which is granted to a person and never through a shared profile, and
// runs every tool. What its conversations spend is another matter: the AI accounts its turns run on and the connections
// and secrets its agents use may be narrowed like anyone's (docs/architecture/access.md), so a person can manage every
// setting while paying only with the accounts they were given. Those lists hold every turn worked for them; a terminal,
// which a maintainer keeps, still reaches the whole box, so they are a rule for people trusted to operate it.
const reachRefusal = (grant: Pick<MemberGrantRequest, "role" | "tools" | "profile">): string | undefined => {
    if (grant.role !== "maintainer") {
        return undefined;
    }
    if (grant.profile !== undefined) {
        return "a maintainer holds the owner's operating authority, which is granted to a person and never through a shared access profile";
    }
    return grant.tools !== undefined && grant.tools !== "all"
        ? "a maintainer holds the owner's operating authority and runs every tool, so its tools cannot be limited"
        : undefined;
};

// A grant naming a profile, read as the grant that profile writes (access/profile-grant.ts): its answers replace the
// ones sent beside it, so a row holding a profile always says what the profile says. The role sent must still be the
// tier the profile makes, as any grant's must, so a client never grants a tier it did not mean.
const resolvedGrant = async (
    services: MembersRoutesDeps,
    grant: MemberGrantRequest,
): Promise<{ readonly grant: MemberGrantRequest } | { readonly refusal: string }> => {
    if (grant.profile === undefined || grant.role === "maintainer") {
        return { grant };
    }
    const profile = await services.accessProfiles?.get(grant.profile);
    if (profile === undefined) {
        return { refusal: `no such access profile: ${grant.profile}` };
    }
    const written = profileGrant(profile);
    if (written.role !== grant.role) {
        return { refusal: `the role does not match the access profile "${profile.label ?? profile.id}", which makes a ${written.role}` };
    }
    return { grant: { ...written, email: grant.email, emailSignIn: grant.emailSignIn } };
};

// Why a guest's fence cannot be granted even though its areas exist: no card works in the folders it names. A guest
// reaches nothing but its assistants, so such a grant would sign somebody in to a chat that answers nothing.
// Checked only for a chatting guest: every other tier, and a home-only guest whose home is the one it talks to, has
// business in a workspace with no card homed in its folders.
const guestReachRefusal = async (services: PersonaReachDeps, grant: MemberGrantRequest): Promise<string | undefined> => {
    const listed = grant.assistants === "all" ? undefined : grant.assistants;
    const assistants = await assistantsRefusal(services, grant.areas, listed);
    if (assistants !== undefined) {
        return assistants;
    }
    if (grant.role !== "guest" || memberAccess(grant).agents !== "chat") {
        return undefined;
    }
    const reached = await reachablePersonas(services, grant.areas, listed);
    return reached.length > 0
        ? undefined
        : "no assistant works in those areas, so a guest fenced to them would have nobody to talk to; give an assistant a starting folder inside one, or fence the guest to an area that already has one";
};


// The roster row's answers that ride on a person's own: the AI accounts, the tool ceiling, the assistants, the profile.
type RosterRow = Awaited<ReturnType<Services["members"]["list"]>>[number];
const withRowFacts = (self: MemberSelf, row: RosterRow | undefined): void => {
    if (row?.aiAccounts !== undefined) {
        self.aiAccounts = [...row.aiAccounts];
    }
    if (row?.tools !== undefined) {
        self.tools = { ...row.tools };
    }
    if (row?.assistants !== undefined) {
        self.assistants = [...row.assistants];
    }
    if (row?.profile !== undefined) {
        self.profile = row.profile;
    }
};

// GET /members/self: what the signed-in person may do here, as the request's own identity carries it; the owner, and a
// caller the sandbox cannot name (loopback, a panel), manage everything. The AI accounts are read off the roster rather
// than the identity, which carries only what a route's floor reads; a roster that cannot be read leaves them out, and
// the turn's own planning still refuses what is not theirs. Whether they have asked the owner for more rides along, so
// the editor draws "asked" rather than offering the ask again.
const selfAccess = async (services: Pick<MembersRoutesDeps, "members" | "accessRequests">, c: Context<AppEnv>): Promise<Response> => {
    const identity = c.get("identity");
    if (identity === undefined || identity.role === "owner") {
        return c.json({ role: identity?.role ?? "owner", agents: "run", edit: "all", lands: true } satisfies MemberSelf);
    }
    const edits = identity.edits ?? "all";
    const self: MemberSelf = { role: identity.role, agents: identity.agents ?? "run", edit: edits === "all" || edits === "none" ? edits : [...edits] };
    if (callerLands(identity)) {
        self.lands = true;
    }
    if (identity.areas !== undefined) {
        self.areas = [...identity.areas];
    }
    const email = identity.email.toLowerCase();
    // allow(silent-catch): the list is a picker's courtesy; planning reads the roster again and refuses on its own.
    withRowFacts(self, (await services.members.list().catch(() => [])).find((member) => member.email.toLowerCase() === email));
    // allow(silent-catch): an unreadable request file costs the person only the "asked" mark, never their access answer.
    const asked = await services.accessRequests?.of(email).catch(() => undefined);
    if (asked !== undefined) {
        self.askedAt = asked.at;
    }
    return c.json(self);
};

// A roster this build cannot read is refused rather than replaced (auth.ts `fileMembersStore`), so a grant or a removal
// over it answers 503 (`unavailableIfUnreadable`) and leaves every socket and ticket as it was.
const createMembersRoutes = (services: MembersRoutesDeps) => ({
    /** GET /members */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        // The owner rides along here since ownership is an identity fact the members file never holds; without it no
        // approver list could name the owner.
        // Undefined before first sign-in reads as a roster with no owner yet, not an error (loopback and test daemons).
        const owner = await services.ownerEmail();
        return c.json({ members: await services.members.list(), ...(owner !== undefined ? { owner } : {}) });
    },
    /** POST /members */
    add: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const asked = await memberGrant(c);
        if (asked === undefined) {
            return c.json({ error: "email and role required" }, 400);
        }
        const resolved = await resolvedGrant(services, asked);
        if ("refusal" in resolved) {
            return c.json({ error: resolved.refusal }, 400);
        }
        const { grant } = resolved;
        // The free refusal first, then the two that read a manifest; reach last, since it needs both of them.
        const refusal = accessRefused(grant) ?? reachRefusal(grant) ?? (await areaRefusal(services, grant)) ?? (await guestReachRefusal(services, grant));
        if (refusal !== undefined) {
            return c.json({ error: refusal }, 400);
        }
        // A bound sandbox whose organisation keeps it to its own people grants nobody else (org/org-roster.ts): the
        // grant would be written and then never read, so it is refused where the owner can see why.
        const policy = await services.orgPolicy?.current();
        if (policy !== undefined && !orgAdmits(policy, grant.email)) {
            return c.json(orgMembersOnlyRefusal(policy), 403);
        }
        return unavailableIfUnreadable(c, async () => {
            const before = (await services.members.list()).find((member) => member.email === grant.email.toLowerCase());
            await services.members.add(grant.email, grant);
            noteAudit({ target: grant.email.toLowerCase(), details: grantDetails(grant, before?.role) });
            // Granting the person anything is the owner's answer to what they asked, whatever they asked.
            await settleRequest(services, grant.email);
            // A role is frozen into an open socket/ticket; closing both re-enters the authorizer with the new tier. A media
            // ticket names a file the new tier may no longer reach.
            revokeHeld(services, grant.email);
            return c.json({ members: await services.members.list() });
        });
    },
    /** DELETE /members */
    remove: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        return unavailableIfUnreadable(c, async () => {
            await services.members.remove(email);
            noteAudit({ target: email.toLowerCase() });
            await settleRequest(services, email);
            revokeHeld(services, email);
            return c.json({ members: await services.members.list() });
        });
    },
    /** GET /members/self */
    self: (c: Context<AppEnv>): Promise<Response> => selfAccess(services, c),
    /** DELETE /members/self */
    removeSelf: async (c: Context<AppEnv>): Promise<Response> => {
        const identity = c.get("identity");
        if (identity === undefined) {
            return c.json({ error: "verified member required" }, 401);
        }
        if (identity.role === "owner") {
            return c.json({ error: "the owner must retire the sandbox instead" }, 400);
        }
        // Normalized: the roster holds lowercase, but identity carries Google's claim as sent; raw form hits no row.
        return unavailableIfUnreadable(c, async () => {
            await services.members.remove(identity.email.toLowerCase());
            await settleRequest(services, identity.email);
            revokeHeld(services, identity.email);
            return c.json({ ok: true });
        });
    },
});

// What people on the roster ask the owner for, and the owner's list of it (members/access-requests.ts). Asking is every
// member's own, a guest's included; reading and dismissing is ownership's, beside the roster a grant answers them on.
const createRequestRoutes = (services: MembersRoutesDeps) => ({
    /** POST /members/requests */
    ask: async (c: Context<AppEnv>): Promise<Response> => {
        const identity = c.get("identity");
        if (identity === undefined) {
            return c.json({ error: "verified member required" }, 401);
        }
        if (identity.role === "owner") {
            return c.json({ error: "the owner already holds every access here" }, 400);
        }
        // allow(silent-catch): a body that is not JSON is refused below as one that says nothing, which it is.
        const asked = AccessAskSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!asked.success) {
            return c.json({ error: "say what you are asking for, and where you were" }, 400);
        }
        if (services.accessRequests === undefined) {
            return c.json({ error: "this sandbox cannot take requests for access" }, 503);
        }
        await services.accessRequests.ask(identity.email, asked.data, Date.now());
        publishRuntimeChange("access-requests");
        return selfAccess(services, c);
    },
    /** GET /members/requests */
    list: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ requests: (await services.accessRequests?.list()) ?? [] });
    },
    /** DELETE /members/requests */
    dismiss: async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await settleRequest(services, email);
        return c.json({ requests: (await services.accessRequests?.list()) ?? [] });
    },
});

// Shared-access roster, gated by ownership rather than the operating gate other privileged routes use.
export const membersRawRoutes = defineRawRoutes((services: MembersRoutesDeps) => {
    const members = createMembersRoutes(services);
    const requests = createRequestRoutes(services);
    return {
        "GET /members": members.list,
        "POST /members": members.add,
        "DELETE /members": members.remove,
        "DELETE /members/self": members.removeSelf,
        "GET /members/self": members.self,
        "POST /members/requests": requests.ask,
        "GET /members/requests": requests.list,
        "DELETE /members/requests": requests.dismiss,
    };
});
