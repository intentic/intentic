// Grep-dialect argv, absorbed before stricli parses it. Transcript mining (207 calls): `iq search` alone was 44
// calls, 37 of them hard failures; --include/--path/--max-results account for most of the rest. A redirect
// message costs the agent a retry turn — a rewrite costs nothing, and the stderr note still teaches the
// canonical form for the next call.
const VERB_REWRITES: Record<string, string> = {
    search: "q",
    grep: "find",
    // `skeleton` is the word agents infer from outline's own description. Keep the public vocabulary small,
    // but do not charge a retry for guessing the descriptive noun instead of the route name.
    skeleton: "outline",
    // `ask` shipped as its own verb before the natural-language pipeline became what a bare query does. Removing
    // it must not turn a habit into an exit-2: the rewrite is the same trade as `search` — free here, one wasted
    // turn otherwise — and the note teaches the spelling that survives.
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
};

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
// `iq find 'Row.vue'`, got the eight files that IMPORT it, and went back to grep. Not a rewrite — searching for
// the text "Row.vue" is a legitimate thing to ask — so the answer still comes, with the other verb named beside
// it. A bare filename is the only shape this fires on: an extension, no separator, no regex metacharacter.
const BARE_FILENAME = /^[\w-]+\.[a-z]{1,5}$/i;
const filenameHint = (verb: string | undefined, pattern: string | undefined): string | undefined =>
    verb === "find" && pattern !== undefined && BARE_FILENAME.test(pattern)
        ? `"${pattern}" looks like a filename — \`iq files ${pattern}\` searches names, \`find\` searches content`
        : undefined;

export const normalizeArgv = (argv: readonly string[]): NormalizedArgv => {
    const out = [...argv];
    const notes: string[] = [];
    const verb = out[0];
    const rewrittenVerb = verb === undefined ? undefined : VERB_REWRITES[verb];
    if (verb !== undefined && rewrittenVerb !== undefined) {
        out[0] = rewrittenVerb;
        notes.push(`${verb} → ${rewrittenVerb}`);
    }
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

    // Auto mode used to expose an engine named "lexical" in experiments, so it remains a plausible spelling
    // even though the stable public verb is `find`.
    for (let i = 1; i < out.length; i += 1) {
        if (out[i] === "--mode" && out[i + 1] === "lexical") {
            out[i + 1] = "find";
            notes.push("--mode lexical → --mode find");
        } else if (out[i] === "--mode=lexical") {
            out[i] = "--mode=find";
            notes.push("--mode lexical → --mode find");
        }
    }

    // --repo takes a workspace repo NAME. An absolute/cwd-relative filesystem path is unambiguously --in;
    // leaving it as --repo produces a convincing but false zero-result answer.
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

    // `files --glob '*.ts'` states a complete filename-search intent but omits the required positional. When
    // there is exactly one glob and no other positional, use it as the exact file pattern as well as the scope.
    if (out[0] === "files" && positionalArgs(out).length === 0) {
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
    }
    const hint = filenameHint(
        out[0],
        out.slice(1).find((token) => !token.startsWith("-")),
    );
    return { argv: out, notes, hints: hint === undefined ? [] : [hint] };
};
