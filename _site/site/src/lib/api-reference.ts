import { sandboxSpec, type SandboxSpecDocument, type SpecOperation } from "@intentic/sandbox-openapi";
import { exampleBody, exampleFor, type SchemaNode } from "./api-examples";

// Turns the OpenAPI document into flat operations (fields, examples, copyable commands) an Astro page renders; nothing
// downstream reads raw OpenAPI. Runs at build time; only finished text and a small per-group JSON reach the browser.

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

// Cuts a description to a short label: first sentence, then a word cap, with an ellipsis when it was trimmed.
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

// Cached once per build; Astro imports this module once and every group page awaits the same promise.
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

// Human type label, not the schema's own vocabulary: a fixed-value union becomes its values; a shape union becomes "one
// of N shapes".
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
        // Past four values, show the first four plus a count; more reads as a paragraph, not a cell.
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

// Field that picks a branch out of a discriminated union: the one property that is a single fixed value on every
// branch. Undefined when branches aren't told apart that way.
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

// Schema as a flat, depth-indented list of rows, matching the table the page renders. Past a depth cap a row says
// "nested further" instead of being silently dropped.
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

        // A union of shapes renders as the choice it is: each branch gets a heading row for its discriminator.
        const named = real.flatMap((branch) => {
            const tag = discriminatorOf(branch, root);
            return tag === undefined ? [] : [{ branch, tag }];
        });
        // Two levels deep, not one: a stream's answer union sits one level under the wire envelope, not at the top.
        if (named.length < 2 || depth > 2) {
            return schemaRows(real[0], root, depth);
        }

        // Enough to cover the two genuinely wide unions on this surface; past it the remainder is counted, not dropped.
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

// The real copyable curl command: same address, header and body as the actual call, with shell variables for the
// sandbox and token instead of fake literals.
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
        // Compact, not indented: a multi-line body inside a shell string is fragile to paste.
        lines.push(`  -d '${JSON.stringify(operation.body)}'`);
    }
    return lines.join("\n");
};

// Same call through the typed client, so the two ways of reaching a route sit side by side; the client mirrors the
// contract exactly (group, then route, then input).
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

// Reuses the generator's own parameter shape rather than redeclaring it; the schema field is narrowed once, at the read
// below.
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
        // Wire values are always text: a query or path value is a string even when the schema calls it a number.
        example: value === undefined || value === null ? "" : String(value),
        options: schema.enum?.every((entry) => typeof entry === "string") === true ? (schema.enum as string[]) : undefined,
    };
};

// Narrows the generator's `unknown` schema to `SchemaNode` in one place; every field is optional, so an unmatched shape
// falls through the walks above.
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
