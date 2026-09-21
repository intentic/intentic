import type { MemberRole } from "@intentic/sandbox-contract";
import { contractRoutes, isAttachmentPath, roleAtLeast, routeNameForRequest, sandboxContract } from "@intentic/sandbox-contract";

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
    // Rendering one file as text is reading it, POST or not: what it writes is a cache entry under the state dir that
    // the CLI regenerates on demand, and what it costs is one parse of a file the caller may already read whole.
    "workspace.derive": "viewer",
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
    // Which card a first message belongs to: a read shaped as a POST because it costs one model call, which the tier
    // about to spend a whole turn may certainly spend. Refused, every new chat a collaborator opens reports that the
    // reading could not be made in time, which is not what happened.
    "personas.route": "collaborator",
    // Resuming is starting the same turn again (a spent allowance, an outage) with everything it originally carried;
    // without it a collaborator-driven automation gets stuck on the first refusal.
    // Auto-land is deliberately not here: arming it is a landing decision, and a collaborator's landings are only
    // requests.
    "agent.resume": "collaborator",
    "agents.breakPolicy": "collaborator",
    "agents.rename": "collaborator",
    "agents.seen": "collaborator",
    "agents.seenAll": "collaborator",
    "agents.archive": "collaborator",
    "agents.unarchive": "collaborator",
    "agents.requestLand": "collaborator",
    // Changing hands is driving, not shipping; the route itself decides whose hands may do it (agents/ownership.ts).
    "agents.assign": "collaborator",
    // The one write on the board below the driving tier: a mark carries the reader's own name and changes nothing
    // about the work, so it sits with presence rather than with rename and archive.
    "agents.react": "viewer",
    // A member's own device notifications.
    "push.subscribe": "collaborator",
    "push.unsubscribe": "collaborator",
    "push.test": "collaborator",
    // Changing files in the shared tree, the writer grant. Each of these resolves its path through `contained`
    // (workspace/workspace.routes.ts), which refuses anything outside the caller's fence — so lowering the floor here
    // widens who may write, never where. What ships the result (land, discard, push) stays at the maintainer default,
    // and so does everything that operates the tree rather than edits it: setup, install, addRepo, sync, startApp.
    "workspace.mkdir": "writer",
    "workspace.delete": "writer",
    "workspace.move": "writer",
    "workspace.copy": "writer",
    "workspace.extract": "writer",
    // Spend is the operator's reading, not the audience's.
    "system.usage": "maintainer",
};

// /workspace/upload is two acts wearing one address: an attachment lands at ATTACHMENTS_DIR (collaborator's grant), but
// any other target is editing the shared workspace like move/copy/delete (writer).
// `isAttachmentPath` folds `..` before matching since the path arrives in a caller-written query; a missing or
// non-attachment target gets the workspace floor, which is what keeps a traversal out of the attachments dir from
// buying the lower tier.
const uploadFloor = (target: string | undefined): MemberRole => (target !== undefined && isAttachmentPath(target) ? "collaborator" : "writer");

// The hand-written (non-contract) routes that sit below the mutation default.
const PATH_FLOORS: Readonly<Record<string, MemberRole>> = {
    // Minting is cheap: each upgrade floors its own redemption; terminal is maintainer, sign-in is owner.
    "/system/ws-ticket": "collaborator",
    // Desktop pairing: below maintainer is capped to port-mirror, so collaborators can mint a preview tunnel.
    "/system/sync/pair": "collaborator",
    // Dictating a message is writing one: the words never leave the box, and the tier that arms the model on
    // /speech/status (a viewer read) has to be able to use it.
    "/speech/transcribe": "collaborator",
    // Giving up one's own grant is reachable by every tier; the handler removes only the verified caller.
    "/members/self": "viewer",
    // One's own passkeys are identity, not power, like staying signed in; the policy and recovery routes keep the
    // mutation default and their own ownership gate.
    "/system/passkeys/register/options": "viewer",
    "/system/passkeys/register": "viewer",
};

// Removing a passkey by id: one's own is identity; the handler holds another member's to the owner.
const passkeyRemoval = /^\/system\/passkeys\/[^/]+$/;

const methodFloor = (method: string): MemberRole => (method === "GET" || method === "HEAD" ? "viewer" : "maintainer");

// What a desk member may call at all, by contract route name: signing in and being present, the chat it drives,
// the conversations it can see (each handler narrows to its own), the cards its areas reach, the reads a composer
// needs before it will send, and the workspace read-only. An allowlist rather than a floor, since a desk is below
// every tier: what is not named here is refused, so a route added later is closed to a desk until somebody decides
// otherwise.
// The workspace reads ride the same list as the rest because a desk is always fenced — the roster refuses a desk row
// that names no area (auth.ts MemberSchema) — so every route below applies that fence itself
// (workspace/layout/workspace-fence.ts) and none of them can answer with the whole tree.
const DESK_NAMES: ReadonlySet<string> = new Set([
    "system.info",
    "system.session",
    "system.events",
    "system.presence",
    "providers.list",
    "providers.models",
    "settings.get",
    "agent.run",
    "agent.attach",
    "agent.reply",
    "agent.steer",
    "agent.stop",
    "agent.resume",
    "agent.rewind",
    "agent.commands",
    "agent.refusals",
    "agents.list",
    "agents.archived",
    "agents.get",
    "agents.transcript",
    "agents.rename",
    "agents.seen",
    "agents.seenAll",
    "agents.react",
    "agents.archive",
    "agents.unarchive",
    "personas.list",
    "workspace.tree",
    "workspace.children",
    "workspace.file",
    "workspace.search",
    "workspace.resolve",
    "workspace.derived",
    "workspace.derive",
    "workspace.derivedStatus",
    "workspace.mediaTicket",
    "workspace.repos",
    "areas.list",
]);

// The hand-written routes a desk reaches: dictating a message, giving up its own access, its own passkeys, and the
// bytes behind the workspace reads above.
const DESK_PATHS: ReadonlySet<string> = new Set([
    "/speech/transcribe",
    "/speech/status",
    "/members/self",
    "/system/passkeys",
    "/system/passkeys/register/options",
    "/system/passkeys/register",
    "/workspace/raw",
    "/workspace/thumb",
    "/workspace/media",
]);

// The one refusal the bearer middleware hands a verified member: the tier a route wants, or a desk asking for a door
// not on its list. Undefined admits. `target` is the upload's `?path=`, the one route whose floor depends on where
// the bytes land.
export const memberRefusal = (
    caller: { readonly role: MemberRole; readonly areas?: readonly string[] | undefined },
    method: string,
    path: string,
    target?: string,
): { readonly error: string; readonly floor: MemberRole } | undefined => {
    if (caller.role === "desk") {
        return deskReach(method, path, target) ? undefined : { error: "not open to a desk member", floor: "viewer" };
    }
    const floor = routeFloor(method, path, target);
    return roleAtLeast(caller.role, floor) ? undefined : { error: `${floor} access required`, floor };
};

// Whether a desk member may reach this request at all. `target` is the upload's `?path=`: an attachment rides with
// the message it belongs to, and is the one byte-write a desk makes.
export const deskReach = (method: string, path: string, target?: string): boolean => {
    if (path === "/workspace/upload") {
        return target !== undefined && isAttachmentPath(target);
    }
    if (method === "DELETE" && passkeyRemoval.test(path)) {
        return true;
    }
    const name = routeNameForRequest(ROUTES, method, path);
    return name === undefined ? DESK_PATHS.has(path) : DESK_NAMES.has(name);
};

// `target` is the workspace path a byte-write addresses (upload's `?path=`); absent for every other route.
export const routeFloor = (method: string, path: string, target?: string): MemberRole => {
    const prefixed = PREFIX_FLOORS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (prefixed !== undefined) {
        return prefixed[1];
    }
    if (path === "/workspace/upload") {
        return uploadFloor(target);
    }
    if (method === "DELETE" && passkeyRemoval.test(path)) {
        return "viewer";
    }
    const name = routeNameForRequest(ROUTES, method, path);
    if (name !== undefined) {
        return NAME_FLOORS[name] ?? methodFloor(method);
    }
    return PATH_FLOORS[path] ?? methodFloor(method);
};
