// Plausible example values for a JSON Schema, keyed by field name; deterministic (fixed instant, no randomness) so the
// generated pages don't churn. Runs at build time; only the finished JSON ships.

/** A JSON Schema node, as much of one as this file needs to look at. */
export interface SchemaNode {
    type?: string | string[];
    properties?: Record<string, SchemaNode>;
    required?: string[];
    items?: SchemaNode;
    enum?: unknown[];
    const?: unknown;
    format?: string;
    default?: unknown;
    description?: string;
    anyOf?: SchemaNode[];
    oneOf?: SchemaNode[];
    allOf?: SchemaNode[];
    additionalProperties?: SchemaNode | boolean;
    $ref?: string;
    $defs?: Record<string, SchemaNode>;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    minItems?: number;
    nullable?: boolean;
}

// One fixed instant, not several: timestamps apart on one object would imply a relationship that isn't there.
const WHEN = "2026-08-21T09:14:02.000Z";
const EARLIER = "2026-08-21T08:47:11.000Z";
const SHA = "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

// Matched by lower-cased name: exact names here, then `byShape` suffixes, then schema type; most specific wins.
const BY_NAME: Record<string, unknown> = {
    // ── the workspace ──
    path: "src/app.ts",
    filepath: "src/app.ts",
    paths: ["src/app.ts", "README.md"],
    dir: "src",
    directory: "src",
    from: "src/app.ts",
    to: "src/server.ts",
    content: "export const start = () => listen(PORT);\n",
    text: "export const start = () => listen(PORT);\n",
    contents: "export const start = () => listen(PORT);\n",
    filename: "app.ts",
    extension: "ts",
    language: "typescript",
    size: 2048,
    bytes: 2048,
    lines: 74,

    // ── git ──
    repo: "root",
    repos: ["root", "site"],
    branch: "main",
    branches: ["main", "agent/still-ridge"],
    ref: "refs/heads/main",
    sha: SHA,
    commit: SHA,
    oid: SHA,
    parent: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    previoussha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    subject: "Fix the flaky parser test",
    author: "Ada Lovelace",
    email: "ada@example.com",
    remote: "origin",
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
    staged: true,
    tracked: true,
    additions: 34,
    deletions: 12,
    insertions: 34,

    // ── agents and turns ──
    prompt: "Update the changelog for the last five commits.",
    conversationid: "nightly-changelog",
    run: "run_8c2f41d9",
    runid: "run_8c2f41d9",
    turn: "turn_31",
    isolated: true,
    seq: 41,
    cursor: 41,
    after: 0,
    role: "assistant",
    model: "claude-sonnet-4-6",
    provider: "claude",
    account: "work",
    tokens: 18_420,
    cost: 0.42,

    // ── identity and shape ──
    id: "a1b2c3d4",
    slug: "nightly-changelog",
    name: "nightly changelog",
    label: "Nightly changelog",
    title: "Update the changelog",
    summary: "Five commits since the last release.",
    description: "Runs every night and opens a pull request when anything changed.",
    kind: "workspace",
    state: "idle",
    status: "ok",
    reason: "Nothing had changed since the last run.",
    version: "1.4.0",
    key: "OPENAI_API_KEY",
    value: "…",
    scope: "read",
    token: "ict_9wQ4rTz8kLmN3pXbV7hJ",

    // ── the sandbox ──
    sandboxid: "a1b2c3d4e5f6",
    workspaceid: "a1b2c3d4e5f6",
    url: "https://sandbox-a1b2c3d4e5f6.intentic.dev",
    host: "sandbox-a1b2c3d4e5f6.intentic.dev",
    port: 5173,
    pid: 4821,
    session: "panel-root--dev",
    terminal: "panel-root--dev",
    command: "pnpm dev",
    cwd: "/work",
    country: "DE",
    countries: ["DE", "NL", "SE"],
    ip: "203.0.113.42",

    // ── booleans that read wrong as `false` ──
    ok: true,
    enabled: true,
    running: true,
    available: true,
    live: true,
    connected: true,
    installed: true,
    dirty: true,
    clean: false,
    archived: false,
    force: false,
    all: false,

    // ── counts ──
    count: 3,
    total: 3,
    remaining: 41,
    allowance: 50,
    used: 9,
    index: 0,
    limit: 50,
    offset: 0,
};

// A second, different value per field; a list of two identical entries would read as a rendering bug.
const ALTERNATE: Record<string, unknown> = {
    path: "README.md",
    filepath: "README.md",
    filename: "README.md",
    dir: "docs",
    directory: "docs",
    from: "docs/index.md",
    to: "docs/getting-started.md",
    extension: "md",
    language: "markdown",
    repo: "site",
    branch: "agent/still-ridge",
    sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    oid: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    subject: "Document the pre-push check",
    author: "Grace Hopper",
    email: "grace@example.com",
    id: "e5f6a7b8",
    slug: "release-notes",
    name: "release notes",
    label: "Release notes",
    title: "Draft the release notes",
    conversationid: "release-notes",
    port: 4173,
    pid: 4822,
    size: 984,
    bytes: 984,
    lines: 31,
    additions: 8,
    deletions: 3,
    insertions: 8,
    ahead: 0,
    behind: 1,
    count: 1,
    total: 1,
    index: 1,
    seq: 42,
    tokens: 6_310,
    cost: 0.11,
    country: "NL",
    ip: "198.51.100.7",
    session: "panel-site--dev",
    command: "pnpm build",
    model: "claude-haiku-4-6",
    version: "1.3.2",
    key: "DISCORD_BOT_TOKEN",
    scope: "drive",
};

// Suffix and substring rules, applied when the exact field name isn't in `BY_NAME`.
const byShape = (name: string): unknown | undefined => {
    if (name.endsWith("at") && name.length > 2) {
        return WHEN;
    }
    if (name.endsWith("time") || name === "timestamp") {
        return WHEN;
    }
    if (name.endsWith("since")) {
        return EARLIER;
    }
    if (name.endsWith("id") || name.endsWith("ids")) {
        return name.endsWith("s") ? ["a1b2c3d4", "e5f6a7b8"] : "a1b2c3d4";
    }
    if (name.endsWith("sha")) {
        return SHA;
    }
    if (name.endsWith("path") || name.endsWith("paths")) {
        return name.endsWith("s") ? ["src/app.ts"] : "src/app.ts";
    }
    if (name.endsWith("url") || name.endsWith("uri")) {
        return "https://sandbox-a1b2c3d4e5f6.intentic.dev";
    }
    if (name.endsWith("count") || name.endsWith("total")) {
        return 3;
    }
    if (name.endsWith("message")) {
        return "Fix the flaky parser test";
    }
    if (name.endsWith("error")) {
        return "The repository has no remote configured.";
    }
    return undefined;
};

// Falls back to what a field's `.describe()` states outright (YYYY-MM-DD, ISO timestamp); a name-based guess can't tell
// `from`/`to` on a git diff from `from`/`to` on a date range.
const fromDescription = (description: string | undefined): unknown | undefined => {
    if (description === undefined) {
        return undefined;
    }
    const lower = description.toLowerCase();
    if (lower.includes("yyyy-mm-dd")) {
        return "2026-08-21";
    }
    if (lower.includes("iso") && (lower.includes("timestamp") || lower.includes("instant") || lower.includes("stamp"))) {
        return WHEN;
    }
    return undefined;
};

/** Format-driven values, for the handful of formats the contract actually emits. */
const BY_FORMAT: Record<string, unknown> = {
    "date-time": WHEN,
    date: "2026-08-21",
    uri: "https://sandbox-a1b2c3d4e5f6.intentic.dev",
    url: "https://sandbox-a1b2c3d4e5f6.intentic.dev",
    email: "you@example.com",
    uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    hostname: "sandbox-a1b2c3d4e5f6.intentic.dev",
    ipv4: "203.0.113.42",
};

const firstType = (schema: SchemaNode): string | undefined =>
    Array.isArray(schema.type) ? schema.type.find((entry) => entry !== "null") : schema.type;

// Resolves `#/$defs/x` against the schema root. The generator only emits local-definition refs (recursive types like
// file trees or transcripts); anything else returns undefined.
const resolve = (schema: SchemaNode, root: SchemaNode): SchemaNode | undefined => {
    if (schema.$ref === undefined) {
        return schema;
    }
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : undefined;
    return name === undefined ? undefined : root.$defs?.[name];
};

// Builds an example value from a schema node; `depth` bounds recursion on self-referential types so it stops instead of
// emitting a value the schema wouldn't accept.
const build = (raw: SchemaNode | undefined, name: string, root: SchemaNode, depth: number, variant = 0): unknown => {
    if (raw === undefined || depth > 5) {
        return undefined;
    }
    const schema = resolve(raw, root);
    if (schema === undefined) {
        return undefined;
    }

    // A fixed value beats every heuristic: it is the only value the schema permits.
    if (schema.const !== undefined) {
        return schema.const;
    }
    // Second array entry takes the enum's second value, if any; identical entries say nothing about what varies.
    if (schema.enum !== undefined && schema.enum.length > 0) {
        return schema.enum[Math.min(variant, schema.enum.length - 1)];
    }

    // First non-null branch of `anyOf`/`oneOf`; Zod encodes an optional as `[T, null]`, and null teaches nothing.
    const branches = schema.anyOf ?? schema.oneOf;
    if (branches !== undefined) {
        const branch = branches.find((entry) => firstType(entry) !== "null");
        return build(branch, name, root, depth + 1, variant);
    }
    if (schema.allOf !== undefined) {
        // Merged, because `allOf` here is intersection: each branch contributes its own properties.
        const merged = schema.allOf.map((entry) => build(entry, name, root, depth + 1, variant)).filter((entry) => entry !== undefined);
        return Object.assign({}, ...merged.filter((entry) => typeof entry === "object" && entry !== null));
    }

    const type = firstType(schema);
    const lower = name.toLowerCase();

    if (type === "object" || schema.properties !== undefined) {
        const properties = schema.properties ?? {};
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(properties)) {
            const value = build(child, key, root, depth + 1, variant);
            if (value !== undefined) {
                out[key] = value;
            }
        }
        // A record (object with no named properties) gets two entries; one would read as a fixed field, not a map.
        if (Object.keys(properties).length === 0 && typeof schema.additionalProperties === "object") {
            const first = build(schema.additionalProperties, name, root, depth + 1, 0);
            const second = build(schema.additionalProperties, name, root, depth + 1, 1);
            if (first !== undefined) {
                return { "src/app.ts": first, "README.md": second ?? first };
            }
        }
        return out;
    }

    if (type === "array") {
        const named = BY_NAME[lower] ?? byShape(lower);
        if (Array.isArray(named)) {
            return named;
        }
        // Two different entries, not a repeat: a single or duplicated element reads as a bug rather than real data.
        const singular = lower.replace(/s$/u, "");
        const first = build(schema.items, singular, root, depth + 1, 0);
        if (first === undefined) {
            return [];
        }
        const second = build(schema.items, singular, root, depth + 1, 1);
        return [first, second ?? first];
    }

    if (schema.default !== undefined) {
        return schema.default;
    }

    const stated = fromDescription(schema.description);
    if (stated !== undefined) {
        return stated;
    }

    const alternate = variant > 0 ? ALTERNATE[lower] : undefined;
    const named = alternate ?? BY_NAME[lower] ?? byShape(lower);
    if (named !== undefined && (typeof named !== "object" || type === undefined)) {
        // Type-checks the dictionary hit against the schema so a string-typed `count` can't come back as a number.
        if (type === undefined) {
            return named;
        }
        if (type === "string" && typeof named === "string") {
            return named;
        }
        if ((type === "number" || type === "integer") && typeof named === "number") {
            return named;
        }
        if (type === "boolean" && typeof named === "boolean") {
            return named;
        }
    }

    if (type === "string") {
        const byFormat = schema.format === undefined ? undefined : BY_FORMAT[schema.format];
        if (byFormat !== undefined) {
            return byFormat;
        }
        return "…";
    }
    if (type === "integer") {
        return schema.minimum ?? 1;
    }
    if (type === "number") {
        return schema.minimum ?? 1;
    }
    if (type === "boolean") {
        return true;
    }
    if (type === "null") {
        return null;
    }
    // Fallback for `unknown` in the contract: an opaque payload forwarded whole.
    return {};
};

/** A plausible value for one schema, named as the field it sits under so the vocabulary can be applied. */
export const exampleFor = (schema: SchemaNode | undefined, name = ""): unknown => build(schema, name, schema ?? {}, 0);

/** A plausible value that is always an object, for a request or response body. */
export const exampleBody = (schema: SchemaNode | undefined): Record<string, unknown> | undefined => {
    const value = exampleFor(schema);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
};
