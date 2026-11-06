import { sleep } from "@intentic/base/async";
import { z } from "zod";
import type { RouteMeta } from "./route-meta.js";
import { fillRoutePath } from "./raw/route-path.js";
import { FRAME, streamOf } from "./stream-of.js";

// Named route surface of the daemon's contract (`<group>.<route>`), derived automatically so nothing here is
// hand-maintained. The daemon advertises which routes it implements (the /events hello frame); the browser diffs that
// against its own contract so an old daemon's gap is a named feature check, not a silent 404.

export { streamOf };

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

// The path to call one contract procedure at, its `{param}`s filled and encoded, for a caller that speaks to the daemon
// without oRPC's client (a stream it reads itself, a published tool keeping its install small): the path comes from
// the contract, never spelled a second time.
export const procedurePath = (procedure: unknown, params?: Readonly<Record<string, string>>): string => {
    const route = procedureRoute(procedure);
    if (route === undefined) {
        throw new Error("not a contract procedure with a route");
    }
    return fillRoutePath(route.path, params);
};

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

// THE SECOND PRINT, AND WHY THE FIRST ONE CRIED WOLF. The print above hashes the JSON Schema whole, and two things in
// it change on almost every push without changing what either side can send or read: the prose (`description`,
// `title`) every schema here carries at length, and a new optional field. Against a page deployed ahead of the
// sandboxes, both read as "may misbehave" on routes that work exactly as before. So a route is printed twice more:
//
// - `wire`: the shape as above with the words taken out. It differs only where the payload's shape differs.
// - `core`: what has to hold for the call to work at all, read as each side's parser reads the other's message (zod's
//   `parse`, which is the input side of a schema whichever way the message travels: the daemon parses a request, the
//   page parses every answer, sandboxRpc.ts). It drops defaults, and every optional property of an object that strips
//   what it doesn't know, since such a property can be absent on either side and missing from either side's schema
//   without the other refusing anything. A strict object (`additionalProperties: false`) keeps them all: there an
//   unknown key is a refusal.
//
// Equal cores with different wires is a sandbox that answers every call and lacks some optional part of one, which is
// a feature arriving with the next update rather than a fault. A different core is a real disagreement.
//
// What the core cannot see: an existing optional field whose type changed. That is a narrowing the contract-shrink gate
// already makes a commit declare, and it still shows as a different `wire`.
export type RoutePrints = [wire: string, core: string];

// Keywords that carry words for a reader and never a constraint on the payload.
const DOC_KEYWORDS = new Set(["description", "title", "examples", "$comment", "deprecated"]);
// Keywords whose value maps a NAME to a schema; inside one a key is a field, never a keyword.
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
// Keywords whose value is payload data, not schema, and is hashed as written.
const DATA_KEYWORDS = new Set(["const", "enum", "default"]);

// JSON as z.toJSONSchema writes it, which is all the prints ever walk.
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const isObject = (value: Json): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

// The names a schema object requires, or none.
const requiredOf = (schema: JsonObject): ReadonlySet<Json> => {
    const required = schema["required"];
    return new Set(Array.isArray(required) ? required : []);
};

// The schema with its words removed and, for the core, its defaults and its strip objects' optional properties too.
// `named` is a map of field name → schema, whose keys are never keywords.
const pruned = (value: Json, core: boolean, named = false): Json => {
    if (Array.isArray(value)) {
        return value.map((item) => pruned(item, core));
    }
    if (!isObject(value)) {
        return value;
    }
    const out: Record<string, Json> = {};
    for (const [key, nested] of Object.entries(value)) {
        if (named) {
            out[key] = pruned(nested, core);
        } else if (!DOC_KEYWORDS.has(key) && !(core && key === "default")) {
            out[key] = DATA_KEYWORDS.has(key) ? nested : pruned(nested, core, NAME_MAPS.has(key));
        }
    }
    const properties = out["properties"];
    if (core && !named && value["additionalProperties"] !== false && properties !== undefined && isObject(properties)) {
        const required = requiredOf(value);
        out["properties"] = Object.fromEntries(Object.entries(properties).filter(([name]) => required.has(name)));
    }
    return out;
};

// The two schemas of a route, whichever kind declares them.
interface RawRouteSchemas {
    readonly input?: unknown;
    readonly output?: unknown;
}

// The schema one side of a route declares, as oRPC or a raw table carries it (read structurally, like `~orpc` above).
type SideSchema = RawRouteSchemas["input"];
// One side of a route as JSON for the prints, or undefined for a side with no schema.
type SideJson = Json | undefined;
// How a walk turns a side into its JSON: each time afresh, or once per route (convertingOnce).
type SideConverter = (schema: SideSchema, io: "input" | "output") => SideJson;

// SAFETY: wireShape is z.toJSONSchema's output (or a `{ stream }` wrapper around it, or undefined for a side with no
// schema), which is JSON by construction.
const convertEach: SideConverter = (schema, io) => wireShape(schema, io) as SideJson;

// convertEach remembering its answers, made for one route and dropped with it. The prints read that route's input as
// input three times and its output as output twice, and a hand-written route is printed into two maps; z.toJSONSchema
// is nearly all of a print's cost (measured 2026-11-06: 0.4-0.9 s of a daemon's main thread on its first hello), and
// every reader here only reads what it returns. A conversion that throws is not remembered, so it throws again for every
// print that asks, as it did before.
const convertingOnce = (): SideConverter => {
    const known = new Map<SideSchema, Map<"input" | "output", SideJson>>();
    return (schema, io) => {
        const sides = known.get(schema) ?? new Map<"input" | "output", SideJson>();
        known.set(schema, sides);
        if (!sides.has(io)) {
            sides.set(io, convertEach(schema, io));
        }
        return sides.get(io);
    };
};

// One side of a route as JSON for the prints; undefined becomes null so the side still counts.
const sideOf = (route: RawRouteSchemas, side: keyof RawRouteSchemas, io: "input" | "output", convert: SideConverter): Json => convert(route[side], io) ?? null;

// Both prints of one route's two sides. The wire reads each side as the first print does (a `.default()` field is
// optional in, required out); the core reads both as a parser does.
const printsOf = (route: RawRouteSchemas, convert: SideConverter = convertingOnce()): RoutePrints => [
    fingerprint(pruned({ in: sideOf(route, "input", "input", convert), out: sideOf(route, "output", "output", convert) }, false)),
    fingerprint(pruned({ in: sideOf(route, "input", "input", convert), out: sideOf(route, "output", "input", convert) }, true)),
];

// Both prints, or undefined if the route's shape can't be expressed at all.
const printsOrNone = (route: RawRouteSchemas, convert?: SideConverter): RoutePrints | undefined => {
    try {
        return printsOf(route, convert);
    } catch {
        // allow(silent-catch): a schema z.toJSONSchema cannot express (z.custom, oRPC's bare eventIterator) leaves its route unprinted, never the walk failed.
        return undefined;
    }
};

// The first print of a route's two sides, or undefined if they can't be expressed at all. A `text` or `bytes` raw route
// declares no input schema; its body is the document or the bytes, and the print is its answer alone.
const firstPrintOf = (route: RawRouteSchemas, convert: SideConverter = convertEach): string | undefined => {
    try {
        return fingerprint({ in: convert(route.input, "input"), out: convert(route.output, "output") });
    } catch {
        // allow(silent-catch): as printsOrNone, a route whose schema cannot be expressed keeps its name and loses only its print.
        return undefined;
    }
};

// A procedure's two schemas, as oRPC hangs them off it.
const schemasOf = (procedure: ContractSchemasLike): RawRouteSchemas => ({ input: procedure["~orpc"].inputSchema, output: procedure["~orpc"].outputSchema });

// Every procedure of a contract that has a route, as `group.name` → procedure; the one walk every print shares.
function* routedProcedures(contract: Record<string, unknown>): Generator<readonly [string, ContractSchemasLike]> {
    for (const [group, procedures] of Object.entries(contract)) {
        if (typeof procedures !== "object" || procedures === null) {
            continue;
        }
        // SAFETY: a contract group is an object of procedures; procedureRoute below admits only what carries `~orpc`.
        for (const [name, procedure] of Object.entries(procedures as Record<string, ContractSchemasLike>)) {
            if (procedureRoute(procedure) !== undefined) {
                yield [`${group}.${name}`, procedure];
            }
        }
    }
}

// Every route whose shape this build can express, as name → fingerprint. A separate map from ContractRoute since
// existence and shape are advertised, and checked, independently.
export const routeShapes = (contract: Record<string, unknown>): Record<string, string> => {
    const shapes: Record<string, string> = {};
    for (const [name, procedure] of routedProcedures(contract)) {
        const shape = firstPrintOf(schemasOf(procedure));
        if (shape !== undefined) {
            shapes[name] = shape;
        }
    }
    return shapes;
};

// The second print of every route the first one prints (RoutePrints), procedures and hand-written routes in one map:
// their names never collide, a raw one being `METHOD /path`. A route whose shape can't be expressed is left out, as
// above.
export const routePrintsOf = (contract: Record<string, unknown>, raw: Readonly<Record<string, RawRouteSchemas>>) => {
    const prints: Record<string, RoutePrints> = {};
    const sides: (readonly [string, RawRouteSchemas])[] = [...[...routedProcedures(contract)].map(([name, procedure]) => [name, schemasOf(procedure)] as const), ...Object.entries(raw)];
    for (const [name, route] of sides) {
        const both = printsOrNone(route);
        if (both !== undefined) {
            prints[name] = both;
        }
    }
    return prints;
};

// The same, for the hand-written routes that answer plain JSON (raw-json-routes.ts). They carry their schemas directly
// rather than through oRPC, so they need their own walk — and without one they were the half of the surface no version
// check could see: a browser calling a raw route an older daemon predates got a bare 404 with nothing to say about it.
// The table is passed in rather than imported, so this file stays free of the raw tables that read its types.
export const rawRouteFingerprintsOf = (table: Record<string, RawRouteSchemas>) => {
    const prints: Record<string, string> = {};
    for (const [name, route] of Object.entries(table)) {
        const print = firstPrintOf(route);
        if (print !== undefined) {
            prints[name] = print;
        }
    }
    return prints;
};

// All three maps above at once, what a daemon's hello carries: `fingerprints` is routeShapes, `rawFingerprints`
// rawRouteFingerprintsOf and `prints` routePrintsOf, entry for entry and in the same order.
export interface RouteSurface {
    readonly fingerprints: Readonly<Record<string, string>>;
    readonly rawFingerprints: Readonly<Record<string, string>>;
    readonly prints: Readonly<Record<string, RoutePrints>>;
}

// The surface worked out one route per step, each route's schemas converted once for all its prints; whoever drives it
// decides when to hand the thread back between steps (routeSurfaceOf).
function* surfaceSteps(contract: Readonly<Record<string, object>>, raw: Readonly<Record<string, RawRouteSchemas>>): Generator<undefined, RouteSurface> {
    const fingerprints: Record<string, string> = {};
    const rawFingerprints: Record<string, string> = {};
    const prints: Record<string, RoutePrints> = {};
    for (const [name, procedure] of routedProcedures(contract)) {
        const route = schemasOf(procedure);
        const convert = convertingOnce();
        const first = firstPrintOf(route, convert);
        if (first !== undefined) {
            fingerprints[name] = first;
        }
        const both = printsOrNone(route, convert);
        if (both !== undefined) {
            prints[name] = both;
        }
        yield undefined;
    }
    for (const [name, route] of Object.entries(raw)) {
        const convert = convertingOnce();
        const both = printsOrNone(route, convert);
        if (both !== undefined) {
            prints[name] = both;
        }
        const print = firstPrintOf(route, convert);
        if (print !== undefined) {
            rawFingerprints[name] = print;
        }
        yield undefined;
    }
    return { fingerprints, rawFingerprints, prints };
}

// How long the surface keeps the thread before handing it back: a few routes' worth, so a daemon's first hello is many
// short tasks between its other work rather than one block of half a second or more.
const SURFACE_SLICE_MS = 8;

// The surface, worked out in slices of `sliceMs` with a timer's turn between them, so I/O and timers run while it is.
export const routeSurfaceOf = async (contract: Readonly<Record<string, object>>, raw: Readonly<Record<string, RawRouteSchemas>>, sliceMs = SURFACE_SLICE_MS): Promise<RouteSurface> => {
    const steps = surfaceSteps(contract, raw);
    let sliceStart = performance.now();
    for (;;) {
        const step = steps.next();
        if (step.done === true) {
            return step.value;
        }
        if (performance.now() - sliceStart >= sliceMs) {
            await sleep(0);
            sliceStart = performance.now();
        }
    }
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
