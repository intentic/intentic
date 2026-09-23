import { eventIterator } from "@orpc/contract";
import { z } from "zod";
import type { RouteMeta } from "./route-meta.js";

// Named route surface of the daemon's contract (`<group>.<route>`), derived automatically so nothing here is
// hand-maintained. The daemon advertises which routes it implements (the /events hello frame); the browser diffs that
// against its own contract so an old daemon's gap is a named feature check, not a silent 404.

// Every streamed route declares its frames through this, never oRPC's `eventIterator` directly: that returns an opaque
// standard-schema validator holding no reachable inner schema, so a stream's payload would be unfingerprintable and its
// drift invisible. The frame schema rides along under a symbol, which oRPC never reads and JSON never serializes.
// Typed as a plain `symbol`, not the inferred unique one: a unique symbol would ride into every contract's inferred
// type and break declaration emit on a local name nothing outside can refer to.
const FRAME: symbol = Symbol.for("intentic.contract.frame");

export const streamOf = <T extends z.ZodType>(frame: T) => Object.assign(eventIterator(frame), { [FRAME]: frame });

// The frame schema behind a streamed route's validator, or undefined for an ordinary request/response schema.
const frameOf = (schema: unknown): z.ZodType | undefined =>
    typeof schema === "object" && schema !== null && FRAME in schema ? ((schema as Record<symbol, unknown>)[FRAME] as z.ZodType) : undefined;

// Structural shape of `~orpc`, what oRPC attaches to every procedure: its route, and the RouteMeta its builder carried
// (route-meta.ts). Read this way since oRPC's internal types aren't public.
interface ContractProcedureLike {
    readonly "~orpc": { readonly route?: { readonly method?: string; readonly path?: string }; readonly meta?: RouteMeta };
}

const procedureRoute = (value: unknown): Omit<ContractRoute, "name"> | undefined => {
    if (typeof value !== "object" || value === null || !("~orpc" in value)) {
        return undefined;
    }
    const { route, meta } = (value as ContractProcedureLike)["~orpc"];
    if (route?.method === undefined || route.path === undefined) {
        return undefined;
    }
    return { method: route.method, path: route.path, meta: meta ?? {} };
};

// One declared route: its name and wire shape, matched back to a concrete request by servedRoute, and its policy.
export interface ContractRoute {
    readonly name: string;
    readonly method: string;
    // Path template with `{param}` placeholders, e.g. `/system/terminals/{name}`; a raw route's may end in `/*`.
    readonly path: string;
    readonly meta: RouteMeta;
}

// Walks a contract object (group → procedure) into a flat route list, sorted by name for a stable diff.
export const contractRoutes = (contract: Record<string, unknown>): ContractRoute[] => {
    const routes: ContractRoute[] = [];
    for (const [group, procedures] of Object.entries(contract)) {
        if (typeof procedures !== "object" || procedures === null) {
            continue;
        }
        for (const [name, procedure] of Object.entries(procedures as Record<string, unknown>)) {
            const route = procedureRoute(procedure);
            if (route !== undefined) {
                routes.push({ name: `${group}.${name}`, ...route });
            }
        }
    }
    return routes.toSorted((a, b) => a.name.localeCompare(b.name));
};

// Route names alone miss payload drift: a route present on both sides can still have a different schema between builds.
// Each route also carries a fingerprint of its input/output schema, computed automatically so nothing here is a
// hand-bumped version number.

// Schemas oRPC hangs off a procedure, read structurally like `route` above since they're internal metadata, not public.
interface ContractSchemasLike {
    readonly "~orpc": { readonly inputSchema?: unknown; readonly outputSchema?: unknown };
}

// JSON Schema keywords whose array value is a set; reordering a z.object's fields must not read as drift.
const UNORDERED = new Set(["required", "enum", "anyOf", "oneOf", "allOf"]);

// Canonicalizes JSON: object keys and set-valued arrays (UNORDERED) sorted, everything else left as written, so a
// cosmetic edit doesn't fingerprint as a payload change. Positional arrays like a tuple's `prefixItems` stay ordered,
// or distinct shapes would collide.
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

// FNV-1a over the canonical JSON, base36; not cryptographic, since this is only a drift signal and a collision costs
// one missed warning, nothing more.
const fingerprint = (value: unknown): string => {
    const text = JSON.stringify(canonical(value));
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
};

// One side of a route as JSON Schema. A streamed side is read through its frame and tagged, so "answers X" and "streams
// frames of X" can never fingerprint alike. `io` matters: a `.default()` field is optional in and required out.
const wireShape = (schema: unknown, io: "input" | "output"): unknown => {
    if (schema === undefined) {
        return undefined;
    }
    const frame = frameOf(schema);
    return frame === undefined ? z.toJSONSchema(schema as z.ZodType, { io }) : { stream: z.toJSONSchema(frame, { io }) };
};

// One route's wire shape, or undefined if it can't be expressed at all.
const procedureShape = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || !("~orpc" in value)) {
        return undefined;
    }
    const { inputSchema, outputSchema } = (value as ContractSchemasLike)["~orpc"];
    try {
        return fingerprint({ in: wireShape(inputSchema, "input"), out: wireShape(outputSchema, "output") });
    } catch {
        return undefined;
    }
};

// Every route whose shape this build can express, as name → fingerprint. A separate map from ContractRoute since
// existence and shape are advertised, and checked, independently.
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

// A template split once: a literal segment, or undefined for a `{param}`; `tail` for a raw route's trailing `/*`.
interface Pattern {
    readonly route: ContractRoute;
    readonly segments: readonly (string | undefined)[];
    readonly tail: boolean;
}

const compiled = new WeakMap<readonly ContractRoute[], readonly Pattern[]>();

const patternsOf = (routes: readonly ContractRoute[]): readonly Pattern[] => {
    const known = compiled.get(routes);
    if (known !== undefined) {
        return known;
    }
    const patterns = routes.map((route) => {
        const parts = route.path.split("/").slice(1);
        const tail = parts.at(-1) === "*";
        const segments = (tail ? parts.slice(0, -1) : parts).map((part) => (part.startsWith("{") && part.endsWith("}") ? undefined : part));
        return { route, segments, tail };
    });
    compiled.set(routes, patterns);
    return patterns;
};

// Whether a template takes a request's segments. Hono (`raw`) gives a `{param}` only a non-empty segment and a `/*` one
// or more further ones; oRPC's router gives a `{param}` any segment, the empty one included.
const takes = (pattern: Pattern, segments: readonly string[], raw: boolean): boolean => {
    const { segments: wanted, tail } = pattern;
    if (tail ? segments.length <= wanted.length : segments.length !== wanted.length) {
        return false;
    }
    return wanted.every((segment, index) => (segment === undefined ? !raw || segments[index] !== "" : segment === segments[index]));
};

// oRPC's router tries a literal segment before a parameter, left to right: `/agents/search` is the search route, not
// `get` with an id of "search", whichever of the two the list happens to hold first.
const moreLiteral = (a: Pattern, b: Pattern): boolean => {
    const at = a.segments.findIndex((segment, index) => (segment === undefined) !== (b.segments[index] === undefined));
    return at >= 0 && a.segments[at] !== undefined;
};

const mostLiteral = (patterns: readonly Pattern[]): Pattern | undefined =>
    patterns.reduce<Pattern | undefined>((best, pattern) => (best === undefined || moreLiteral(pattern, best) ? pattern : best), undefined);

// Whether a route declared for one method answers a request's. The CORS middleware answers a preflight (OPTIONS) for
// every route at its path; Hono (`raw`) answers every method with an `ALL` route and HEAD with a GET one.
const answers = (declared: string, method: string, raw: boolean): boolean =>
    method === "OPTIONS" || declared === method || (raw && (declared === "ALL" || (declared === "GET" && method === "HEAD")));

// A request path as oRPC's router reads it: one trailing slash dropped, then one trailing empty segment, so `/a/` and
// `/a//` are `/a` while `/a///` is not.
const orpcSegments = (path: string): string[] => {
    const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/").slice(1);
    return segments.at(-1) === "" ? segments.slice(0, -1) : segments;
};

const contractRouteFor = (routes: readonly ContractRoute[], method: string, path: string): ContractRoute | undefined => {
    const segments = orpcSegments(path);
    return mostLiteral(patternsOf(routes).filter((pattern) => answers(pattern.route.method.toUpperCase(), method, false) && takes(pattern, segments, false)))
        ?.route;
};

// Hono matches the path exactly, and among overlapping routes the first registered answers; a preflight belongs to none
// of them, so the most literal names it.
const rawRouteFor = (routes: readonly ContractRoute[], method: string, path: string): ContractRoute | undefined => {
    const segments = path.split("/").slice(1);
    const matching = patternsOf(routes).filter((pattern) => answers(pattern.route.method, method, true) && takes(pattern, segments, true));
    return (method === "OPTIONS" ? mostLiteral(matching) : matching[0])?.route;
};

const pathOf = (pathWithQuery: string): string => pathWithQuery.split("?")[0] ?? pathWithQuery;

// The contract route a request belongs to, read as oRPC's router reads it, or undefined for a hand-written daemon route
// (/health, /workspace/raw) the contract never declared. Query string stripped first.
export const routeNameForRequest = (routes: readonly ContractRoute[], method: string, pathWithQuery: string): string | undefined =>
    contractRouteFor(routes, method.toUpperCase(), pathOf(pathWithQuery))?.name;

// The route that serves a request to the daemon: a raw route as Hono matches it, since those are registered ahead of
// oRPC's catch-all, else a contract route as oRPC's router does; undefined when neither serves it.
export const servedRoute = (raw: readonly ContractRoute[], contract: readonly ContractRoute[], method: string, pathWithQuery: string): ContractRoute | undefined => {
    const upper = method.toUpperCase();
    const path = pathOf(pathWithQuery);
    return rawRouteFor(raw, upper, path) ?? contractRouteFor(contract, upper, path);
};

// The route a typed client call belongs to; oRPC addresses a procedure by contract position (`['git','stashApply']`),
// so this is a lookup, not a match.
export const routeForProcedure = (routes: readonly ContractRoute[], procedure: readonly string[]): ContractRoute | undefined =>
    routes.find((route) => route.name === procedure.join("."));

// Fills each `{param}` in the route template from the matching input field, so a permission gate checks the real path,
// not a template a glob would still match unfilled. An unmatched param keeps its placeholder, the safe failure since a
// literal grant won't match braces.
export const requestPathFor = (route: ContractRoute, input: unknown): string => {
    const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    return route.path.replace(/\{([^}]+)\}/g, (placeholder, name: string) => {
        const value = fields[name];
        return value === undefined ? placeholder : encodeURIComponent(String(value));
    });
};
