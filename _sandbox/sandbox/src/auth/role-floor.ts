import type { MemberRole } from "@intentic/sandbox-contract";
import { contractRoutes, routeNameForRequest, sandboxContract } from "@intentic/sandbox-contract";

/* ROLE FLOORS — the minimum trust tier each route demands, in one table, consulted by the bearer middleware
 * right after the authorizer resolves the caller's role (auth.ts Caller).
 *
 * The tiers draw the product's three real fences rather than mirroring the nav: credentials never delegate
 * (secrets stay with the owner), what leaves the sandbox needs a maintainer (landing, publishing, the raw
 * terminal), and driving agents is the collaborator's whole grant. Everything below that — watching the fleet,
 * reading files and transcripts — is the viewer tier, safe to be generous with because it is attributed and
 * changes nothing.
 *
 * The defaults are the load-bearing part: an unlisted read floors at viewer, an unlisted MUTATION floors at
 * maintainer — so forgetting to classify a new route can under-serve a collaborator but can never hand one a
 * new power. Only reads that are really the operator's (logs, usage) and the agent-driving mutations are named.
 *
 * These floors are a FLOOR, not the whole answer: the owner-only routes (members, secrets reveal, control
 * tokens, environment approve, …) keep their in-route authorizeOwner gates — `owner` here would be redundant
 * with a gate that also has to exist for the middleware-exempt routes, so it is stated only where no in-route
 * gate exists. */

const ROUTES = contractRoutes(sandboxContract);

// Whole groups where even the READ belongs to a higher tier than the method default would give.
const PREFIX_FLOORS: readonly (readonly [string, MemberRole])[] = [
    // Secret VALUES never leave the owner (reveal already re-checks in-route); with roles, the names and the
    // inventory follow — a secrets surface that greets every invitee is an invitation to ask for the values.
    ["/secrets", "owner"],
    // Connected services: mutations were always owner-gated in-route; the configuration read joins the
    // operator tier (it names accounts and reach, the map of what this sandbox can touch).
    ["/capabilities", "maintainer"],
    // Daemon logs are the operator's diagnostic, not a stakeholder's feed.
    ["/logs", "maintainer"],
];

// Per-route floors where the method default is wrong, by contract route name (contract/routes.ts).
const NAME_FLOORS: Readonly<Record<string, MemberRole>> = {
    // Watching a live turn stream is reading, POST or not.
    "agent.attach": "viewer",
    // Staying signed in and appearing on the roster is identity, not power.
    "system.session": "viewer",
    "system.presence": "viewer",
    // Opening a media file in the workspace view is a read; the ticket is strictly narrower than the bearer.
    "workspace.mediaTicket": "viewer",
    // Driving agents — the collaborator grant. Work stays on isolated branches; what leaves the sandbox
    // (land, discard, purge, drafts, the terminal) stays at the maintainer default.
    "agent.run": "collaborator",
    "agent.reply": "collaborator",
    "agent.steer": "collaborator",
    "agent.stop": "collaborator",
    "agent.rewind": "collaborator",
    "agents.rename": "collaborator",
    "agents.seen": "collaborator",
    "agents.seenAll": "collaborator",
    "agents.archive": "collaborator",
    "agents.unarchive": "collaborator",
    "agents.requestLand": "collaborator",
    // A member's own device notifications.
    "push.subscribe": "collaborator",
    "push.unsubscribe": "collaborator",
    "push.test": "collaborator",
    // Spend is the operator's reading, not the audience's.
    "system.usage": "maintainer",
};

// The hand-written (non-contract) routes that sit below the mutation default.
const PATH_FLOORS: Readonly<Record<string, MemberRole>> = {
    // Chat attachments land here — part of driving an agent, not of editing the workspace.
    "/workspace/upload": "collaborator",
    // Minting is deliberately cheap: each WebSocket upgrade floors its OWN redemption (ws-tickets.ts) —
    // the terminal at maintainer, the sign-in browser at owner.
    "/system/ws-ticket": "collaborator",
    // Giving up one's own grant must be reachable by every granted tier. The handler can remove only the
    // verified caller, never another member or the owner.
    "/members/self": "viewer",
};

const methodFloor = (method: string): MemberRole => (method === "GET" || method === "HEAD" ? "viewer" : "maintainer");

export const routeFloor = (method: string, path: string): MemberRole => {
    const prefixed = PREFIX_FLOORS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (prefixed !== undefined) {
        return prefixed[1];
    }
    const name = routeNameForRequest(ROUTES, method, path);
    if (name !== undefined) {
        return NAME_FLOORS[name] ?? methodFloor(method);
    }
    return PATH_FLOORS[path] ?? methodFloor(method);
};
