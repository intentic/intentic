export interface Unreadable {
    readonly why: string;
}

// A reference stands in as a character no host, flag or operator contains, so a secret spelled into a host or a program
// name fails every test below instead of passing as whatever its value happens to be.
export const STAND_IN = "\u0001";

// One shell word with its quoting taken off; `dynamic` when a `$` expansion inside double quotes fills part of it, whose
// value exists only when the command runs. `assignment` when the word as written opens with an unquoted `NAME=`, the
// only spelling a shell takes as setting a variable (`"A=x"` is a program named `A=x`).
export interface Word {
    readonly text: string;
    readonly dynamic: boolean;
    readonly assignment?: boolean;
}

// Characters that break a line into separate stages, outside quotes: a pipe, a background `&`, a `;`, a newline. Each
// run of them (so `&&`, `||`, `|&` too) ends the current stage and starts the next; each stage is read on its own. A
// stage that names no host it would connect to cannot send the value anywhere, so a pipe into `jq` or a `cd` before a
// `curl` no longer makes the destination unreadable — the stage itself is read, and only an unreadable stage refuses.
const SEPARATORS: ReadonlySet<string> = new Set(["|", "&", ";", "\n"]);

// Characters that run a command inside the command or open a scope its text no longer follows: each leaves the
// destination unreadable, since what crosses them cannot be read from the words. A redirection (`<`, `>`) is read on its
// own (readRedirect), since the common ones send nothing anywhere new.
const OPERATORS: ReadonlyMap<string, string> = new Map([
    ["(", "it opens a subshell"],
    [")", "it opens a subshell"],
    ["`", "it runs a command inside the command"],
    ["{", "it uses brace expansion"],
    ["}", "it uses brace expansion"],
]);

const REDIRECTS = "it redirects input or output";

// Read the operator and its complete shell word separately. Prefix matching a target such as /dev/null.extra would
// discard a file write; quoting a numeric argument does not make it a leading file descriptor either.
const REDIRECT_OPERATOR = /^(?:&>>?|[<>]&|>>?|<>?)/;
const WORD_BOUNDARY = /[ \t\n|&;<>]/;

// Reads a redirection at the cursor. A digit being built as a word is the file descriptor it applies to (`2` in `2>&1`),
// not an argument, so it is dropped; any other word already built is a real argument and is kept. Returns undefined when
// the redirection sends nothing anywhere new (the cursor has moved past it), else why it cannot be read.
const readRedirect = (state: LexState): string | undefined => {
    const prefix = state.source.slice(state.wordStart, state.index).replaceAll("\\\n", "");
    if (state.source.charAt(state.index) !== "&" && state.started && /^\d+$/.test(prefix)) {
        resetWord(state);
    } else {
        finishWord(state);
    }
    const rest = state.source.slice(state.index);
    if (rest.startsWith("<<")) {
        return REDIRECTS;
    }
    const operator = REDIRECT_OPERATOR.exec(rest)?.[0];
    if (operator === undefined) {
        return REDIRECTS;
    }
    state.index += operator.length;
    while (/[ \t]/.test(state.source.charAt(state.index)) && state.index < state.source.length) {
        state.index += 1;
    }
    if (state.source.charAt(state.index) === "#") {
        return REDIRECTS;
    }
    while (state.index < state.source.length && !WORD_BOUNDARY.test(state.source.charAt(state.index))) {
        const why = readWordChar(state);
        if (why !== undefined) {
            return why;
        }
    }
    const safe = state.started && !state.dynamic && (operator.endsWith("&") ? /^(?:\d+|-)$/.test(state.text) : state.text === "/dev/null");
    resetWord(state);
    return safe ? undefined : REDIRECTS;
};

const SUBSTITUTES = "it runs a command inside the command";
const EXPANDS = "a shell variable or expansion in it is only filled in when it runs";
const UNCLOSED = "a quote in it never closes";

// A `$` that starts an expansion: a name, a positional or special parameter, `${`, `$(` or `$'`.
const EXPANSION_START = /[A-Za-z_0-9{(@*#?$!'-]/;

// The lexer's position, the word it is building, the stage's words so far, and every stage a separator has closed.
// `bindings` are the shell variables an earlier stage of this line set to a plain value the reader saw, in force where
// they are read; `before` is the separator run the stage being built follows ("" at the start of the line).
interface LexState {
    readonly source: string;
    readonly segments: Word[][];
    readonly bindings: Map<string, string>;
    words: Word[];
    index: number;
    text: string;
    dynamic: boolean;
    started: boolean;
    wordStart: number;
    before: string;
    ifsChanged: boolean;
}

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

const startWord = (state: LexState): void => {
    if (!state.started) {
        state.started = true;
        state.wordStart = state.index;
    }
};

const finishWord = (state: LexState): void => {
    if (state.started) {
        const assignment = ASSIGNMENT_PREFIX.test(state.source.slice(state.wordStart, state.index).replaceAll("\\\n", ""));
        state.words.push({ text: state.text, dynamic: state.dynamic, assignment });
    }
    resetWord(state);
};

const resetWord = (state: LexState): void => {
    state.text = "";
    state.dynamic = false;
    state.started = false;
};

// How a separator run joins two stages. A stage after `&&` or `||` may never run; one after a single `|`, or before a
// `|` or a background `&`, runs in a subshell whose variables die with it.
const conditional = (run: string): boolean => run.includes("&&") || run.includes("||");
const pipedInto = (run: string): boolean => run.replaceAll("||", "").includes("|");
const leavesShell = (run: string | undefined): boolean => run !== undefined && /^[ \t]*(?:\|(?!\|)|&(?!&))/.test(run);

// What a finished stage does to the variables later stages read. Only a stage of nothing but assignments sets them in
// the shell itself (with a program after them they go to that program's environment alone), and only when it surely runs
// there: a stage that runs in a subshell changes nothing, and one that may not run at all (after `&&` or `||`) leaves
// its names unknown, as does a value filled in at run time or one with a `~` the shell would expand. Commands that
// mutate shell variables (printf -v / %n) are refused by their argument reader; a changed IFS stops unquoted reads.
const settleStage = (state: LexState, words: readonly Word[], after: string | undefined): void => {
    if (!words.every((word) => word.assignment === true) || pipedInto(state.before) || leavesShell(after)) {
        return;
    }
    const surely = !conditional(state.before);
    for (const word of words) {
        const split = word.text.indexOf("=");
        const name = word.text.slice(0, split);
        const value = word.text.slice(split + 1);
        state.ifsChanged ||= name === "IFS";
        if (surely && !word.dynamic && !value.includes("~")) {
            state.bindings.set(name, value);
        } else {
            state.bindings.delete(name);
        }
    }
};

// Closes the current stage at a separator run (undefined at the end of the line); a run with no stage before it (a
// leading `;`, `&&` then a newline) adds no stage and joins the run the next stage follows.
const finishSegment = (state: LexState, after?: string): void => {
    finishWord(state);
    if (state.words.length > 0) {
        settleStage(state, state.words, after);
        state.segments.push(state.words);
        state.words = [];
        state.before = after ?? "";
    } else {
        state.before += after ?? "";
    }
};

// A run of separators, and the blanks between them, taken whole so `&&` reads as one join rather than two `&`. A `&`
// that opens `&>` is a redirect, not a separator.
const SEPARATOR_RUN = /^(?:[|;\n \t]|&(?!>))+/;
const readSeparators = (state: LexState): undefined => {
    const run = SEPARATOR_RUN.exec(state.source.slice(state.index))?.[0] ?? state.source.charAt(state.index);
    finishSegment(state, run);
    state.index += run.length;
    return undefined;
};

// `$NAME` or `${NAME}` naming a variable an earlier stage set to a plain value: that value, and how much text it spans.
const VARIABLE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/;
const boundValue = (state: LexState, at: number): { readonly value: string; readonly length: number } | undefined => {
    const match = VARIABLE.exec(state.source.slice(at));
    const name = match?.[1] ?? match?.[2];
    const value = name === undefined ? undefined : state.bindings.get(name);
    return match === null || value === undefined ? undefined : { value, length: match[0].length };
};

// Outside quotes the shell splits an expansion into words and globs it; a value that stays one word as written is read
// in place, anything else is left to the run.
const UNSPLIT = /^[^\s*?[\]\\]+$/;

// A single-quoted run: no escapes, no expansions.
const singleQuoted = (state: LexState): string | undefined => {
    const close = state.source.indexOf("'", state.index + 1);
    if (close === -1) {
        return UNCLOSED;
    }
    state.text += state.source.slice(state.index + 1, close);
    state.index = close + 1;
    return undefined;
};

// One character inside double quotes: `$name` marks the word dynamic, `$(` and backticks run a command.
const quotedChar = (state: LexState, at: number): { readonly next: number } | Unreadable => {
    const char = state.source.charAt(at);
    const following = state.source.charAt(at + 1);
    if (char === "\\" && following !== "") {
        if (following === "\n") {
            return { next: at + 2 };
        }
        if ('$`"\\'.includes(following)) {
            state.text += following;
            return { next: at + 2 };
        }
        state.text += char;
        return { next: at + 1 };
    }
    if (char === "`" || (char === "$" && following === "(")) {
        return { why: SUBSTITUTES };
    }
    const bound = char === "$" ? boundValue(state, at) : undefined;
    if (bound !== undefined) {
        state.text += bound.value;
        return { next: at + bound.length };
    }
    state.dynamic ||= char === "$" && EXPANSION_START.test(following);
    state.text += char;
    return { next: at + 1 };
};

const doubleQuoted = (state: LexState): string | undefined => {
    let at = state.index + 1;
    while (at < state.source.length) {
        if (state.source.charAt(at) === `"`) {
            state.index = at + 1;
            return undefined;
        }
        const read = quotedChar(state, at);
        if ("why" in read) {
            return read.why;
        }
        at = read.next;
    }
    return UNCLOSED;
};

// A backslash outside quotes: the next character as itself, or, before a newline, a line continuation.
const escaped = (state: LexState): undefined => {
    const next = state.source.charAt(state.index + 1);
    state.index += 2;
    state.text += next;
    return undefined;
};

const plainChar = (state: LexState): undefined => {
    state.text += state.source.charAt(state.index);
    state.index += 1;
    return undefined;
};

const READERS: ReadonlyMap<string, (state: LexState) => string | undefined> = new Map([
    ["'", singleQuoted],
    [`"`, doubleQuoted],
    ["\\", escaped],
]);

// A `$` outside quotes: a variable set earlier in the line to a value that stays one word, read in place; anything else
// is filled in only when the command runs.
const unquotedExpansion = (state: LexState): string | undefined => {
    const bound = boundValue(state, state.index);
    if (bound === undefined || state.ifsChanged || !UNSPLIT.test(bound.value)) {
        return EXPANDS;
    }
    startWord(state);
    state.text += bound.value;
    state.index += bound.length;
    return undefined;
};

const readWordChar = (state: LexState): string | undefined => {
    const char = state.source.charAt(state.index);
    // A continuation is removed before token recognition. It cannot start an empty word, close the current word, or
    // hide the assignment prefix / numeric descriptor that spans it. Inside single quotes it stays literal.
    if (char === "\\" && state.source.charAt(state.index + 1) === "\n") {
        state.index += 2;
        return undefined;
    }
    const operator = OPERATORS.get(char);
    if (operator !== undefined) {
        return operator;
    }
    if (char === "$" && EXPANSION_START.test(state.source.charAt(state.index + 1))) {
        return unquotedExpansion(state);
    }
    startWord(state);
    return (READERS.get(char) ?? plainChar)(state);
};

// One step of reading: undefined to go on, else why the command cannot be read.
const lexStep = (state: LexState): string | undefined => {
    const char = state.source.charAt(state.index);
    if (char === " " || char === "\t") {
        finishWord(state);
        state.index += 1;
        return undefined;
    }
    if (char === "#" && !state.started) {
        // A comment runs to the end of its own line, not the command's: what follows the newline still runs.
        const end = state.source.indexOf("\n", state.index);
        state.index = end === -1 ? state.source.length : end;
        return undefined;
    }
    if (char === "<" || char === ">" || (char === "&" && state.source.charAt(state.index + 1) === ">")) {
        return readRedirect(state);
    }
    if (SEPARATORS.has(char)) {
        return readSeparators(state);
    }
    return readWordChar(state);
};

// Splits one line into its stages, each a list of words the way a shell would, or says which shell feature makes that
// impossible to trust. Deliberately narrower than a shell: anything this does not model is a reason, not a guess.
export const lex = (source: string): { readonly segments: readonly (readonly Word[])[] } | Unreadable => {
    const state: LexState = {
        source,
        segments: [],
        bindings: new Map(),
        words: [],
        index: 0,
        text: "",
        dynamic: false,
        started: false,
        wordStart: 0,
        before: "",
        ifsChanged: false,
    };
    while (state.index < source.length) {
        const step = lexStep(state);
        if (step !== undefined) {
            return { why: step };
        }
    }
    finishSegment(state);
    return { segments: state.segments };
};
