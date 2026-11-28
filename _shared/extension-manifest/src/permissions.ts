/* The sandbox-route permission model. */

// An entry is "<METHOD> <path-glob>": an HTTP method, then an absolute path whose segments are each literal or a lone
// `*`. A `*` matches exactly one segment, and never a dot segment (`.` or `..`, percent-encoded or not) or one holding a
// backslash, since the URL layer resolves those away before any route sees them: `POST /panels/*/start` must not reach
// `/panels/../start`, which is `/start`. A `**` or a `*` inside a segment is refused rather than read in some way its
// author did not mean.

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/iu;

interface CompiledRoute {
    readonly method: string;
    // Each segment of the glob after its leading slash, undefined for a `*`.
    readonly segments: readonly (string | undefined)[];
}

// Why a glob segment cannot be declared, or undefined when it can.
const segmentProblem = (segment: string): string | undefined => {
    if (segment.includes("*") && segment !== "*") {
        return `"${segment}" is not a segment glob: a \`*\` stands alone between slashes and matches one whole segment, so \`**\` and a \`*\` inside a segment are not supported`;
    }
    if (DOT_SEGMENT.test(segment)) {
        return `"${segment}" is not a route segment: the URL resolves it away before any route sees it`;
    }
    return undefined;
};

// Why the entry is malformed, or undefined when it is well formed.
const syntaxProblem = (method: string, glob: string): string | undefined => {
    if (glob === "") {
        return `expected "<METHOD> <path-glob>", e.g. "GET /panels"`;
    }
    if (!METHODS.has(method.toUpperCase())) {
        return `"${method}" is not one of ${[...METHODS].join(", ")}`;
    }
    if (!glob.startsWith("/")) {
        return `the path must start with "/"`;
    }
    if (/[?#\\]/u.test(glob)) {
        return `the path may not hold "?", "#" or "\\": routes are matched on the path alone`;
    }
    return glob.slice(1).split("/").map(segmentProblem).find((found) => found !== undefined);
};

interface Entry {
    readonly method: string;
    readonly glob: string;
}

const split = (entry: string): Entry => {
    const [, method = "", glob = ""] = /^(\S+)\s+(\S+)$/u.exec(entry.trim()) ?? [];
    return { method, glob };
};

// Why `entry` is not a permission, as the message a manifest parse reports, or undefined when it is one.
export const permissionProblem = (entry: string): string | undefined => {
    const { method, glob } = split(entry);
    const problem = syntaxProblem(method, glob);
    return problem === undefined ? undefined : `invalid permission "${entry}": ${problem}`;
};

// The entry as a method and its glob's segments. Throws on a malformed one; the manifest parse refuses that first
// (manifest.ts), so this only fires on a list that never went through it.
const compile = (entry: string): CompiledRoute => {
    const problem = permissionProblem(entry);
    if (problem !== undefined) {
        throw new Error(problem);
    }
    const { method, glob } = split(entry);
    return { method: method.toUpperCase(), segments: glob.slice(1).split("/").map((segment) => (segment === "*" ? undefined : segment)) };
};

const segmentMatches = (glob: string | undefined, segment: string): boolean =>
    glob === undefined ? segment !== "" && !segment.includes("\\") && !DOT_SEGMENT.test(segment) : glob === segment;

// Whether `method path` is covered by any of the declared permissions. The query string is ignored (routes are
// matched on path only), and the method is compared case-insensitively.
export const sandboxRouteAllowed = (permissions: readonly string[], method: string, path: string): boolean => {
    const route = path.split("?")[0] ?? path;
    const wanted = method.toUpperCase();
    const segments = route.startsWith("/") ? route.slice(1).split("/") : [];
    return permissions.some((entry) => {
        const compiled = compile(entry);
        return (
            compiled.method === wanted &&
            compiled.segments.length === segments.length &&
            compiled.segments.every((glob, index) => segmentMatches(glob, segments[index] ?? ""))
        );
    });
};

// The routes every extension's own token reaches without listing them in `permissions.daemon`: what the host tells an
// extension about itself, its own settings (secrets included) and its own event stream, and the two doors the rest of
// its `permissions` open, holding work in flight (`work`) and running a command under a workload class (`exec`). Each
// answers only about the extension asking, and a door checks its own declaration, so listing them would grant nothing
// a reviewer could weigh.
// (2026-11-26) And the doors an agent tool's call opens onto the turn that made it (`permissions.turn`): each answers only
// a call ticket the daemon minted for that extension's own tool call, or a job that call started.
export const EXTENSION_OWN_ROUTES: readonly string[] = [
    "GET /extension/settings",
    "GET /extension/events",
    "POST /extension/work/hold",
    "POST /extension/exec",
    "POST /extension/turn/browser",
    "POST /extension/turn/owner-browser",
    "POST /extension/jobs",
    "POST /extension/jobs/*",
    // (2026-11-26) A row in the sandbox's activity feed, written as the extension's own.
    "POST /extension/activity",
    // (2026-11-27) Hosted sleep: its own `wakes` routes' URLs, what this boot follows, and the before-sleep watch.
    "POST /extension/sleep/wake-url",
    "GET /extension/sleep/boot",
    "POST /extension/sleep/watch",
    "POST /extension/sleep/ready",
    // (2026-11-27) What the platform's sleep watch heard for its own connections while the sandbox slept.
    "POST /extension/sleep/heard",
    // (2026-11-28) This sandbox's public identity document, and a signature as this sandbox over a record of the
    // extension's own, which the door refuses unless `permissions.identity` declares `sign`.
    "GET /extension/identity",
    "POST /extension/identity/sign",
];

// (2026-11-26) What an extension's own code may hear, hold and run beyond its routes, each a power its manifest declares
// under `permissions` and the daemon refuses undeclared (core-and-extensions.md, the gaps these close). Kept here, free
// of zod, since the contract's extension protocol and the SDK's runtime read the same words.

// Events a backend hears only by declaring them (`permissions.events`): `run`, a run ending in a conversation the
// extension itself started through POST /agent with its own token; `activity`, whether any agent turn runs in the
// sandbox; (2026-11-26) `ci`, each frame of the CI feed, a run that finished or a job that ended as the forges report
// them. Its settings and the workspace's file, ref and repository changes need no declaration.
export const EXTENSION_DECLARED_EVENTS = ["run", "activity", "ci"] as const;
export type ExtensionDeclaredEvent = (typeof EXTENSION_DECLARED_EVENTS)[number];

// The workload classes `api.exec` runs a command under (`permissions.exec`): `command`, admitted and ranked as an agent's
// shell command is; `toolchain`, a heavy tool (a build, a test run, an analyser over a repository), which also takes a
// slot in the sandbox's heavy-command queue, taking turns with every agent's builds.
export const EXTENSION_EXEC_CLASSES = ["command", "toolchain"] as const;
export type ExtensionExecClass = (typeof EXTENSION_EXEC_CLASSES)[number];

// A handler an automation may fire (`permissions.fires`): a lowercase word, as the automation's target names it.
export const EXTENSION_FIRE_HANDLER = /^[a-z0-9][a-z0-9-]{0,63}$/u;

// (2026-11-26) What an extension's agent tools may do with the grants of the turn that calls them (`permissions.turn`):
// `browser`, drive the sandbox's signed-in browser of an account the turn holds, on that account's own sites;
// `owner-browser`, call the owner's own browser when the turn holds it; `jobs`, start a background job in the calling
// conversation that the agent collects with `wait`. Never more than the turn holds, whatever is declared.
export const EXTENSION_TURN_POWERS = ["browser", "owner-browser", "jobs"] as const;
export type ExtensionTurnPower = (typeof EXTENSION_TURN_POWERS)[number];

// (2026-11-28) What an extension may do as this sandbox's identity (`permissions.identity`): `sign`, have the daemon sign
// a record of its own with the sandbox's key, under a domain naming the extension and the record's purpose
// (`ext:<publisher.name>/<purpose>`), which anyone verifies with the sandbox's published keys. The key never leaves the
// daemon. A list, so more verbs can join it.
export const EXTENSION_IDENTITY_VERBS = ["sign"] as const;
export type ExtensionIdentityVerb = (typeof EXTENSION_IDENTITY_VERBS)[number];

// The rest of an extension's declared reach, read off its manifest's `permissions`.
export interface ExtensionDeclaredReach {
    readonly events: readonly ExtensionDeclaredEvent[];
    // Whether it may hold work in flight, which keeps the sandbox awake and a restart waiting.
    readonly work: boolean;
    readonly exec: readonly ExtensionExecClass[];
    readonly fires: readonly string[];
    // What its agent tools may do with the calling turn's grants.
    readonly turn: readonly ExtensionTurnPower[];
    // (2026-11-28) What it may do as this sandbox's identity.
    readonly identity: readonly ExtensionIdentityVerb[];
}

// The fields of a manifest's `permissions` this reads, as parsed.
export interface DeclaredPermissions {
    readonly events?: readonly ExtensionDeclaredEvent[] | undefined;
    readonly work?: boolean | undefined;
    readonly exec?: readonly ExtensionExecClass[] | undefined;
    readonly fires?: readonly string[] | undefined;
    readonly turn?: readonly ExtensionTurnPower[] | undefined;
    readonly identity?: readonly ExtensionIdentityVerb[] | undefined;
}

export const declaredReachOf = (permissions: DeclaredPermissions | undefined): ExtensionDeclaredReach => ({
    events: permissions?.events ?? [],
    work: permissions?.work === true,
    exec: permissions?.exec ?? [],
    fires: permissions?.fires ?? [],
    turn: permissions?.turn ?? [],
    identity: permissions?.identity ?? [],
});

// Nothing declared: what an extension with no such `permissions` holds.
export const NO_DECLARED_REACH: ExtensionDeclaredReach = declaredReachOf(undefined);

// What an extension token's reach is judged by: the manifest's `permissions.daemon`, and the provider its
// `contributes.listener` names, when the extension owns that listener.
export interface ExtensionReach {
    readonly permissions: readonly string[];
    readonly listener?: string | undefined;
}

const LISTENER_ROUTE = /^\/listeners\/([^/]+)\/(?:state|dispatch|failure|status)$/u;

// The provider segment a listener route addresses, as it arrived; undefined for any other path.
export const listenerSegmentOf = (path: string): string | undefined => LISTENER_ROUTE.exec(path.split("?")[0] ?? path)?.[1];

// Whether an extension's token reaches `method path`: its own routes always; a listener route only for the provider its
// listener names, matched as sent or as encoded and never decoded, since a provider comes from a manifest and may hold
// anything a glob would widen on (another provider's /state hands back that provider's stored credentials); anything
// else by `permissions.daemon`. The daemon's grant (auth/grants.ts) and the SDK's test fake both judge by this, so a
// fake can't admit what the daemon refuses.
export const extensionRouteReach = (reach: ExtensionReach, method: string, path: string): boolean => {
    if (sandboxRouteAllowed(EXTENSION_OWN_ROUTES, method, path)) {
        return true;
    }
    const segment = listenerSegmentOf(path);
    if (segment !== undefined) {
        return reach.listener !== undefined && (segment === reach.listener || segment === encodeURIComponent(reach.listener));
    }
    return sandboxRouteAllowed(reach.permissions, method, path);
};
