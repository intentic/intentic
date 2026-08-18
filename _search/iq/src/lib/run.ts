import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandContext } from "@stricli/core";
import { createEngine, parseFeatures, type QueryOutcome, type Verb, type VerbOptions } from "@intentic/iq-engine";
import { loadConfig } from "../env.config.js";
import { echoOf, parseLangs, rootRelativeAnchor, rootRelativePaths, type ScopeFlags, type SearchFlags, toRender, toScope } from "./flags.js";

export type OutputMode = "text" | "json" | "ndjson";

// Explicit flag beats env; both flags together is a usage error.
export const resolveMode = (flags: { json: boolean; ndjson: boolean }, envMode: OutputMode): OutputMode => {
    if (flags.json && flags.ndjson) {
        throw new Error("--json and --ndjson are mutually exclusive");
    }
    if (flags.ndjson) {
        return "ndjson";
    }
    if (flags.json) {
        return "json";
    }
    return envMode;
};

const emit = (write: (chunk: string) => void, mode: OutputMode, outcome: QueryOutcome): void => {
    if (mode === "text") {
        write(outcome.text);
        return;
    }
    if (mode === "json") {
        write(`${JSON.stringify(outcome.result, undefined, 4)}\n`);
        return;
    }
    const { groups, ...meta } = outcome.result;
    for (const group of groups) {
        write(`${JSON.stringify({ kind: "group", ...group })}\n`);
    }
    write(`${JSON.stringify({ kind: "result", ...meta })}\n`);
};

export const engineFromEnv = (featuresSpec?: string): ReturnType<typeof createEngine> => {
    const config = loadConfig();
    return createEngine({
        root: workspaceRoot(),
        features: parseFeatures(featuresSpec ?? (config.iqFeatures === "" ? undefined : config.iqFeatures)),
        ...(config.iqRgPath !== "" ? { rgPath: config.iqRgPath } : {}),
        ...(config.iqModelDir !== "" ? { modelDir: config.iqModelDir } : {}),
    });
};

// Verbs whose query is (or starts with) a workspace path — resolved like --in, not searched.
const PATH_QUERY_VERBS = new Set<Verb>(["outline", "context", "who"]);

// `impact` is the one verb whose query is a LIST of paths rather than a single anchor, and an empty one is
// meaningful (it means "read my uncommitted changes"), so it cannot go through the anchor resolver.
const resolveQuery = (verb: Verb, query: string, root: string): string => {
    if (verb === "impact") {
        return rootRelativePaths(
            query
                .split(",")
                .map((path) => path.trim())
                .filter((path) => path !== ""),
            root,
        ).join(",");
    }
    return PATH_QUERY_VERBS.has(verb) ? rootRelativeAnchor(query, root) : query;
};

// The sandbox pins WORKSPACE_ROOT (to /work), but agent sessions run in per-conversation worktrees OUTSIDE the
// pin — transcript mining showed every such session silently searching the main checkout instead of its own
// tree, and every worktree path zero-hitting. A pin the caller is not inside points at the wrong code: re-root
// at the enclosing git workspace, falling back to cwd itself (matching the unpinned default).
export const workspaceRoot = (): string => {
    const config = loadConfig();
    const cwd = process.cwd();
    const pinned = config.workspaceRoot === "" ? cwd : config.workspaceRoot;
    if (cwd === pinned || cwd.startsWith(`${pinned}/`)) {
        return pinned;
    }
    for (let dir = cwd; dirname(dir) !== dir; dir = dirname(dir)) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }
    }
    return cwd;
};

// The one executor every search verb goes through: build engine from env, resolve path frames to root-relative,
// run, emit in the resolved mode, and set the grep-convention exit code (0 hits, 1 none; thrown errors become 2
// in cli.ts).
export const runSearch = async (context: CommandContext, verb: Verb, query: string, rawFlags: SearchFlags, options: VerbOptions): Promise<void> => {
    const mode = resolveMode(rawFlags, loadConfig().intenticOutput);
    const root = workspaceRoot();
    const flags = rawFlags.in === undefined ? rawFlags : { ...rawFlags, in: rootRelativePaths(rawFlags.in, root) };
    const resolvedQuery = resolveQuery(verb, query, root);
    const outcome = await engineFromEnv(flags.features).run({
        verb,
        query: resolvedQuery,
        scope: toScope(flags),
        render: toRender(flags),
        options,
        echo: echoOf(verb, resolvedQuery, flags, options),
    });
    emit((chunk) => context.process.stdout.write(chunk), mode, outcome);
    (context.process as { exitCode?: number | string | null }).exitCode = outcome.exitCode;
};

const VERBS = new Set<Verb>(["find", "files", "def", "refs", "sym", "ast", "outline", "context", "recent", "log", "who"]);

// Shell-like tokenizer for multi lines: whitespace-separated, "…"/'…' quoting, \" escapes inside double quotes.
const tokenize = (line: string): string[] => {
    const tokens: string[] = [];
    let current = "";
    let started = false;
    let quoteChar: '"' | "'" | undefined;
    for (let i = 0; i < line.length; i += 1) {
        const char = line[i]!;
        if (quoteChar !== undefined) {
            if (char === "\\" && quoteChar === '"' && line[i + 1] === '"') {
                current += '"';
                i += 1;
                continue;
            }
            if (char === quoteChar) {
                quoteChar = undefined;
                continue;
            }
            current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quoteChar = char;
            started = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (started || current !== "") {
                tokens.push(current);
                current = "";
                started = false;
            }
            continue;
        }
        current += char;
    }
    if (started || current !== "") {
        tokens.push(current);
    }
    return tokens;
};

const REF_KINDS = new Set(["call", "import", "type", "write"]);
const SYM_KINDS = new Set(["fn", "method", "class", "type", "const", "route", "test"]);
const ONLY_KINDS = new Set(["tests", "src", "docs", "config"]);

export interface MultiLine {
    readonly verb: Verb;
    readonly query: string;
    readonly scope: Partial<ScopeFlags>;
    readonly options: VerbOptions;
    readonly error?: string;
}

// Each multi line is a mini command: `<verb> <query…> [--lang ts,py] [--in dir] [--kind call] [--literal|--word|--case]`.
// Anything unparseable becomes a per-section error — a flag must never be searched as literal text.
export const parseMultiLine = (line: string): MultiLine => {
    const tokens = tokenize(line);
    const first = tokens[0] ?? "";
    const verb: Verb = VERBS.has(first as Verb) ? (first as Verb) : "q";
    const rest = verb === "q" ? tokens : tokens.slice(1);
    const fail = (error: string): MultiLine => ({ verb, query: line, scope: {}, options: {}, error });
    const queryParts: string[] = [];
    let lang: readonly string[] | undefined;
    const paths: string[] = [];
    const globs: string[] = [];
    const notGlobs: string[] = [];
    let only: ScopeFlags["only"];
    let kind: string | undefined;
    let literal = false;
    let word = false;
    let caseSensitive = false;
    for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i]!;
        // Anything dash-prefixed is a flag attempt — grep's single-dash flags must error, never be searched.
        if (!/^-{1,2}[A-Za-z]/.test(token)) {
            queryParts.push(token);
            continue;
        }
        const value = (): string | undefined => rest[(i += 1)];
        if (token === "--lang") {
            const raw = value();
            if (raw === undefined) {
                return fail("--lang needs a value");
            }
            try {
                lang = parseLangs(raw);
            } catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
        } else if (token === "--in") {
            const path = value();
            if (path === undefined) {
                return fail("--in needs a value");
            }
            paths.push(path);
        } else if (token === "--glob" || token === "--not-glob") {
            const glob = value();
            if (glob === undefined) {
                return fail(`${token} needs a value`);
            }
            (token === "--glob" ? globs : notGlobs).push(glob);
        } else if (token === "--only") {
            const choice = value();
            if (choice === undefined || !ONLY_KINDS.has(choice)) {
                return fail(`--only needs one of ${[...ONLY_KINDS].join("|")}`);
            }
            only = choice as ScopeFlags["only"];
        } else if (token === "--kind") {
            kind = value();
            if (kind === undefined) {
                return fail("--kind needs a value");
            }
        } else if (token === "--literal") {
            literal = true;
        } else if (token === "--word") {
            word = true;
        } else if (token === "--case") {
            caseSensitive = true;
        } else {
            return fail(`unknown flag ${token} in a multi line — supported: --lang --in --glob --not-glob --only --kind --literal --word --case`);
        }
    }
    const options: VerbOptions = {
        ...(literal ? { literal: true } : {}),
        ...(word ? { word: true } : {}),
        ...(caseSensitive ? { caseSensitive: true } : {}),
        ...(verb === "refs" && kind !== undefined ? { refKind: kind as NonNullable<VerbOptions["refKind"]> } : {}),
        ...(verb === "sym" && kind !== undefined ? { symKind: kind as NonNullable<VerbOptions["symKind"]> } : {}),
        ...(verb === "ast" && lang?.[0] !== undefined ? { astLang: lang[0] } : {}),
    };
    if (verb === "refs" && kind !== undefined && !REF_KINDS.has(kind)) {
        return fail(`--kind for refs needs one of ${[...REF_KINDS].join("|")}`);
    }
    if (verb === "sym" && kind !== undefined && !SYM_KINDS.has(kind)) {
        return fail(`--kind for sym needs one of ${[...SYM_KINDS].join("|")}`);
    }
    if (verb === "ast" && lang === undefined) {
        return fail("ast needs --lang <language>");
    }
    return {
        verb,
        query: queryParts.join(" "),
        scope: {
            ...(lang !== undefined ? { lang } : {}),
            ...(paths.length > 0 ? { in: paths } : {}),
            ...(globs.length > 0 ? { glob: globs } : {}),
            ...(notGlobs.length > 0 ? { notGlob: notGlobs } : {}),
            ...(only !== undefined ? { only } : {}),
        },
        options,
    };
};

const readStdin = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });

// `iq multi`: several queries — `<verb> <query> [flags]` or a bare auto-mode query — sharing one process spawn
// and one --budget (split equally, min 150 tokens per section). Each query is an operand, or one per stdin line
// when they are generated rather than typed; transcript mining found agents writing heredocs and temp files to
// reach a batch, which is a shell round-trip for something that is just an argument list. Per-line flags merge
// over the command-level ones (line wins). Exit 0 if any section hit, 1 if all empty.
export const runMulti = async (context: CommandContext, flags: SearchFlags, queries: readonly string[], input?: string): Promise<void> => {
    const mode = resolveMode(flags, loadConfig().intenticOutput);
    const source = queries.length > 0 ? queries : ((input ?? (await readStdin())).split("\n") as readonly string[]);
    const lines = source.map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length === 0) {
        throw new Error("iq multi: no queries — pass them as arguments (iq multi 'def foo' 'refs bar') or one per stdin line");
    }
    const engine = engineFromEnv(flags.features);
    const root = workspaceRoot();
    const budget = Math.max(150, Math.floor(flags.budget / lines.length));
    let anyHit = false;
    for (const [i, line] of lines.entries()) {
        const prefix = `[${i + 1}/${lines.length}]`;
        let parsed = parseMultiLine(line);
        if (parsed.error === undefined) {
            // Path-frame resolution can reject a line (path outside the workspace) — that is this line's error,
            // never the batch's.
            try {
                parsed = {
                    ...parsed,
                    query: resolveQuery(parsed.verb, parsed.query, root),
                    scope: parsed.scope.in === undefined ? parsed.scope : { ...parsed.scope, in: rootRelativePaths(parsed.scope.in, root) },
                };
            } catch (error) {
                parsed = { ...parsed, error: error instanceof Error ? error.message : String(error) };
            }
        }
        if (parsed.error !== undefined) {
            const message = `${prefix} iq: ${line} — error: ${parsed.error}\n`;
            if (mode === "text") {
                context.process.stdout.write(message);
            } else {
                context.process.stdout.write(`${JSON.stringify({ kind: "error", line, message: parsed.error })}\n`);
            }
            continue;
        }
        const merged: SearchFlags = { ...flags, ...parsed.scope };
        const outcome = await engine.run({
            verb: parsed.verb,
            query: parsed.query,
            scope: toScope(merged),
            render: { ...toRender(flags), budget },
            options: parsed.options,
            echo: echoOf(parsed.verb, parsed.query, merged, parsed.options),
        });
        if (mode === "text") {
            context.process.stdout.write(`${prefix} ${outcome.text}${i < lines.length - 1 ? "\n" : ""}`);
        } else {
            emit((chunk) => context.process.stdout.write(chunk), mode === "json" ? "ndjson" : mode, outcome);
        }
        anyHit ||= outcome.exitCode === 0;
    }
    (context.process as { exitCode?: number | string | null }).exitCode = anyHit ? 0 : 1;
};
