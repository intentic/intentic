import { z } from "zod";

/* The daemon's route surface, named. A sandbox daemon is baked into an image, so the browser talking to it is
 * routinely NEWER than the daemon: a released app plane serves every user's sandbox, whatever image they last
 * pulled, and in local development the web app is always ahead of the last `pnpm build:sandbox`. Both are
 * normal and neither should force an update.
 *
 * What must not happen is the failure being SILENT. A route the daemon predates answers 404, which the browser
 * has no way to tell apart from "you asked for a file that isn't there", so a missing feature reads as a
 * broken one, and diagnosing it costs an hour of "did the image rebuild?".
 *
 * So the daemon ADVERTISES the routes it implements (the /events hello frame) and the browser compares that
 * against the contract it was itself built with. Everything present on both sides works exactly as before;
 * anything the daemon lacks is a KNOWN, NAMED gap the UI can gate a feature on or explain in an error, instead
 * of a mystery 404. Old daemon + new browser stays fully supported, it just stops being confusing.
 *
 * Route names are `<group>.<route>` (`vpn.list`, `kimi.models`), derived from the contract object both sides
 * import. Nothing is generated and nothing is hand-maintained: adding a route to the contract adds it here.
 *
 * Everything here is a pure function of a contract passed in, index.ts binds them to `sandboxContract` once it
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
    // The oRPC path template, with `{param}` placeholders, e.g. `/system/terminals/{name}`.
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

/* ---- the SHAPE of a route, not just its name ----
 *
 * The route list above answers "does this daemon have it". It cannot answer the other half: a route that
 * exists on BOTH sides but whose payload changed between the two builds. Names match, so the call goes out,
 * and a field the browser expects is simply missing from the answer, no 404, no message, nothing to attribute
 * it to. That is the one skew failure the named-gap mechanism still leaves silent.
 *
 * So each route also advertises a fingerprint of its wire shape: input and output schema together, reduced to
 * one short string. Same string ⇒ the two builds agree, which is the overwhelmingly common case and costs a
 * comparison. Different ⇒ a NAMED route whose payload moved, which the UI can explain in exactly the words it
 * already uses for a missing one.
 *
 * NOTHING IS HAND-MAINTAINED, which is the whole reason this is a fingerprint and not a version number. The
 * codebase already rejected the hand-bumped alternative once (see the web app's buildEpoch.ts: a SCHEMA_VERSION
 * "hangs on someone remembering"). Changing a field in a contract schema changes that route's fingerprint by
 * itself, on both sides, with nobody to remember anything. */

// The schemas oRPC hangs off a contract procedure, read structurally for the same reason as `route` above,
// they are internal metadata, not part of its public surface.
interface ContractSchemasLike {
    readonly "~orpc": { readonly inputSchema?: unknown; readonly outputSchema?: unknown };
}

/* The JSON Schema keywords whose array value is a SET, order carries no meaning, so two schemas that differ
 * only in it are the same wire shape. `required` is the one that matters in practice: JSON Schema spells an
 * object's fields twice, once as `properties` (an object, so key-sorting settles it) and once as `required`
 * (an array, in declaration order), so without this, moving a field up a `z.object` for readability reads as
 * drift on every route that carries it. The union keywords are here for the same reason a step lower down. */
const UNORDERED = new Set(["required", "enum", "anyOf", "oneOf", "allOf"]);

/* Canonical JSON: object keys sorted, set-valued arrays sorted, everything else left in the order it was
 * written. So the fingerprint depends on what the schema SAYS rather than how zod happened to emit it, which
 * is what keeps a purely cosmetic edit from being reported to a user as a payload that moved.
 *
 * Ordered arrays stay ordered: a tuple's `prefixItems` is positional, and sorting it would call two genuinely
 * different shapes identical, the failure that actually costs something here. */
const canonical = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) {
        const items = value.map((item) => canonical(item));
        return key !== undefined && UNORDERED.has(key) ? items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
    }
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b));
    return entries.map(([name, nested]) => [name, canonical(nested, name)]);
};

/* FNV-1a over the canonical JSON, base36. Deliberately not a cryptographic hash: this is a drift SIGNAL, and
 * the cost of a collision is one warning that never appears, never a wrong action, never a blocked call. A
 * crypto digest would mean a subtle-crypto round trip in the browser (async, and unavailable on insecure
 * origins) to buy nothing this use has any need of. */
const fingerprint = (value: unknown): string => {
    const text = JSON.stringify(canonical(value));
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
};

/* One route's wire shape, or undefined when it cannot be expressed.
 *
 * `io` matters and is not cosmetic: a field with `.default()` is OPTIONAL on the way in and REQUIRED on the
 * way out, so reading both sides in the same direction would call two genuinely different shapes identical.
 *
 * A schema that will not convert yields undefined rather than throwing the walk away. Every such route in the
 * contract today is a streaming one, oRPC wraps an event iterator's output in an opaque type with no schema
 * underneath it, and their absence lands them in exactly the right place: a route with no advertised shape is
 * assumed compatible, which is the same "positive evidence only" rule the missing-route check already runs on. */
const procedureShape = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || !("~orpc" in value)) {
        return undefined;
    }
    const { inputSchema, outputSchema } = (value as ContractSchemasLike)["~orpc"];
    try {
        return fingerprint({
            in: inputSchema === undefined ? undefined : z.toJSONSchema(inputSchema as z.ZodType, { io: "input" }),
            out: outputSchema === undefined ? undefined : z.toJSONSchema(outputSchema as z.ZodType, { io: "output" }),
        });
    } catch {
        return undefined;
    }
};

// Every route whose shape THIS build can express, as name → fingerprint. Same walk as contractRoutes, and
// deliberately a separate map rather than a field on ContractRoute: the two are advertised independently
// (existence covers every route, shape covers the ones that can be expressed) and read by different checks.
export const routeShapes = (contract: Record<string, unknown>): Record<string, string> => {
    const shapes: Record<string, string> = {};
    for (const [group, procedures] of Object.entries(contract)) {
        if (typeof procedures !== "object" || procedures === null) {
            continue;
        }
        for (const [name, procedure] of Object.entries(procedures as Record<string, unknown>)) {
            if (procedureRoute(procedure) === undefined) {
                continue;
            }
            const shape = procedureShape(procedure);
            if (shape !== undefined) {
                shapes[`${group}.${name}`] = shape;
            }
        }
    }
    return shapes;
};

// Does a concrete request path match this route's template? Segment-wise, with `{param}` matching exactly one
// segment, the same shape oRPC mounts, so a template can never match a longer or shorter path.
const pathMatches = (template: string, path: string): boolean => {
    const wanted = template.split("/");
    const actual = path.split("/");
    if (wanted.length !== actual.length) {
        return false;
    }
    return wanted.every((segment, index) => (segment.startsWith("{") && segment.endsWith("}") ? actual[index] !== "" : segment === actual[index]));
};

// The contract route a concrete request belongs to, or undefined when the path is not a contract route at all
// (the daemon also serves hand-written Hono routes like /health and /workspace/raw, those are never gated).
// The query string is stripped first; callers pass whatever they handed to fetch.
export const routeNameForRequest = (routes: readonly ContractRoute[], method: string, pathWithQuery: string): string | undefined => {
    const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
    const upper = method.toUpperCase();
    return routes.find((route) => route.method.toUpperCase() === upper && pathMatches(route.path, path))?.name;
};

// The route a typed client call belongs to. oRPC addresses a procedure by its position in the contract,
// `['git','stashApply']`, which is the contract's own name for it, so this is a lookup rather than a match.
export const routeForProcedure = (routes: readonly ContractRoute[], procedure: readonly string[]): ContractRoute | undefined =>
    routes.find((route) => route.name === procedure.join("."));

// THE CONCRETE PATH A TYPED CALL WILL CARRY, the route template with every `{param}` replaced by the input
// field of the same name, which is how the OpenAPI link fills them.
//
// This exists so a permission gate can check the string the daemon will actually route on rather than the
// template it came from. Checking the template would quietly widen every grant: a wildcard glob matches the
// literal `{repo}` braces just as happily as it matches a repo name, so a manifest that narrowed the grant to
// one repo would still admit calls for every other, the gate would be comparing two patterns instead of
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
