// Grep-dialect argv, absorbed before stricli parses it. Transcript mining (207 calls): `iq search` alone was 44
// calls, 37 of them hard failures; --include/--path/--max-results account for most of the rest. A redirect
// message costs the agent a retry turn — a rewrite costs nothing, and the stderr note still teaches the
// canonical form for the next call.
const VERB_REWRITES: Record<string, string> = {
    search: "q",
    grep: "find",
    // `ask` shipped as its own verb before the natural-language pipeline became what a bare query does. Removing
    // it must not turn a habit into an exit-2: the rewrite is the same trade as `search` — free here, one wasted
    // turn otherwise — and the note teaches the spelling that survives.
    ask: "q",
};

const FLAG_REWRITES: Record<string, string> = {
    "--include": "--glob",
    "--max-results": "--limit",
    "--num-results": "--limit",
    "--max-count": "--limit",
};

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
    const hint = filenameHint(
        out[0],
        out.slice(1).find((token) => !token.startsWith("-")),
    );
    return { argv: out, notes, hints: hint === undefined ? [] : [hint] };
};
