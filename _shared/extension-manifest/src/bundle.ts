// What a published bundle may import. The host imports an extension's entry bytes from a blob: URL, so a relative
// import can never resolve and a bare specifier resolves only if the shell's import map publishes it. Lives here
// because both the daemon's readiness check and the registry scanner judge a bundle against this same rule.

// What the shell's import map publishes to a bundle.
export const HOST_PUBLISHED_SPECIFIERS = ["vue", "@intentic/extension-api", "@intentic/extension-ui", "@tanstack/vue-query"] as const;

// The tokens the scan tells apart. A string carries its contents, and so does a template without a `${}` hole.
type Token =
    | { readonly kind: "ident" | "punct"; readonly text: string }
    | { readonly kind: "string"; readonly value: string }
    | { readonly kind: "template"; readonly value: string | undefined }
    | { readonly kind: "number" | "regex" };

// Words after which an expression starts, so a `/` there opens a regex rather than dividing.
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "extends"]);

// Whether a `/` after `last` opens a regex. After a value it divides. A `}` counts as a statement's end, since a block
// closes far more often than an object literal anything could divide. A misread regex is bounded by its line, see
// regexEnd.
const regexMayFollow = (last: Token | undefined): boolean => {
    if (last === undefined) {
        return true;
    }
    if (last.kind === "ident") {
        return BEFORE_EXPRESSION.has(last.text);
    }
    return last.kind === "punct" && ![")", "]", "++", "--"].includes(last.text);
};

const IDENT = /[#$_\\\p{ID_Start}][$\\\u200C\u200D\p{ID_Continue}]*/uy;
const NUMBER = /\.?\d[\w.]*/y;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
const SPACE = /\s/u;

// Where a sticky `pattern` matching at `at` ends, or -1 when it does not match there.
const matchEnd = (pattern: RegExp, source: string, at: number): number => {
    pattern.lastIndex = at;
    return pattern.test(source) ? pattern.lastIndex : -1;
};

const lineEnd = (source: string, at: number): number => {
    const offset = source.slice(at).search(LINE_BREAK);
    return offset < 0 ? source.length : at + offset;
};

interface Read {
    readonly end: number;
    readonly value: string;
}

// The quoted string opening at `at`: where it ends and what it holds. An unterminated one ends at its line.
const readString = (source: string, at: number): Read => {
    const quote = source[at];
    for (let i = at + 1; i < source.length; i++) {
        const char = source[i];
        if (char === "\\") {
            i++;
        } else if (char === quote) {
            return { end: i + 1, value: source.slice(at + 1, i) };
        } else if (char === "\n" || char === "\r") {
            return { end: i, value: source.slice(at + 1, i) };
        }
    }
    return { end: source.length, value: source.slice(at + 1) };
};

// Where the regex opening at `at` ends, flags included, or -1 when its line ends first: then the slash was division.
const regexEnd = (source: string, at: number): number => {
    let inClass = false;
    for (let i = at + 1; i < source.length; i++) {
        const char = source[i] ?? "";
        if (LINE_BREAK.test(char)) {
            return -1;
        }
        if (char === "\\") {
            i++;
        } else if (char === "[" || char === "]") {
            inClass = char === "[";
        } else if (char === "/" && !inClass) {
            return Math.max(i + 1, matchEnd(IDENT, source, i + 1));
        }
    }
    return -1;
};

interface Span {
    readonly end: number;
    // Whether it stops at a `${` rather than at its closing backtick.
    readonly hole: boolean;
}

// A template's text from `at` (past its backtick, or past the `}` closing a hole) to its closing backtick or its next
// `${`.
const templateSpan = (source: string, at: number): Span => {
    for (let i = at; i < source.length; i++) {
        const char = source[i];
        if (char === "\\") {
            i++;
        } else if (char === "`") {
            return { end: i + 1, hole: false };
        } else if (char === "$" && source[i + 1] === "{") {
            return { end: i + 2, hole: true };
        }
    }
    return { end: source.length, hole: false };
};

const punctAt = (source: string, at: number): string => {
    if (source.startsWith("...", at)) {
        return "...";
    }
    const two = source.slice(at, at + 2);
    if (two === "++" || two === "--" || (two === "?." && !/\d/u.test(source[at + 2] ?? ""))) {
        return two;
    }
    return source[at] ?? "";
};

interface Lexer {
    at: number;
    last: Token | undefined;
    // Code brace depth, and the depth each open template hole hands back to its template at.
    braces: number;
    readonly holes: number[];
}

// Past whitespace and comments from the lexer's position.
const skipTrivia = (source: string, lexer: Lexer): void => {
    for (;;) {
        if (SPACE.test(source[lexer.at] ?? "")) {
            lexer.at++;
        } else if (source.startsWith("//", lexer.at)) {
            lexer.at = lineEnd(source, lexer.at);
        } else if (source.startsWith("/*", lexer.at)) {
            const close = source.indexOf("*/", lexer.at + 2);
            lexer.at = close < 0 ? source.length : close + 2;
        } else {
            return;
        }
    }
};

// A template's text from `from` onward: one token for a template closing here, a `${` for one opening a hole.
const readTemplate = (source: string, lexer: Lexer, from: number, head: boolean): Token => {
    const span = templateSpan(source, from);
    lexer.at = span.end;
    if (span.hole) {
        lexer.holes.push(lexer.braces);
        return { kind: "punct", text: "${" };
    }
    return { kind: "template", value: head ? source.slice(from, span.end - 1) : undefined };
};

// The token at the lexer's position, which is past any trivia and before the end.
const readToken = (source: string, lexer: Lexer): Token => {
    const { at } = lexer;
    const char = source[at] ?? "";
    const regex = char === "/" && regexMayFollow(lexer.last) ? regexEnd(source, at) : -1;
    if (regex >= 0) {
        lexer.at = regex;
        return { kind: "regex" };
    }
    if (char === '"' || char === "'") {
        const { end, value } = readString(source, at);
        lexer.at = end;
        return { kind: "string", value };
    }
    if (char === "`") {
        return readTemplate(source, lexer, at + 1, true);
    }
    if (char === "}" && lexer.holes.at(-1) === lexer.braces) {
        lexer.holes.pop();
        return readTemplate(source, lexer, at + 1, false);
    }
    const ident = matchEnd(IDENT, source, at);
    if (ident >= 0) {
        lexer.at = ident;
        return { kind: "ident", text: source.slice(at, ident) };
    }
    const number = matchEnd(NUMBER, source, at);
    if (number >= 0) {
        lexer.at = number;
        return { kind: "number" };
    }
    const text = punctAt(source, at);
    lexer.braces += text === "{" ? 1 : text === "}" ? -1 : 0;
    lexer.at += text.length;
    return { kind: "punct", text };
};

// Tokenizes an ES module just far enough to see its imports: string, template, comment and regex contents are skipped
// rather than read as code, and a template's `${}` holes are read as code again.
const tokenize = (source: string, emit: (token: Token) => void): void => {
    const lexer: Lexer = { at: source.startsWith("#!") ? lineEnd(source, 0) : 0, last: undefined, braces: 0, holes: [] };
    for (skipTrivia(source, lexer); lexer.at < source.length; skipTrivia(source, lexer)) {
        lexer.last = readToken(source, lexer);
        emit(lexer.last);
    }
};

const isPunct = (token: Token, text: string): boolean => token.kind === "punct" && token.text === text;

// Where the reading of an import or re-export stands. A clause is what sits between `import`/`export` and `from`:
// bindings, braces, `*`, `as`, commas, quoted names; `closed` once its braces have closed, when only `from` may follow.
type State =
    | { readonly at: "idle" | "import" | "export" | "dynamic" | "from" }
    | { readonly at: "argument"; readonly value: string }
    | { readonly at: "clause"; readonly depth: number; readonly closed: boolean };

const IDLE: State = { at: "idle" };

// The state a clause moves to on `token`, or undefined when the token cannot sit in the clause.
const clauseNext = (depth: number, closed: boolean, token: Token): State | undefined => {
    if (depth === 0 && token.kind === "ident" && token.text === "from") {
        return { at: "from" };
    }
    if (closed) {
        return undefined;
    }
    if (isPunct(token, "{")) {
        return { at: "clause", depth: depth + 1, closed: false };
    }
    if (isPunct(token, "}") && depth > 0) {
        return { at: "clause", depth: depth - 1, closed: depth === 1 };
    }
    const bindingPart = token.kind === "ident" || token.kind === "string" || isPunct(token, ",") || isPunct(token, "*");
    return bindingPart ? { at: "clause", depth, closed } : undefined;
};

// A literal module name: a string, or a template with no hole (which only `import()` accepts).
const literalOf = (token: Token): string | undefined => (token.kind === "string" || token.kind === "template" ? token.value : undefined);

// The state after `token`, recording what it completes into `found`, or undefined when the token breaks the pattern
// under way (and must be read again from idle, since it may start the next one).
const transition = (state: State, token: Token, found: Set<string>): State | undefined => {
    switch (state.at) {
        case "idle":
            return token.kind === "ident" && (token.text === "import" || token.text === "export") ? { at: token.text } : IDLE;
        case "import":
            if (isPunct(token, "(")) {
                return { at: "dynamic" };
            }
            if (token.kind === "string") {
                found.add(token.value);
                return IDLE;
            }
            return clauseNext(0, false, token);
        case "export":
            return isPunct(token, "*") || isPunct(token, "{") ? clauseNext(0, false, token) : undefined;
        case "dynamic": {
            const value = literalOf(token);
            return value === undefined ? undefined : { at: "argument", value };
        }
        case "argument":
            // `import("x")` or `import("x", { with: … })`; `import("x" + y)` names no one module.
            if (isPunct(token, ")") || isPunct(token, ",")) {
                found.add(state.value);
            }
            return undefined;
        case "from":
            if (token.kind === "string") {
                found.add(token.value);
                return IDLE;
            }
            // `import from from "x"`: the first `from` was a binding.
            return clauseNext(0, false, token);
        case "clause":
            return clauseNext(state.depth, state.closed, token);
    }
};

// Reads the specifiers off a token stream: `import … from "x"`, `import "x"`, `export … from "x"` and `import("x")`.
const specifierReader = (found: Set<string>): ((token: Token) => void) => {
    let state: State = IDLE;
    let previous: Token | undefined;
    return (token) => {
        // `x.import(…)` is a method and `x.export` a property, never the keyword. No pattern accepts a `.`, so one
        // before this token has already left the reader idle.
        const member = previous !== undefined && (isPunct(previous, ".") || isPunct(previous, "?."));
        previous = token;
        if (!member) {
            state = transition(state, token, found) ?? transition(IDLE, token, found) ?? IDLE;
        }
    };
};

// Every specifier a single-file ESM bundle names, in source order: static imports, re-exports, bare side-effect
// imports and dynamic import() of a literal, wherever they sit (a minified bundle puts them all on one line), never
// counting the word inside a string, a template, a comment or a regex.
export const bundleSpecifiers = (source: string): string[] => {
    const found = new Set<string>();
    tokenize(source, specifierReader(found));
    return [...found];
};

// Why this bundle cannot load, or undefined when it can, naming the offending specifiers.
export const bundleProblem = (source: string): string | undefined => {
    const specifiers = bundleSpecifiers(source);
    const relative = specifiers.filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/"));
    if (relative.length > 0) {
        return `imports a second file (${relative.join(", ")}): a bundle is imported from a blob URL, so nothing relative to it can resolve`;
    }
    const published = new Set<string>(HOST_PUBLISHED_SPECIFIERS);
    const unpublished = specifiers.filter((specifier) => !published.has(specifier));
    if (unpublished.length > 0) {
        return `imports ${unpublished.join(", ")}, which the host does not publish, bundle it in, or use one of: ${HOST_PUBLISHED_SPECIFIERS.join(", ")}`;
    }
    return undefined;
};
