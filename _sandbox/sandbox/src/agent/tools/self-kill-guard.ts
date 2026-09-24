import { heredocSpans } from "../../heredoc.js";

// `pkill -f` and `pgrep -f` match every process's whole command line, and the shells running an agent's Bash call
// (Claude's zsh, tmux-run, the pane's `bash -c`) carry that call's text: a pattern found in it kills its own call.

// Options that take the following word as their value, so that word is not the pattern (procps pkill/pgrep).
const VALUED_SHORT = new Set(["q", "g", "G", "P", "s", "t", "u", "U", "F", "r", "O", "d"]);
const VALUED_LONG = new Set([
    "--queue",
    "--pgroup",
    "--group",
    "--parent",
    "--session",
    "--terminal",
    "--euid",
    "--uid",
    "--pidfile",
    "--runstates",
    "--older",
    "--delimiter",
    "--signal",
    "--cgroup",
    "--ns",
    "--nslist",
]);
// A signal spelled as an option (`-9`, `-KILL`); a lone capital is a short option instead (`-F file`).
const SIGNAL = /^-(?:\d+|[A-Z]{2,}[A-Z0-9+-]*)$/u;
// In command position only: an `echo`, a commit message or a heredoc that mentions pkill is left as written.
const INVOCATION = /(?:^|[;&|({\n`]|\$\(|\b(?:then|do|else)\s)\s*(?:sudo\s+(?:-\S+\s+)*)?(pkill|pgrep)(?=[ \t])/gu;
const GAP = /(?:[ \t]|\\\n)*/uy;
// One shell word: quoted spans, backslash escapes and plain characters, up to unquoted space or an operator.
const WORD = /(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\;&|<>()`])+/suy;
// A first character that means itself in a regex, so a one-character bracket class matches exactly what it did.
const LITERAL_START = /[\w/@%:,=~]/u;

const unquote = (word: string): string =>
    word.replaceAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/gsu, (_whole, single?: string, double?: string, escaped?: string) =>
        single ?? (double === undefined ? (escaped ?? "") : double.replaceAll(/\\([$`"\\\n])/gu, "$1")),
    );

// The pattern word after `pkill`/`pgrep` at `from`, and whether the options before it asked for a full-line match.
const patternWord = (command: string, from: number): { at: number; word: string; full: boolean; caseless: boolean } | undefined => {
    let at = from;
    let full = false;
    let caseless = false;
    let optionsDone = false;
    let valueNext = false;
    for (;;) {
        GAP.lastIndex = at;
        GAP.exec(command);
        WORD.lastIndex = GAP.lastIndex;
        const match = WORD.exec(command);
        if (match === null) {
            return undefined;
        }
        const word = match[0];
        const plain = unquote(word);
        const start = GAP.lastIndex;
        at = WORD.lastIndex;
        if (valueNext) {
            valueNext = false;
        } else if (optionsDone || !plain.startsWith("-") || plain === "-") {
            return { at: start, word, full, caseless };
        } else if (plain === "--") {
            optionsDone = true;
        } else if (plain.startsWith("--")) {
            full ||= plain === "--full";
            caseless ||= plain === "--ignore-case";
            valueNext = VALUED_LONG.has(plain);
        } else if (!SIGNAL.test(plain)) {
            for (let index = 1; index < plain.length; index += 1) {
                const letter = plain.charAt(index);
                full ||= letter === "f";
                caseless ||= letter === "i";
                if (VALUED_SHORT.has(letter)) {
                    // Glued (`-u1000`) the value is the rest of this word; alone it is the next one.
                    valueNext = index === plain.length - 1;
                    break;
                }
            }
        }
    }
};

// `vite` → `\[v]ite`, `'vite'` → `'[v]ite'`: pkill then reads `[v]ite`, which matches "vite" but not its own spelling.
const bracketed = (word: string): string | undefined => {
    const quote = word[0] === "'" || word[0] === '"' ? word[0] : "";
    const first = word[quote.length];
    if (first === undefined || !LITERAL_START.test(first)) {
        return undefined;
    }
    return quote === "" ? `\\[${first}]${word.slice(1)}` : `${quote}[${first}]${word.slice(2)}`;
};

export type SelfMatch = {
    // What pkill/pgrep will match with, after the rewrite.
    readonly pattern: RegExp;
    readonly kills: boolean;
    // The pattern as the agent wrote it, unquoted.
    readonly written: string;
};

// Rewrites each full-line pkill/pgrep pattern so it cannot match its own text, and returns every such pattern: the
// caller still has to test them against the whole wrapped line, which can repeat the pattern elsewhere.
export const guardSelfMatch = (command: string): { readonly command: string; readonly matches: readonly SelfMatch[] } => {
    const spans = heredocSpans(command);
    const edits: { at: number; length: number; text: string }[] = [];
    const matches: SelfMatch[] = [];
    for (const invocation of command.matchAll(INVOCATION)) {
        const from = invocation.index + invocation[0].length;
        const found = spans.some((span) => from >= span.start && from < span.end) ? undefined : patternWord(command, from);
        if (found?.full !== true) {
            continue;
        }
        const text = bracketed(found.word);
        if (text !== undefined) {
            edits.push({ at: found.at, length: found.word.length, text });
        }
        try {
            const pattern = new RegExp(unquote(text ?? found.word), found.caseless ? "iu" : "u");
            matches.push({ pattern, kills: invocation[1] === "pkill", written: unquote(found.word) });
        } catch {
            // Not a pattern this runtime can read, so there is nothing to test the wrapped line against.
        }
    }
    const rewritten = edits.reduceRight((line, edit) => `${line.slice(0, edit.at)}${edit.text}${line.slice(edit.at + edit.length)}`, command);
    return { command: rewritten, matches };
};

export const selfKillRefusal = (match: SelfMatch): string =>
    `pkill -f '${match.written}' would kill this Bash call's own shell: the pattern also matches the call's command line ` +
    "(it appears again elsewhere in the command, or in the wrapper that runs it), so the call would end with no output " +
    "and nothing after the pkill would run. Run the pkill as a Bash call of its own, with no other mention of the " +
    "pattern and one that cannot match its own text, e.g. pkill -f '[v]ite' for vite.";
