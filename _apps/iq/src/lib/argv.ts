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
}

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
    return { argv: out, notes };
};
