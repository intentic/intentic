// The daemon's wire surface as one OpenAPI 3.1 document, generated from the contract, never hand-maintained: derived
// fields come from sandboxContract; authored ones (groups.ts, security.ts) do not. No committed copy: a route's diff
// already shows fully in the contract's own diff, unlike a deep, shared zod schema.

import { sandboxContract } from "@intentic/sandbox-contract";
import { OpenAPIGenerator } from "@orpc/openapi";
import { zodConverter } from "./converter.js";
import { SPEC_GROUPS, specGroup, specTags } from "./groups.js";
import { securityRequirement, securitySchemes } from "./security.js";

// Loopback name, not a hostname anybody else answers on; a sandbox has a per-workspace address instead.
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
    "The daemon runs beside your code. There is no shared server and no central API: the address below is your sandbox and nobody else's, which is also why the playground on this site answers from a simulation in your own tab rather than by calling anything.",
    "",
    "Two conventions cover the whole surface. Input rides in the path and query for a `GET` and in a JSON body otherwise. A failure comes back as a JSON object with a `message`, never as an empty body — a refusal is a result, not a crash.",
    "",
    "One route is open: `GET /health`. It is not in this document because it is not part of the contract — it exists so a script can tell a live sandbox from a dead port, and it deliberately checks nothing.",
].join("\n");

/** A single operation's group label, read from the leading segment of its id (`agent.run` → `agent`). */
const operationGroup = (operationId: string): string | undefined => specGroup(operationId.split(".")[0] ?? "")?.label;

// Only the fields anything reads, named once instead of three call sites re-declaring and casting. A `schema` stays
// `unknown`: this package converts JSON Schema, it does not interpret it.
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

// The generator's raw order follows the contract object's own key order, arbitrary and diff-noisy; rebuilds it in
// groups.ts's order so two runs are byte-identical.
const inGroupOrder = (paths: Record<string, SpecPathItem>): Record<string, SpecPathItem> => {
    const rank = new Map(SPEC_GROUPS.map((group, index) => [group.label, index]));
    const keyed = Object.entries(paths).map(([path, item], index) => {
        const first = Object.values(item)[0];
        const label = first?.operationId === undefined ? undefined : operationGroup(first.operationId);
        return { path, item, rank: label === undefined ? Number.MAX_SAFE_INTEGER : (rank.get(label) ?? Number.MAX_SAFE_INTEGER), index };
    });
    // Ties keep the contract's own order within a group (list before create before delete).
    keyed.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return Object.fromEntries(keyed.map((entry) => [entry.path, entry.item]));
};

// Unversioned by design: the daemon advertises the routes it implements instead of a version to branch on.
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

    // Tags come from operationId, not path: system.info/system.events break the group-prefix pattern.
    for (const item of Object.values(paths)) {
        for (const operation of Object.values(item)) {
            if (operation.operationId === undefined) {
                continue;
            }
            const label = operationGroup(operation.operationId);
            if (label !== undefined) {
                operation.tags = [label];
            }
        }
    }

    // The one cast this interface exists to justify: the object below supplies every field it names.
    return {
        ...(generated as unknown as SandboxSpecDocument),
        paths: inGroupOrder(paths),
        components: {
            ...generated.components,
            securitySchemes: securitySchemes(),
        },
    };
};

// Minified: the only readers are machines (served at /api/openapi.json); a person reads the reference pages instead.
export const serializeSpec = (spec: SandboxSpecDocument): string => JSON.stringify(spec);
