import type { MemberRole } from "@intentic/sandbox-contract";
import { contractRoutes, isAttachmentPath, routeNameForRequest, sandboxContract } from "@intentic/sandbox-contract";

// Role floors: the minimum trust tier each route demands, one table, consulted by the bearer middleware right after the
// caller's role resolves.
// Defaults matter: an unlisted read floors at viewer, an unlisted mutation floors at maintainer, so a misclassified
// route can under-serve, never over-grant.
// A floor, not the whole answer: operating routes still keep their own in-route maintainer gates; membership stays
// owner-only.

const ROUTES = contractRoutes(sandboxContract);

// Whole groups where even the read belongs to a higher tier than the method default would give.
const PREFIX_FLOORS: readonly (readonly [string, MemberRole])[] = [
    // Credentials belong to the operating tier: maintainer is the highest revokable grant, short of owner.
    ["/secrets", "maintainer"],
    // Connected services join the operating tier: they name accounts and what this sandbox can reach.
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
    // Reporting your own page crashed sits below both defaults on purpose: a viewer's browser breaks as often as an
    // owner's, and they can't raise their own role to tell anyone.
    // Its blast radius is a capped append to its own file, a smaller grant than the reads above it.
    "logs.report": "viewer",
    // Driving agents, the collaborator grant.
    // What leaves the sandbox (land, discard, purge, approvals, terminal) stays at the maintainer default.
    "agent.run": "collaborator",
    "agent.reply": "collaborator",
    "agent.steer": "collaborator",
    "agent.stop": "collaborator",
    "agent.rewind": "collaborator",
    // Resuming is starting the same turn again (a spent allowance, an outage) with everything it originally carried;
    // without it a collaborator-driven automation gets stuck on the first refusal.
    // Auto-land is deliberately not here: arming it is a landing decision, and a collaborator's landings are only
    // requests.
    "agent.resume": "collaborator",
    "agents.resumeAfterOutage": "collaborator",
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

// /workspace/upload is two acts wearing one address: an attachment lands at ATTACHMENTS_DIR (collaborator's grant), but
// any other target is editing the shared workspace like move/copy/delete (maintainer).
// `isAttachmentPath` folds `..` before matching since the path arrives in a caller-written query; a missing or
// non-attachment target gets the workspace floor.
const uploadFloor = (target: string | undefined): MemberRole =>
    target !== undefined && isAttachmentPath(target) ? "collaborator" : "maintainer";

// The hand-written (non-contract) routes that sit below the mutation default.
const PATH_FLOORS: Readonly<Record<string, MemberRole>> = {
    // Minting is cheap: each upgrade floors its own redemption; terminal is maintainer, sign-in is owner.
    "/system/ws-ticket": "collaborator",
    // Desktop pairing: below maintainer is capped to port-mirror, so collaborators can mint a preview tunnel.
    "/system/sync/pair": "collaborator",
    // Giving up one's own grant is reachable by every tier; the handler removes only the verified caller.
    "/members/self": "viewer",
};

const methodFloor = (method: string): MemberRole => (method === "GET" || method === "HEAD" ? "viewer" : "maintainer");

// `target` is the workspace path a byte-write addresses (upload's `?path=`); absent for every other route.
export const routeFloor = (method: string, path: string, target?: string): MemberRole => {
    const prefixed = PREFIX_FLOORS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (prefixed !== undefined) {
        return prefixed[1];
    }
    if (path === "/workspace/upload") {
        return uploadFloor(target);
    }
    const name = routeNameForRequest(ROUTES, method, path);
    if (name !== undefined) {
        return NAME_FLOORS[name] ?? methodFloor(method);
    }
    return PATH_FLOORS[path] ?? methodFloor(method);
};
