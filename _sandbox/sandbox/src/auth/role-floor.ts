import type { MemberRole } from "@intentic/sandbox-contract";
import { contractRoutes, routeNameForRequest, sandboxContract } from "@intentic/sandbox-contract";

/* ROLE FLOORS, the minimum trust tier each route demands, in one table, consulted by the bearer middleware
 * right after the authorizer resolves the caller's role (auth.ts Caller).
 *
 * The tiers draw the product's three real fences rather than mirroring the nav: operating authority belongs to
 * maintainer and owner alike (credentials, landing, publishing, the raw terminal), driving agents is the
 * collaborator's whole grant, and everything below that is the viewer tier.
 *
 * The defaults are the part that matters: an unlisted read floors at viewer, an unlisted MUTATION floors at
 * maintainer, so forgetting to classify a new route can under-serve a collaborator but can never hand one a
 * new power. Only reads that are really the operator's (logs, usage) and the agent-driving mutations are named.
 *
 * These floors are a FLOOR, not the whole answer: operating routes also keep their in-route maintainer gates
 * where middleware-exempt access exists. Membership is the one owner-only surface. */

const ROUTES = contractRoutes(sandboxContract);

// Whole groups where even the READ belongs to a higher tier than the method default would give.
const PREFIX_FLOORS: readonly (readonly [string, MemberRole])[] = [
    // Credentials belong to the operating tier. Maintainer is the highest revokable grant and intentionally has
    // the owner's operating authority; ownership itself remains protected by the member-management gates.
    ["/secrets", "maintainer"],
    // Connected services join the operating tier (they name accounts and reach, the map of what this sandbox
    // can touch).
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
    /* Reporting that YOUR OWN page crashed. Below both defaults it would otherwise take: the `/logs` prefix is
     * maintainer because reading the daemon's diagnostics is the operator's business, and an unlisted mutation
     * floors at maintainer too. Neither applies to this one. The whole point is to hear from the browser that
     * just broke, a viewer's browser breaks exactly as often as an owner's, and a viewer cannot raise their own
     * role to tell anybody. Its blast radius is a capped append to a file of its own, plainly marked as a
     * browser's word (logs/logs.routes.ts `report`), which is a smaller grant than the reads above it. */
    "logs.report": "viewer",
    // Driving agents, the collaborator grant. Work stays on isolated branches; what leaves the sandbox
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
    // Chat attachments land here, part of driving an agent, not of editing the workspace.
    "/workspace/upload": "collaborator",
    // Minting is deliberately cheap: each WebSocket upgrade floors its OWN redemption (ws-tickets.ts),
    // the terminal at maintainer, the sign-in browser at owner.
    "/system/ws-ticket": "collaborator",
    // Desktop pairing: the handler caps anyone below maintainer to port-mirror, so collaborators can mint
    // a live-preview tunnel without touching the single-holder file-sync lock.
    "/system/sync/pair": "collaborator",
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
