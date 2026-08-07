/* The daemon's route surface, named. A sandbox daemon is baked into an image, so the browser talking to it is
 * routinely NEWER than the daemon: a released app plane serves every user's sandbox, whatever image they last
 * pulled, and in local development the web app is always ahead of the last `pnpm build:sandbox`. Both are
 * normal and neither should force an update.
 *
 * What must not happen is the failure being SILENT. A route the daemon predates answers 404, which the browser
 * has no way to tell apart from "you asked for a file that isn't there" — so a missing feature reads as a
 * broken one, and diagnosing it costs an hour of "did the image rebuild?".
 *
 * So the daemon ADVERTISES the routes it implements (the /events hello frame) and the browser compares that
 * against the contract it was itself built with. Everything present on both sides works exactly as before;
 * anything the daemon lacks is a KNOWN, NAMED gap the UI can gate a feature on or explain in an error, instead
 * of a mystery 404. Old daemon + new browser stays fully supported — it just stops being confusing.
 *
 * Route names are `<group>.<route>` (`vpn.list`, `kimi.models`), derived from the contract object both sides
 * import. Nothing is generated and nothing is hand-maintained: adding a route to the contract adds it here.
 *
 * Everything here is a pure function of a contract passed in — index.ts binds them to `sandboxContract` once it
 * is assembled, which is what keeps this module out of an import cycle with it. */

// The shape we read off an oRPC contract procedure. `~orpc.route` is the contract metadata oRPC attaches to
// every `oc.route(...)` procedure; we only need the wire method + path, so this is deliberately structural
// rather than an import of oRPC's internal types (which are not part of its public surface).
interface ContractProcedureLike {
    readonly "~orpc": { readonly route?: { readonly method?: string; readonly path?: string } };
}

const procedureRoute = (value: unknown): { method: string; path: string } | undefined => {
    if (typeof value !== "object" || value === null || !("~orpc" in value)) {
        return undefined;
    }
    const { route } = (value as ContractProcedureLike)["~orpc"];
    if (route?.method === undefined || route.path === undefined) {
        return undefined;
    }
    return { method: route.method, path: route.path };
};

// One advertised route: its contract name plus the wire shape, so a concrete request path can be matched back
// to the name it came from (see routeNameForRequest).
export interface ContractRoute {
    readonly name: string;
    readonly method: string;
    // The oRPC path template, with `{param}` placeholders — e.g. `/system/terminals/{name}`.
    readonly path: string;
}

// Walk a contract object (two levels: group → procedure) into its flat route list, sorted by name so the
// advertised array is stable and diffable.
export const contractRoutes = (contract: Record<string, unknown>): ContractRoute[] => {
    const routes: ContractRoute[] = [];
    for (const [group, procedures] of Object.entries(contract)) {
        if (typeof procedures !== "object" || procedures === null) {
            continue;
        }
        for (const [name, procedure] of Object.entries(procedures as Record<string, unknown>)) {
            const route = procedureRoute(procedure);
            if (route !== undefined) {
                routes.push({ name: `${group}.${name}`, method: route.method, path: route.path });
            }
        }
    }
    return routes.toSorted((a, b) => a.name.localeCompare(b.name));
};

// Does a concrete request path match this route's template? Segment-wise, with `{param}` matching exactly one
// segment — the same shape oRPC mounts, so a template can never match a longer or shorter path.
const pathMatches = (template: string, path: string): boolean => {
    const wanted = template.split("/");
    const actual = path.split("/");
    if (wanted.length !== actual.length) {
        return false;
    }
    return wanted.every((segment, index) => (segment.startsWith("{") && segment.endsWith("}") ? actual[index] !== "" : segment === actual[index]));
};

// The contract route a concrete request belongs to, or undefined when the path is not a contract route at all
// (the daemon also serves hand-written Hono routes like /health and /workspace/raw — those are never gated).
// The query string is stripped first; callers pass whatever they handed to fetch.
export const routeNameForRequest = (routes: readonly ContractRoute[], method: string, pathWithQuery: string): string | undefined => {
    const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
    const upper = method.toUpperCase();
    return routes.find((route) => route.method.toUpperCase() === upper && pathMatches(route.path, path))?.name;
};

// The route a typed client call belongs to. oRPC addresses a procedure by its position in the contract —
// `['git','stashApply']` — which is the contract's own name for it, so this is a lookup rather than a match.
export const routeForProcedure = (routes: readonly ContractRoute[], procedure: readonly string[]): ContractRoute | undefined =>
    routes.find((route) => route.name === procedure.join("."));

// THE CONCRETE PATH A TYPED CALL WILL CARRY — the route template with every `{param}` replaced by the input
// field of the same name, which is how the OpenAPI link fills them.
//
// This exists so a permission gate can check the string the daemon will actually route on rather than the
// template it came from. Checking the template would quietly widen every grant: a wildcard glob matches the
// literal `{repo}` braces just as happily as it matches a repo name, so a manifest that narrowed the grant to
// one repo would still admit calls for every other — the gate would be comparing two patterns instead of
// testing a value against one.
//
// A param with no matching input field keeps its placeholder. That cannot be reached through the typed client
// (the contract's input schema requires the field), and leaving the braces in is the safe failure: a glob
// segment still matches it, a literal segment does not.
export const requestPathFor = (route: ContractRoute, input: unknown): string => {
    const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    return route.path.replace(/\{([^}]+)\}/g, (placeholder, name: string) => {
        const value = fields[name];
        return value === undefined ? placeholder : encodeURIComponent(String(value));
    });
};
