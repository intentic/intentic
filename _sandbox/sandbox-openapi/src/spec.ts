/* THE DAEMON'S WIRE SURFACE AS ONE OPENAPI 3.1 DOCUMENT, generated from the contract both sides already
 * import, never hand-maintained.
 *
 * WHY THIS EXISTS AT ALL. The prose page at /developers/http deliberately refused to enumerate the routes,
 * and gave the right reason: "the enumeration is what dates fastest". That reason argues against a
 * HAND-WRITTEN enumeration; it argues for this one. `sandboxContract` already carries every route's method,
 * path, input shape and output shape, so the enumeration is a build output, and the thing that dates cannot
 * date: a route added to the contract is in this document the moment it lands, described in the shapes it
 * actually has.
 *
 * WHAT IS AUTHORED AND WHAT IS DERIVED, because mixing those up is how a generated document starts lying.
 * Derived: every path, method, operation id, parameter, request body and response shape. Authored: the 37
 * group paragraphs (groups.ts), the two credentials (security.ts), and the info block below. Nothing authored
 * describes an individual route — route prose lives on `oc.route({ summary, description })` in the contract
 * itself, so it travels with the code it describes and shows up here for free.
 *
 * THERE IS NO COMMITTED COPY, and that is a deliberate reversal of what contract-lock.ts does next door.
 *
 * The lock exists because a zod schema is DEEP and SHARED: a field's type changing three levels down inside a
 * schema six contracts import is invisible in the diff of the line that changed it, so the surface needs a
 * second, comparable document. A route is neither deep nor shared. Adding one is a single line in a single
 * contract file, and its method, path and shapes are all right there in the diff a reviewer is already
 * reading. There is nothing a committed document would surface that the contract diff does not.
 *
 * Against that: pretty-printed, this document is 2 MB and about 70,000 lines, and contract-lock.ts already
 * ruled on exactly this trade for exactly this repo — "pretty-printed, the lock is a 35k-line wall nobody
 * scrolls". Committing a wall three times that size, rewritten in bulk whenever a shared schema gains a field,
 * would cost every contract change a diff nobody can read in exchange for review coverage the lock already
 * provides.
 *
 * So the document is a BUILD OUTPUT. The site generates it during its own build and serves it at
 * /api/openapi.json for anyone who wants to point their own tooling at it, and drift is not tested for because
 * it is not possible: there is one copy and it is made from the code every time. What spec.test.ts guards
 * instead is that the generation is total (every contract route reaches the document), correctly grouped, and
 * deterministic.
 */

import { sandboxContract } from "@intentic/sandbox-contract";
import { OpenAPIGenerator } from "@orpc/openapi";
import { zodConverter } from "./converter.js";
import { SPEC_GROUPS, specGroup, specTags } from "./groups.js";
import { securityRequirement, securitySchemes } from "./security.js";

/* The loopback name, not a hostname anybody else's sandbox answers on. A sandbox is reached at a per-workspace
 * address the platform hands out, so there IS no single server URL to publish: a variable is the honest shape,
 * and the default is the one address that is true on every machine. */
const SERVERS = [
    {
        url: "{sandbox}",
        description: "Your own sandbox. In a browser signed in to the workspace this is the address in the bar.",
        variables: {
            sandbox: {
                default: "http://localhost:39247",
                description: "The sandbox's base URL: its platform hostname, or the loopback listener on your own machine.",
            },
        },
    },
];

const DESCRIPTION = [
    "Every call an intentic sandbox daemon answers, generated from the wire contract the daemon and its browser client both import.",
    "",
    "The daemon runs beside your code, on hardware you own. There is no shared server and no central API: the address below is your sandbox and nobody else's, which is also why the playground on this site answers from a simulation in your own tab rather than by calling anything.",
    "",
    "Two conventions cover the whole surface. Input rides in the path and query for a `GET` and in a JSON body otherwise. A failure comes back as a JSON object with a `message`, never as an empty body — a refusal is a result, not a crash.",
    "",
    "One route is open: `GET /health`. It is not in this document because it is not part of the contract — it exists so a script can tell a live sandbox from a dead port, and it deliberately checks nothing.",
].join("\n");

/** Every contract group in the order groups.ts lays down, paired with the operation ids that belong to it. */
const operationGroup = (operationId: string): string | undefined => specGroup(operationId.split(".")[0] ?? "")?.label;

/* THE DOCUMENT, TYPED AS MUCH AS IT IS WORTH TYPING, and no further.
 *
 * The generator hands back a bag of unknowns. Returning that verbatim made every reader — the tests here, the
 * reference pages next door — re-declare the same handful of fields for itself and reach for a cast to read
 * them, which is three copies of one shape that can disagree, and a cast is exactly the thing that stops
 * disagreeing loudly.
 *
 * So the fields anything actually READS are named here, once. Everything below an operation stays `unknown`:
 * a schema is JSON Schema in full generality, this package converts rather than interprets it, and a partial
 * interface over it would be a claim about shapes the contract is free to grow tomorrow. The line is drawn at
 * exactly the point where this package stops knowing more than the specification does.
 */
export interface SpecOperation {
    operationId?: string;
    summary?: string;
    description?: string;
    tags?: string[];
    parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: unknown }[];
    requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
    responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

/** One path's operations, keyed by lower-case HTTP method. */
export type SpecPathItem = Record<string, SpecOperation>;

export interface SandboxSpecDocument {
    openapi: string;
    info: Record<string, unknown>;
    servers: unknown[];
    security: Record<string, never[]>[];
    tags: { name: string; description: string }[];
    paths: Record<string, SpecPathItem>;
    components: { securitySchemes: Record<string, unknown> };
}

/* PATHS IN EDITORIAL ORDER. The generator walks the contract object, so its output order is the order the
 * contract's own keys happen to sit in — which is neither alphabetical nor useful, and would make the diff of
 * an unrelated contract reshuffle look like a surface change. Rebuilding the object in the order groups.ts
 * declares makes the document's order a decision rather than an accident, and a stable one: two runs of the
 * same code are byte-identical, so a diff of openapi.json is a diff of the contract. */
const inGroupOrder = (paths: Record<string, SpecPathItem>): Record<string, SpecPathItem> => {
    const rank = new Map(SPEC_GROUPS.map((group, index) => [group.label, index]));
    const keyed = Object.entries(paths).map(([path, item], index) => {
        const first = Object.values(item)[0];
        const label = first?.operationId === undefined ? undefined : operationGroup(first.operationId);
        return { path, item, rank: label === undefined ? Number.MAX_SAFE_INTEGER : (rank.get(label) ?? Number.MAX_SAFE_INTEGER), index };
    });
    // Ties keep the contract's own order within a group, which is the order the routes were written in and
    // reads as intended (list before create before delete) far more often than sorting would.
    keyed.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return Object.fromEntries(keyed.map((entry) => [entry.path, entry.item]));
};

/* `info.version` IS A CONSTANT, and deliberately not the release version.
 *
 * This surface is unversioned by design. A released app plane serves every user's sandbox, whatever image they
 * last pulled, so the browser talking to a daemon is routinely NEWER than it — and the daemon's answer to that
 * is to ADVERTISE the routes it implements (the /events hello frame) rather than to declare a version either
 * side compares. There is no "v2" to move to and no version a caller should branch on.
 *
 * Stamping the release version here would therefore buy a reader nothing and cost the repo a churned 356 KB
 * file on every release, with the whole diff being one line at the top. The route list is the version.
 */
const VERSION = "1";

/** The OpenAPI 3.1 document for the sandbox daemon. */
export const sandboxSpec = async (): Promise<SandboxSpecDocument> => {
    const generated = await new OpenAPIGenerator({ schemaConverters: [zodConverter] }).generate(sandboxContract, {
        info: {
            title: "intentic sandbox daemon",
            version: VERSION,
            description: DESCRIPTION,
            license: { name: "MIT", identifier: "MIT" },
        },
        servers: SERVERS,
        security: securityRequirement(),
        tags: specTags(),
    });

    const paths = (generated.paths ?? {}) as Record<string, SpecPathItem>;

    /* TAGS, ASSIGNED FROM THE OPERATION ID rather than from the path. The path would be wrong for the two
     * routes that do not live under their group's prefix: `system.info` is at /info and `system.events` is at
     * /events, so a path-derived tag would file the daemon's own identity route under a group called "info". */
    for (const item of Object.values(paths)) {
        for (const operation of Object.values(item)) {
            if (operation.operationId === undefined) continue;
            const label = operationGroup(operation.operationId);
            if (label !== undefined) operation.tags = [label];
        }
    }

    /* The one cast, and it is the boundary this whole interface exists to hold. The generator's own return type
     * is a bag of optionals, because a generator has to allow for a caller that asked for none of this; what
     * comes back HERE is the document assembled two lines up, with every field the interface names supplied by
     * the call above or by this object. Widening once here is what keeps every reader downstream from casting. */
    return {
        ...(generated as unknown as SandboxSpecDocument),
        paths: inGroupOrder(paths),
        components: {
            ...(generated.components ?? {}),
            securitySchemes: securitySchemes(),
        },
    };
};

/* MINIFIED, because the only readers are machines. This is what the site writes to /api/openapi.json for
 * someone pointing their own tooling at the daemon; the reference pages render from the object, not from this
 * string. Nothing diffs it, so the 2 MB that indentation costs would buy a reader nothing — and a person who
 * does want to read it has the reference pages, which is the whole point of them. */
export const serializeSpec = (spec: SandboxSpecDocument): string => JSON.stringify(spec);
