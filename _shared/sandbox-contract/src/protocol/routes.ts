import { z } from "zod";

// Named route surface of the daemon's contract (`<group>.<route>`), derived automatically so nothing here is
// hand-maintained. The daemon advertises which routes it implements (the /events hello frame); the browser diffs that
// against its own contract so an old daemon's gap is a named feature check, not a silent 404.

// Structural shape of `~orpc.route`, the metadata oRPC attaches to every `oc.route(...)` procedure; read this way since
// oRPC's internal types aren't public.
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

// One advertised route: contract name plus wire shape, matched back to a concrete request path by routeNameForRequest.
export interface ContractRoute {
    readonly name: string;
    readonly method: string;
    // oRPC path template with `{param}` placeholders, e.g. `/system/terminals/{name}`.
    readonly path: string;
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
                routes.push({ name: `${group}.${name}`, method: route.method, path: route.path });
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

// One route's wire shape, or undefined if it can't be expressed (a streaming route with no underlying schema). `io`
// matters: a `.default()` field is optional in and required out, so both directions must be read separately.
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

// Matches a concrete path against a route template segment-wise; `{param}` matches exactly one segment, so length must
// match too.
const pathMatches = (template: string, path: string): boolean => {
    const wanted = template.split("/");
    const actual = path.split("/");
    if (wanted.length !== actual.length) {
        return false;
    }
    return wanted.every((segment, index) => (segment.startsWith("{") && segment.endsWith("}") ? actual[index] !== "" : segment === actual[index]));
};

// The contract route a request belongs to, or undefined for a hand-written daemon route (/health, /workspace/raw) never
// gated by the contract. Query string stripped first.
export const routeNameForRequest = (routes: readonly ContractRoute[], method: string, pathWithQuery: string): string | undefined => {
    const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
    const upper = method.toUpperCase();
    return routes.find((route) => route.method.toUpperCase() === upper && pathMatches(route.path, path))?.name;
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
