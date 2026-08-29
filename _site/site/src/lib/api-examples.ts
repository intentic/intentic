/* PLAUSIBLE VALUES FOR A JSON SCHEMA, so the reference shows payloads that read like a real sandbox's.
 *
 * WHY NOT JUST PRINT THE SCHEMA. A schema says `{ branch: string, ahead: integer }`, and a reader has to
 * imagine the answer. What they want to see is `{ branch: "main", ahead: 2 }` — the shape AND what it looks
 * like full. Every reference that feels good does this, and the ones that feel like a type dump do not.
 *
 * VALUES ARE CHOSEN BY FIELD NAME FIRST, and that is the whole trick. `"string"` everywhere is worse than no
 * example at all: it teaches nothing and reads as a placeholder, which is what makes generated documentation
 * feel generated. A field called `branch` gets `main`, `path` gets a real-looking source path, anything ending
 * in `At` gets a timestamp. The dictionary below is the vocabulary of this particular API, so it is worth its
 * length: it is what turns 255 schema dumps into 255 examples.
 *
 * DETERMINISTIC, WITH NO CLOCK AND NO RANDOMNESS. The pages are static HTML built from this, so a value that
 * moved would churn every one of them on every build, and a screenshot taken from one would be describing a
 * page the next build does not have. Every timestamp below is the same fixed instant.
 *
 * IT RUNS AT BUILD TIME, ONCE PER OPERATION, and only the finished JSON is shipped. The alternative was to
 * send each group's schemas to the browser and generate there, which for the git group alone is a few hundred
 * kilobytes of schema so a reader can watch a value be invented. The playground ships the answer instead.
 */

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

/* THE ONE INSTANT THIS WHOLE REFERENCE HAPPENS AT. A single stamp rather than a spread of them: two fields on
 * one object showing times three days apart invite a reader to infer a relationship that is not there. */
const WHEN = "2026-08-21T09:14:02.000Z";
const EARLIER = "2026-08-21T08:47:11.000Z";
const SHA = "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

/* THE VOCABULARY, matched on the field's own name, lower-cased. Exact names first (below), then the suffix
 * rules in `byShape`, then the schema's own type. Ordered by how specific the match is, so `filePath` is a
 * path and `pathPrefix` is not silently one too. */
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

/* THE SECOND ENTRY IN A LIST. A list rendered as the same object twice reads as a rendering bug, and the
 * question a reader actually has about a list — do these vary, and how — is answered by the differences. So
 * the common leaves get an alternate, and everything without one repeats, which is honest: a field whose
 * value this file cannot vary meaningfully is one where a second guess would be noise. */
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

/* Suffix and substring rules, applied when the exact name is unknown. These carry most of the timestamps and
 * ids, which between them are a good third of every payload in this API. */
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

/* THE FIELD'S OWN WORDS BEAT THE DICTIONARY, and this rule exists because of one real collision. `from` and
 * `to` are a renamed file's two paths on half a dozen git routes and the two ends of a day range on the usage
 * and settings routes. No global guess can be right for both, and the schema's `type` is `string` in every
 * case, so the only thing that can tell them apart is what the contract says the field is — which is exactly
 * what a `.describe()` is for.
 *
 * Kept to shapes a description states OUTRIGHT rather than anything inferred: a description that says
 * YYYY-MM-DD means a date, and one that says ISO timestamp means an instant. Guessing from prose beyond that
 * would make every reworded sentence in the contract a silent change to these pages. */
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

/* Resolve `#/$defs/x` against the schema the walk started from. The generator emits exactly one shape of
 * reference — a local definition, for the handful of recursive types (a file tree, a transcript) — so this
 * deliberately understands that one and nothing else, and returns undefined rather than guessing at a form
 * it has never seen. */
const resolve = (schema: SchemaNode, root: SchemaNode): SchemaNode | undefined => {
    if (schema.$ref === undefined) {
        return schema;
    }
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : undefined;
    return name === undefined ? undefined : root.$defs?.[name];
};

/* THE WALK. `depth` is what stops a recursive type — a directory whose children are directories — from
 * expanding for ever; at the limit it stops rather than emitting a truncated object, so what comes out is
 * always a value the schema would accept. */
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
    // The second entry in a list takes the second choice where the schema offers one, for the same reason it
    // takes an alternate value: a list of two identical enums says nothing about what the field varies over.
    if (schema.enum !== undefined && schema.enum.length > 0) {
        return schema.enum[Math.min(variant, schema.enum.length - 1)];
    }

    /* A union takes its first branch, minus the `null` one. Zod emits an optional as `anyOf: [T, null]` and a
     * discriminated union as a list of object branches; in both cases the first non-null branch is the case a
     * reader wants to see, and showing `null` for an optional field teaches nothing. */
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
        /* A record — an object with no named properties but a shape for its values — gets two entries rather
         * than one, because one entry reads like a fixed field and two read like a map. */
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
        /* Two entries, not one, and the second one DIFFERENT. A list rendered with a single element reads as
         * an object with a stray bracket round it; a list rendered as the same element twice reads as a
         * rendering bug. What a reader wants to know about a list is what varies between its entries. */
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
        // Type-check the dictionary hit against the schema, so a field called `count` declared as a string
        // does not come out as a number the daemon would refuse.
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
    // `unknown` in the contract, which is a real shape a few routes have: an opaque payload forwarded whole.
    return {};
};

/** A plausible value for one schema, named as the field it sits under so the vocabulary can be applied. */
export const exampleFor = (schema: SchemaNode | undefined, name = ""): unknown => build(schema, name, schema ?? {}, 0);

/** A plausible value that is always an object, for a request or response body. */
export const exampleBody = (schema: SchemaNode | undefined): Record<string, unknown> | undefined => {
    const value = exampleFor(schema);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
};
