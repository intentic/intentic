import { sandboxSpec, type SandboxSpecDocument, type SpecOperation } from "@intentic/sandbox-openapi";
import { exampleBody, exampleFor, type SchemaNode } from "./api-examples";

/* THE GENERATED DOCUMENT, TURNED INTO WHAT A PAGE RENDERS.
 *
 * One side of this file reads OpenAPI; the other hands an Astro page a flat list of operations with their
 * fields, their examples and their copyable commands already made. Nothing downstream of here knows what a
 * `requestBody` is, which is the point: the reference pages are about presentation, and every question about
 * how oRPC spells something is answered once, here.
 *
 * IT ALL HAPPENS AT BUILD TIME. The pages are static HTML, so the schema walking, the example generation and
 * the snippet writing are paid once by the build and never by a reader. What reaches the browser is finished
 * text plus a small JSON payload per group for the playground — a few kilobytes against the few hundred that
 * shipping the group's schemas would have cost.
 */

export interface RefParam {
    name: string;
    in: "path" | "query";
    required: boolean;
    /** A word a reader recognises: "string", "number", "one of: a | b". */
    type: string;
    description?: string;
    /** What the playground puts in the field before anybody types. */
    example: string;
    /** Present when the value is a fixed set, so the playground offers a picker rather than a text box. */
    options?: string[];
}

/** One line of a schema tree: a field, how deep it sits, and what it holds. */
export interface RefRow {
    depth: number;
    name: string;
    type: string;
    required: boolean;
    description?: string;
}

export interface RefOperation {
    /** The anchor and the playground's key: the operation id with its dot turned into a dash. */
    id: string;
    operationId: string;
    method: string;
    path: string;
    summary: string;
    description: string;
    params: RefParam[];
    /** Absent for a route that takes no body, which is every GET and a few of the others. */
    body?: { required: boolean; rows: RefRow[]; example: string };
    answer: { rows: RefRow[]; example: string };
    /** True when the answer is a long-lived stream rather than one value. */
    streams: boolean;
    curl: string;
    typescript: string;
}

const SANDBOX = "https://sandbox-a1b2c3d4e5f6.intentic.dev";

/* A field note is a LABEL in a narrow cell, not prose. The contract's own descriptions run to full sentences,
 * which crowd a column built for a word or two, so a note is cut to the first handful of words: the first
 * sentence, then a hard word cap, with an ellipsis when the source ran longer so a reader knows the whole of
 * it lives in the OpenAPI document. */
const FEW_WORDS = 6;
const terse = (text: string | undefined): string | undefined => {
    const trimmed = text?.trim();
    if (trimmed === undefined || trimmed === "") {
        return undefined;
    }
    const firstSentence = trimmed.split(/(?<=[.!?])\s/u)[0] ?? trimmed;
    const words = firstSentence.replace(/[.,;:]+$/u, "").split(/\s+/u);
    return words.length <= FEW_WORDS ? words.join(" ") : `${words.slice(0, FEW_WORDS).join(" ")}…`;
};

/* Loaded once for the whole build rather than once per page. Astro imports this module a single time and the
 * 39 group pages all await the same promise, so the generator runs once for 269 operations instead of 39
 * times, which is the difference between a build step and a build problem. */
let cached: Promise<SandboxSpecDocument> | undefined;
const spec = (): Promise<SandboxSpecDocument> => (cached ??= sandboxSpec());

const firstType = (schema: SchemaNode): string | undefined =>
    Array.isArray(schema.type) ? schema.type.find((entry) => entry !== "null") : schema.type;

const resolve = (schema: SchemaNode | undefined, root: SchemaNode): SchemaNode | undefined => {
    if (schema === undefined) {
        return undefined;
    }
    if (schema.$ref === undefined) {
        return schema;
    }
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : undefined;
    return name === undefined ? undefined : root.$defs?.[name];
};

/* A TYPE A READER RECOGNISES. Deliberately not the schema's own vocabulary: nobody wants to read
 * `{"anyOf":[{"type":"string"},{"type":"null"}]}` to learn that a field is an optional string. Unions of
 * fixed values become the values, because that is the useful half; unions of shapes become "one of several
 * shapes", because listing them inline is a paragraph in a table cell. */
const typeLabel = (raw: SchemaNode | undefined, root: SchemaNode, depth = 0): string => {
    const schema = resolve(raw, root);
    if (schema === undefined || depth > 4) {
        return "unknown";
    }
    if (schema.const !== undefined) {
        return JSON.stringify(schema.const);
    }
    if (schema.enum !== undefined) {
        const values = schema.enum.map((entry) => JSON.stringify(entry));
        // Past four the cell turns into a paragraph, and the reader's question is answered by the first few
        // plus a count.
        return values.length > 4 ? `${values.slice(0, 4).join(" | ")} … (${values.length})` : values.join(" | ");
    }

    const branches = schema.anyOf ?? schema.oneOf;
    if (branches !== undefined) {
        const real = branches.filter((entry) => firstType(entry) !== "null");
        const nullable = real.length !== branches.length;
        if (real.length === 1) {
            return `${typeLabel(real[0], root, depth + 1)}${nullable ? " | null" : ""}`;
        }
        const labels = real.map((entry) => typeLabel(entry, root, depth + 1));
        const distinct = [...new Set(labels)];
        if (distinct.every((entry) => !entry.includes("{"))) {
            return distinct.join(" | ") + (nullable ? " | null" : "");
        }
        return `one of ${real.length} shapes`;
    }
    if (schema.allOf !== undefined) {
        return "object";
    }

    const type = firstType(schema);
    if (type === "array") {
        return `${typeLabel(schema.items, root, depth + 1)}[]`;
    }
    if (type === "object" || schema.properties !== undefined) {
        return "object";
    }
    return type ?? "unknown";
};

/* WHICH FIELD PICKS THIS BRANCH OUT OF A UNION, and what it has to be. A discriminated union spells that as a
 * single-valued property on every branch, so the branch is identified by the one field that can only be one
 * thing. Returns undefined for a union whose branches are not told apart that way, which is the signal to fall
 * back to documenting the first branch rather than inventing a distinction the schema does not make. */
const discriminatorOf = (branch: SchemaNode, root: SchemaNode): { field: string; value: string } | undefined => {
    const resolved = resolve(branch, root);
    for (const [name, child] of Object.entries(resolved?.properties ?? {})) {
        const property = resolve(child, root);
        if (property?.const !== undefined) {
            return { field: name, value: JSON.stringify(property.const) };
        }
        if (property?.enum?.length === 1) {
            return { field: name, value: JSON.stringify(property.enum[0]) };
        }
    }
    return undefined;
};

/* A SCHEMA AS A LIST OF LINES, indented by nesting. Flat rather than a tree of components because that is
 * what the page renders: a table where a child sits one step in from its parent, which is legible at four
 * levels in a way that nested boxes are not.
 *
 * Depth is capped, and past the cap a branch says so rather than being silently dropped. A reader who sees
 * "nested further" knows to look at the example beside it; a reader shown nothing concludes the object is
 * empty. */
const schemaRows = (raw: SchemaNode | undefined, root: SchemaNode, depth = 0): RefRow[] => {
    const schema = resolve(raw, root);
    if (schema === undefined) {
        return [];
    }
    if (depth > 3) {
        return [];
    }

    const branches = schema.anyOf ?? schema.oneOf;
    if (branches !== undefined) {
        const real = branches.filter((entry) => firstType(entry) !== "null");
        if (real.length === 0) {
            return [];
        }
        if (real.length === 1) {
            return schemaRows(real[0], root, depth);
        }

        /* A CHOICE BETWEEN SHAPES, rendered as the choice it is. Connecting something, a capability's config,
         * is twenty different shapes behind one route, and the union is the whole content of the request: a
         * table that showed the first branch and stopped documented one twentieth of the call while looking
         * complete, which is the worst way for a reference to be wrong.
         *
         * Each branch gets a heading row naming the value that selects it, with its own fields indented under
         * it. Interleaving them instead would read as one object with contradictory fields, which is the
         * failure this shape exists to avoid. Beyond the cap the remainder is counted rather than dropped,
         * because a reader who sees "and 6 more" knows to open the document, and one shown nothing does not. */
        const named = real.flatMap((branch) => {
            const tag = discriminatorOf(branch, root);
            return tag === undefined ? [] : [{ branch, tag }];
        });
        /* Expanded two levels deep, not one, because of exactly one shape: a stream's frames sit inside the
         * wire envelope, so the union that IS the answer, the forty kinds of thing a turn can say, is a level
         * further down than every other union on this surface. Stopping at one level documented the envelope
         * and then showed the first frame kind as though it were the only one. */
        if (named.length < 2 || depth > 2) {
            return schemaRows(real[0], root, depth);
        }

        /* Enough that the two genuinely wide unions on this surface, connecting something and answering a
         * parked card, are documented rather than sampled. Past twenty a table stops being a table, and the
         * remainder is counted so a reader knows to open the document rather than concluding they have it all. */
        const SHOWN = 20;
        const rows: RefRow[] = named
            .slice(0, SHOWN)
            .flatMap(({ branch, tag }) => [
                { depth, name: `when ${tag.field} is ${tag.value}`, type: "shape", required: false },
                ...schemaRows(branch, root, depth + 1).filter((row) => row.name !== tag.field),
            ]);
        if (named.length > SHOWN) {
            rows.push({
                depth,
                name: `… and ${named.length - SHOWN} more shapes`,
                type: "shape",
                required: false,
                description: "In the OpenAPI document",
            });
        }
        return rows;
    }
    if (schema.allOf !== undefined) {
        return schema.allOf.flatMap((entry) => schemaRows(entry, root, depth));
    }
    if (firstType(schema) === "array") {
        return schemaRows(schema.items, root, depth);
    }

    const properties = schema.properties;
    if (properties === undefined) {
        return [];
    }

    const required = new Set(schema.required ?? []);
    return Object.entries(properties).flatMap(([name, child]) => {
        const resolved = resolve(child, root) ?? {};
        const row: RefRow = {
            depth,
            name,
            type: typeLabel(child, root),
            required: required.has(name),
            description: terse(resolved.description),
        };
        const nested = firstType(resolved) === "array" ? resolve(resolved.items, root) : resolved;
        const goesDeeper = nested !== undefined && (nested.properties !== undefined || nested.anyOf !== undefined || nested.oneOf !== undefined);
        return goesDeeper && depth < 3 ? [row, ...schemaRows(nested, root, depth + 1)] : [row];
    });
};

const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? "null";

/** A path with its templated segments filled in from the example values, ready to paste. */
const fillPath = (path: string, params: RefParam[]): string =>
    path.replace(/\{([^}]+)\}/gu, (_match, name: string) => encodeURIComponent(params.find((entry) => entry.name === name)?.example ?? name));

const queryString = (params: RefParam[]): string => {
    const pairs = params
        .filter((entry) => entry.in === "query" && entry.required)
        .map((entry) => `${entry.name}=${encodeURIComponent(entry.example)}`);
    return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
};

/* THE COPYABLE COMMAND, and it is the real one. The playground beside it answers from a simulation, so this is
 * the page's promise that the thing being demonstrated exists: same address, same header, same body. It uses
 * shell variables for the sandbox and the token rather than baking in fake ones, because a reader who pastes
 * this has their own two values and a literal placeholder in the middle of a URL is an easy thing to miss. */
const curlFor = (operation: { method: string; path: string; params: RefParam[]; body?: unknown; streams: boolean }): string => {
    const address = `"$SANDBOX${fillPath(operation.path, operation.params)}${queryString(operation.params)}"`;
    const lines: string[] = [];
    const method = operation.method.toUpperCase();
    // curl's default is GET, so spelling it out would be noise; every other verb has to be named.
    const verb = method === "GET" ? "" : `-X ${method} `;
    // -N turns off buffering, without which a stream arrives in silence and then all at once.
    lines.push(`curl ${operation.streams ? "-N " : ""}${verb}${address} \\`);
    lines.push(`  -H "x-intentic-control: $INTENTIC_TOKEN"${operation.body === undefined ? "" : " \\"}`);
    if (operation.body !== undefined) {
        lines.push(`  -H "content-type: application/json" \\`);
        // Compact rather than indented: a multi-line body inside a shell string is fragile to paste and the
        // structure is already laid out in the schema table above it.
        lines.push(`  -d '${JSON.stringify(operation.body)}'`);
    }
    return lines.join("\n");
};

/* The same call through the typed client an extension is handed, so the two ways of reaching a route sit side
 * by side. The client mirrors the contract exactly — group, then route, then the input — which is worth
 * showing precisely because it is not obvious from the URL that `POST /git/{repo}/commit` is `git.commit`. */
const typescriptFor = (operationId: string, params: RefParam[], body: Record<string, unknown> | undefined): string => {
    const [group = "", route = ""] = operationId.split(".");
    const input: Record<string, unknown> = {};
    for (const param of params) {
        if (param.required) {
            input[param.name] = param.example;
        }
    }
    Object.assign(input, body ?? {});
    const argument = Object.keys(input).length === 0 ? "" : pretty(input);
    return `import { sandbox } from "@intentic/sandbox-client";\n\nconst result = await sandbox.${group}.${route}(${argument});`;
};

/* Takes the document's own parameter shape with its schema already narrowed, so this file declares that shape
 * nowhere: the generator names it, and the one narrowing happens at the read below. */
type SpecParam = NonNullable<SpecOperation["parameters"]>[number];

const paramFrom = (raw: Omit<SpecParam, "schema"> & { schema?: SchemaNode }, root: SchemaNode): RefParam => {
    const schema = resolve(raw.schema, root) ?? {};
    const value = exampleFor(schema, raw.name);
    return {
        name: raw.name,
        in: raw.in === "path" ? "path" : "query",
        required: raw.required === true,
        type: typeLabel(schema, root),
        description: terse(raw.description ?? schema.description),
        // Everything on the wire is text: a query value and a path segment are strings even when the schema
        // calls them numbers, so the playground's field holds a string and this matches it.
        example: value === undefined || value === null ? "" : String(value),
        options: schema.enum?.every((entry) => typeof entry === "string") === true ? (schema.enum as string[]) : undefined,
    };
};

/* WHERE A SCHEMA STOPS BEING OPAQUE. The generator hands schemas over as `unknown`, deliberately: a JSON
 * Schema is general, and that package converts them rather than interpreting them, so it declines to claim a
 * shape the contract is free to grow tomorrow. This file is the one that DOES interpret them, and `SchemaNode`
 * is its reading — every field optional, every branch guarded, so a node that turns out to have none of them
 * simply falls through the walks above. Narrowing in one named place is what keeps that reading out of the
 * five call sites that would otherwise each assert it for themselves. */
const asSchema = (schema: unknown): SchemaNode | undefined => (schema === null || typeof schema !== "object" ? undefined : (schema as SchemaNode));

/** Every operation in one route group, in the document's own order. */
export const groupOperations = async (group: string): Promise<RefOperation[]> => {
    const document = await spec();
    const paths = document.paths;
    const out: RefOperation[] = [];

    for (const [path, item] of Object.entries(paths)) {
        for (const [method, raw] of Object.entries(item)) {
            const operationId = raw.operationId ?? "";
            if (operationId.split(".")[0] !== group) {
                continue;
            }

            const params = (raw.parameters ?? []).map((parameter) => paramFrom({ ...parameter, schema: asSchema(parameter.schema) }, {}));

            const requestSchema = asSchema(raw.requestBody?.content?.["application/json"]?.schema);
            const bodyExample = exampleBody(requestSchema);

            const answerContent = raw.responses?.["200"]?.content ?? {};
            const streams = "text/event-stream" in answerContent;
            const answerSchema = asSchema(answerContent["application/json"]?.schema ?? answerContent["text/event-stream"]?.schema);
            const answerRoot = answerSchema ?? {};

            out.push({
                id: operationId.replace(/\./gu, "-"),
                operationId,
                method: method.toUpperCase(),
                path,
                summary: raw.summary ?? operationId,
                description: raw.description ?? "",
                params,
                body:
                    requestSchema === undefined || bodyExample === undefined
                        ? undefined
                        : {
                              required: raw.requestBody?.required === true,
                              rows: schemaRows(requestSchema, requestSchema),
                              example: pretty(bodyExample),
                          },
                answer: {
                    rows: schemaRows(answerSchema, answerRoot),
                    example: pretty(exampleFor(answerSchema)),
                },
                streams,
                curl: curlFor({ method, path, params, body: bodyExample, streams }),
                typescript: typescriptFor(operationId, params, bodyExample),
            });
        }
    }
    return out;
};

/** The whole document, for the route that serves it. */
export const openApiDocument = (): Promise<SandboxSpecDocument> => spec();

/** How many operations each group has, for the index page's cards. */
export const groupCounts = async (): Promise<Record<string, number>> => {
    const document = await spec();
    const paths = document.paths;
    const counts: Record<string, number> = {};
    for (const item of Object.values(paths)) {
        for (const raw of Object.values(item)) {
            const group = (raw.operationId ?? "").split(".")[0];
            if (group !== undefined && group !== "") {
                counts[group] = (counts[group] ?? 0) + 1;
            }
        }
    }
    return counts;
};

/** What the playground needs in the browser: no schemas, just the fields and the answer already made. */
export const playgroundPayload = (operations: RefOperation[]): string =>
    JSON.stringify(
        operations.map((operation) => ({
            id: operation.id,
            method: operation.method,
            path: operation.path,
            streams: operation.streams,
            sandbox: SANDBOX,
            params: operation.params.map((parameter) => ({
                name: parameter.name,
                in: parameter.in,
                required: parameter.required,
                example: parameter.example,
                options: parameter.options,
            })),
            body: operation.body?.example,
            answer: operation.answer.example,
        })),
    );
