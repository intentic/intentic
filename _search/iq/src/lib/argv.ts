// Grep-dialect argv, absorbed before stricli parses it. Transcript mining (207 calls): `iq search` alone was 44
// calls, 37 of them hard failures; --include/--path/--max-results account for most of the rest. A redirect
// message costs the agent a retry turn, a rewrite costs nothing, and the stderr note still teaches the
// canonical form for the next call.
const VERB_REWRITES: Record<string, string> = {
    search: "q",
    grep: "find",
    // `skeleton` is the word agents infer from outline's own description. Keep the public vocabulary small,
    // but do not charge a retry for guessing the descriptive noun instead of the route name.
    skeleton: "outline",
    // `ask` shipped as its own verb before the natural-language pipeline became what a bare query does. Removing
    // it must not turn a habit into an exit-2: the rewrite is the same trade as `search`, free here, one wasted
    // turn otherwise, and the note teaches the spelling that survives.
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
    // Nobody guesses "--context-lines" first. Left to stricli's edit distance, `--lines` resolves to `--limit`,
    // which is a different knob answering a different question, so the redirect is not just a wasted turn but a
    // wrong signpost: it caps result GROUPS when the caller asked to see more of each one.
    "--lines": "--context-lines",
    "--context": "--context-lines",
    "--after-context": "--context-lines",
    "--before-context": "--context-lines",
};

// Verbs that route to a subcommand rather than taking a query. Their gap is the same one the verb rewrites
// close: a shape the agent can reasonably infer costs a turn because nothing absorbs it.
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

// `find` means filenames to the shell and content to iq, and the collision costs a turn: a session ran
// `iq find 'Row.vue'`, got the eight files that IMPORT it, and went back to grep. Not a rewrite, searching for
// the text "Row.vue" is a legitimate thing to ask, so the answer still comes, with the other verb named beside
// it. A bare filename is the only shape this fires on: an extension, no separator, no regex metacharacter.
const BARE_FILENAME = /^[\w-]+\.[a-z]{1,5}$/i;
const filenameHint = (verb: string | undefined, pattern: string | undefined): string | undefined =>
    verb === "find" && pattern !== undefined && BARE_FILENAME.test(pattern)
        ? `"${pattern}" looks like a filename: \`iq files ${pattern}\` searches names, \`find\` searches content`
        : undefined;

// A router verb's own dialect. `iq "<query>"` searches, so `iq sessions "<query>"` reading as "search the
// sessions" is the obvious inference, and it was the single most frequent hard failure in the 2026-09 mining:
// `No command registered for '<the whole question>'`, which names nothing the caller could do next. `iq index
// --status` is the same mistake in the other direction, a subcommand typed as a flag.
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
    // `log` genuinely takes --path (a git pathspec); everywhere else it is grep dialect for --in.
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

// Auto mode used to expose an engine named "lexical" in experiments, so it remains a plausible spelling
// even though the stable public verb is `find`.
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

// --repo takes a workspace repo NAME. An absolute/cwd-relative filesystem path is unambiguously --in;
// leaving it as --repo produces a convincing but false zero-result answer.
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

// `files --glob '*.ts'` states a complete filename-search intent but omits the required positional. When
// there is exactly one glob and no other positional, use it as the exact file pattern as well as the scope.
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

// `context` wants `path:line`; a bare path exits 2 with "expected an anchor like path:line", which is a turn
// spent to learn a colon. But `:1` is not what the caller meant either — someone naming a whole file wants the
// whole file's shape, and that verb already exists. Same trade as skeleton → outline.
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
    // Order matters: the verb settles first, because every absorber after it keys off out[0].
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
