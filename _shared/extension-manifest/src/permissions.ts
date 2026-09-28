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
