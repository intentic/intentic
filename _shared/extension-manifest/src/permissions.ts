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

// The routes every extension's own token reaches without declaring them: what the host tells an extension about
// itself, its own settings (secrets included) and its own event stream. Each answers only about the extension asking,
// so declaring them would grant nothing a reviewer could weigh.
export const EXTENSION_OWN_ROUTES: readonly string[] = ["GET /extension/settings", "GET /extension/events"];

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
