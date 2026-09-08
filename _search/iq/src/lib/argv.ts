// Grep-dialect argv, absorbed before stricli parses it: a rewrite costs nothing, while a redirect message costs the
// agent a retry turn.
const VERB_REWRITES: Record<string, string> = {
    search: "q",
    grep: "find",
    // skeleton is the word agents infer from outline's description; absorbed rather than charged a retry.
    skeleton: "outline",
    // `ask` predates the natural-language pipeline query does now; absorbed so the old habit isn't an exit-2.
    ask: "q",
};

const FLAG_REWRITES: Record<string, string> = {
    "--include": "--glob",
    "--max": "--limit",
    "--max-results": "--limit",
    "--num-results": "--limit",
    "--max-count": "--limit",
    "--top": "--limit",
    "-k": "--limit",
    // `--lines` would resolve to `--limit` by edit distance, a different knob (caps result groups, not context).
    "--lines": "--context-lines",
    "--context": "--context-lines",
    "--after-context": "--context-lines",
    "--before-context": "--context-lines",
};

// Verbs that route to a subcommand rather than take a query; same gap the verb rewrites close.
const SESSIONS_SUBCOMMANDS = new Set(["ingest", "list", "files", "match", "grab", "fork"]);
const INDEX_SUBCOMMANDS = new Set(["status", "rebuild", "drop"]);

const VALUE_FLAGS = new Set([
    "--in",
    "--repo",
    "--lang",
    "--glob",
    "--not-glob",
    "--only",
    "--budget",
    "--limit",
    "--context-lines",
    "-C",
    "--after",
    "--features",
    "--kind",
    "--since",
    "--author",
    "--path",
    "--mode",
]);

const positionalArgs = (argv: readonly string[]): string[] => {
    const positional: string[] = [];
    for (let i = 1; i < argv.length; i += 1) {
        const token = argv[i]!;
        if (token.startsWith("-") && !token.includes("=")) {
            if (VALUE_FLAGS.has(token)) {
                i += 1;
            }
            continue;
        }
        if (!token.startsWith("-")) {
            positional.push(token);
        }
    }
    return positional;
};

const pathLikeRepo = (value: string): boolean => value.startsWith("/") || value.startsWith("./") || value.startsWith("../");

export interface NormalizedArgv {
    readonly argv: string[];
    readonly notes: string[];
    readonly hints: string[];
}

// A bare filename only: extension, no separator or regex char, where shell and iq `find` diverge.
const BARE_FILENAME = /^[\w-]+\.[a-z]{1,5}$/i;
const filenameHint = (verb: string | undefined, pattern: string | undefined): string | undefined =>
    verb === "find" && pattern !== undefined && BARE_FILENAME.test(pattern)
        ? `"${pattern}" looks like a filename: \`iq files ${pattern}\` searches names, \`find\` searches content`
        : undefined;

// A router verb's own dialect: `iq sessions "<query>"` reads as searching sessions, and `iq index --status` is the same
// mistake in reverse, a subcommand typed as a flag.
const absorbSubcommand = (out: string[], notes: string[]): void => {
    const next = out[1];
    if (next === undefined) {
        return;
    }
    if (out[0] === "sessions" && !next.startsWith("-") && !SESSIONS_SUBCOMMANDS.has(next)) {
        out.splice(1, 0, "grab");
        notes.push(`sessions "${next}" → sessions grab`);
        return;
    }
    if (out[0] === "index" && next.startsWith("--") && INDEX_SUBCOMMANDS.has(next.slice(2))) {
        out[1] = next.slice(2);
        notes.push(`index ${next} → index ${out[1]}`);
    }
};

const absorbVerb = (out: string[], notes: string[]): void => {
    const verb = out[0];
    const rewritten = verb === undefined ? undefined : VERB_REWRITES[verb];
    if (verb !== undefined && rewritten !== undefined) {
        out[0] = rewritten;
        notes.push(`${verb} → ${rewritten}`);
    }
};

const absorbFlagNames = (out: string[], notes: string[]): void => {
    // `log` takes a real --path (a git pathspec); every other verb treats --path as grep dialect for --in.
    const pathTarget = out[0] === "log" ? undefined : "--in";
    for (let i = 0; i < out.length; i += 1) {
        const token = out[i]!;
        const [name, value] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("="))] : [token, ""];
        const target = FLAG_REWRITES[name] ?? (name === "--path" ? pathTarget : undefined);
        if (target !== undefined) {
            out[i] = `${target}${value}`;
            notes.push(`${name} → ${target}`);
        }
    }
};

// "lexical" is accepted as a spelling for the `find` mode, an older engine name that still gets typed.
const absorbLexicalMode = (out: string[], notes: string[]): void => {
    for (let i = 1; i < out.length; i += 1) {
        if (out[i] === "--mode" && out[i + 1] === "lexical") {
            out[i + 1] = "find";
            notes.push("--mode lexical → --mode find");
        } else if (out[i] === "--mode=lexical") {
            out[i] = "--mode=find";
            notes.push("--mode lexical → --mode find");
        }
    }
};

// --repo takes a repo name; an absolute or cwd-relative path is unambiguously --in, since leaving it as --repo silently
// returns zero results.
const absorbRepoPath = (out: string[], notes: string[]): void => {
    for (let i = 1; i < out.length; i += 1) {
        const token = out[i]!;
        if (token === "--repo" && out[i + 1] !== undefined && pathLikeRepo(out[i + 1]!)) {
            out[i] = "--in";
            notes.push("--repo <path> → --in <path>");
        } else if (token.startsWith("--repo=") && pathLikeRepo(token.slice("--repo=".length))) {
            out[i] = `--in=${token.slice("--repo=".length)}`;
            notes.push("--repo=<path> → --in=<path>");
        }
    }
};

// `files --glob '*.ts'` states a complete intent but omits the required positional; with exactly one glob and no other
// positional, it doubles as the exact pattern.
const absorbFilesGlob = (out: string[], notes: string[]): void => {
    if (out[0] !== "files" || positionalArgs(out).length > 0) {
        return;
    }
    const globs = out.flatMap((token, index) => {
        if (token === "--glob" && out[index + 1] !== undefined) {
            return [out[index + 1]!];
        }
        return token.startsWith("--glob=") ? [token.slice("--glob=".length)] : [];
    });
    if (globs.length === 1) {
        out.push(globs[0]!, "--exact");
        notes.push("files --glob <pattern> → files <pattern> --exact --glob <pattern>");
    }
};

// `context` wants `path:line`; a bare path would just exit 2 to teach a colon. A whole-file name means the caller wants
// that file's shape, which `outline` already gives.
const absorbBareContextPath = (out: string[], notes: string[]): void => {
    if (out[0] !== "context") {
        return;
    }
    const anchor = positionalArgs(out)[0];
    if (anchor !== undefined && !/:\d+(?:-\d+)?$/.test(anchor)) {
        out[0] = "outline";
        notes.push("context <path> (no :line) → outline");
    }
};

export const normalizeArgv = (argv: readonly string[]): NormalizedArgv => {
    const out = [...argv];
    const notes: string[] = [];
    // Order matters: the verb must settle first, since every absorber after it reads out[0].
    absorbVerb(out, notes);
    absorbSubcommand(out, notes);
    absorbFlagNames(out, notes);
    absorbLexicalMode(out, notes);
    absorbRepoPath(out, notes);
    absorbFilesGlob(out, notes);
    absorbBareContextPath(out, notes);

    const hint = filenameHint(
        out[0],
        out.slice(1).find((token) => !token.startsWith("-")),
    );
    return { argv: out, notes, hints: hint === undefined ? [] : [hint] };
};
