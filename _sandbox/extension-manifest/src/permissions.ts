/* The sandbox-route permission model. An extension declares in its manifest exactly which daemon routes it may
 * reach through `api.sandbox.request/json`, as "<METHOD> <path-glob>" strings where `*` matches exactly one path
 * segment. The host matches every call against these and refuses an undeclared route — so an extension's backend
 * reach is explicit, diffable, and reviewable rather than an ambient client to the whole daemon. */

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface CompiledRoute {
    readonly method: string;
    readonly test: (path: string) => boolean;
}

// "<METHOD> <path-glob>" → a method + an anchored path matcher. Each `*` in the glob matches one path segment
// ([^/]+); everything else is literal. Throws on a malformed entry so a bad manifest fails loudly at load.
const compile = (entry: string): CompiledRoute => {
    const spaceIndex = entry.indexOf(" ");
    if (spaceIndex < 0) {
        throw new Error(`invalid sandbox permission "${entry}" — expected "<METHOD> <path-glob>", e.g. "GET /panels"`);
    }
    const method = entry.slice(0, spaceIndex).trim().toUpperCase();
    const glob = entry.slice(spaceIndex + 1).trim();
    const source = `^${glob.split("*").map(escapeRegExp).join("[^/]+")}$`;
    const regex = new RegExp(source);
    return { method, test: (path) => regex.test(path) };
};

// Whether `method path` is covered by any of the declared permissions. The query string is ignored (routes are
// matched on path only), and the method is compared case-insensitively.
export const sandboxRouteAllowed = (permissions: readonly string[], method: string, path: string): boolean => {
    const route = path.split("?")[0] ?? path;
    const wanted = method.toUpperCase();
    return permissions.some((entry) => {
        const compiled = compile(entry);
        return compiled.method === wanted && compiled.test(route);
    });
};
