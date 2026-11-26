// How a shell command splits into invocations and their words, quotes honoured: no I/O, no subsystem.

// One quote-aware tokenizer, asked by every reader of a shell command's words: the install rule
// (agent/providers/agent-installs.ts), the turn's command record and notices, and the outward commands extensions declare
// (activity/outbound.ts). Moved here from agent-installs.ts (2026-11-26) so the layers below the agent read the same
// words. Produces words per invocation, not joined strings, and the operator each segment ended on, so a quoted operator
// character cannot split the command.

// A heredoc body is a script, not a command; stripped line-wise, since that is how a heredoc is delimited. `<<<` is a
// here-string and stays an ordinary word.
const HEREDOC = /<<-?(?!<)\s*\\?(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/;

const withoutHeredocs = (command: string): string => {
    const kept: string[] = [];
    let delimiter: string | undefined;
    for (const line of command.split("\n")) {
        if (delimiter !== undefined) {
            if (line.trim() === delimiter) {
                delimiter = undefined;
            }
            continue;
        }
        kept.push(line);
        const opened = HEREDOC.exec(line);
        if (opened !== null) {
            delimiter = opened[1] ?? opened[2] ?? opened[3];
        }
    }
    return kept.join("\n");
};

// A redirection is not an argument. An operator with no target attached consumes the next word; one carrying its own
// target (`2>&1`, `>out.log`) takes only itself.
const REDIRECTION = /^(?:\d+|&)?(?:>>?|<<?)/;

const withoutRedirections = (words: readonly string[]): string[] => {
    const kept: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
        // SAFETY: the loop bound keeps index inside the array.
        const word = words[index] as string;
        if (!REDIRECTION.test(word)) {
            kept.push(word);
            continue;
        }
        if (word.replace(REDIRECTION, "") === "") {
            index += 1;
        }
    }
    return kept;
};

// Prefixes standing in front of the command that matters: env assignments, env/sudo/nice, a for/while body's loop
// keywords, and `timeout <n>`.
// `time`, `command`, `exec` and `nohup` run what follows; `if`/`while`/`until` and friends run their condition, `!` and `{`
// stand in front of one.
const PREFIX_WORDS = new Set(["env", "sudo", "nice", "then", "do", "else", "elif", "if", "while", "until", "time", "command", "exec", "nohup", "!", "{"]);
// xargs's options that take their value as the next word.
const XARGS_VALUE_FLAGS = new Set(["-n", "-P", "-I", "-L", "-s", "-d", "-E", "-a"]);
const DURATION = /^[\d.]+[smhd]?$/;

const withoutPrefixes = (words: readonly string[]): string[] => {
    let start = 0;
    while (start < words.length) {
        // SAFETY: the loop bound keeps start inside the array.
        const word = words[start] as string;
        if (PREFIX_WORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
            start += 1;
            continue;
        }
        if (word === "xargs") {
            let ahead = start + 1;
            while ((words[ahead] ?? "").startsWith("-")) {
                // SAFETY: the loop condition just read words[ahead] as a word starting with "-".
                ahead += XARGS_VALUE_FLAGS.has(words[ahead] as string) ? 2 : 1;
            }
            start = ahead;
            continue;
        }
        if (word === "timeout") {
            let ahead = start + 1;
            while ((words[ahead] ?? "").startsWith("-")) {
                ahead += 1;
            }
            if (DURATION.test(words[ahead] ?? "")) {
                start = ahead + 1;
                continue;
            }
        }
        break;
    }
    return words.slice(start);
};

type Operator = "|" | "&&" | "||" | ";" | "&" | "\n";

export interface CommandSegment {
    readonly words: readonly string[];
    /** How many `(…)` groups or command substitutions the segment sits in: a `cd` inside one ends with it. */
    readonly depth: number;
    /** The operator this segment ended on; absent at the command's end and around `(`…`)` grouping. */
    readonly next?: Operator;
}

export const tokenize = (command: string): CommandSegment[] => {
    const segments: CommandSegment[] = [];
    let words: string[] = [];
    let word = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    let depth = 0;
    let ticked = false;
    const endWord = (): void => {
        if (word !== "") {
            words.push(word);
            word = "";
        }
    };
    const endSegment = (next?: Operator): void => {
        endWord();
        const kept = withoutPrefixes(withoutRedirections(words));
        if (kept.length > 0) {
            segments.push(next === undefined ? { words: kept, depth } : { words: kept, depth, next });
        }
        words = [];
    };
    const source = withoutHeredocs(command);
    for (let index = 0; index < source.length; index += 1) {
        // SAFETY: the loop bound keeps index inside the string.
        const character = source[index] as string;
        if (escaped) {
            escaped = false;
            // A backslash-newline joins the two lines; it does not separate them.
            if (character !== "\n") {
                word += character;
            }
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
        } else if (quote !== undefined) {
            if (character === quote) {
                quote = undefined;
            } else {
                word += character;
            }
        } else if (character === "'" || character === '"') {
            quote = character;
        } else if (character === "&" && /[<>]$/.test(word)) {
            // Mid-redirection: the `&` of `2>&1` binds to the operator before it, not to backgrounding.
            word += character;
        } else if (character === "|" || character === "&") {
            const doubled = source[index + 1] === character;
            // SAFETY: this branch holds only for `|` or `&`, so the operator is `|`, `||`, `&` or `&&`.
            endSegment((doubled ? `${character}${character}` : character) as Operator);
            index += doubled ? 1 : 0;
        } else if (character === ";" || character === "\n") {
            endSegment(character);
        } else if (character === "(") {
            endSegment();
            depth += 1;
        } else if (character === ")") {
            endSegment();
            depth = Math.max(0, depth - 1);
        } else if (character === "`") {
            // Backticks open and close a command substitution with the one character.
            endSegment();
            depth = Math.max(0, depth + (ticked ? -1 : 1));
            ticked = !ticked;
        } else if (/\s/.test(character)) {
            endWord();
        } else {
            word += character;
        }
    }
    endSegment();
    return segments;
};

// The words of each invocation, quotes honoured; callers outside this file want words, not a joined string to re-split.
export const commandWords = (command: string): string[][] => tokenize(command).map((segment) => [...segment.words]);

// Each invocation's words with the operator it ended on, for a reader of pipelines (verification/pipeline-filters.ts).
export const commandSegments = (command: string): readonly { readonly words: readonly string[]; readonly next?: string }[] => tokenize(command);
