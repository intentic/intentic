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
// rather than read as code, and a template's `${}` holes are read as code again. Stops early when `emit` answers false.
const tokenize = (source: string, emit: (token: Token) => boolean): void => {
    const lexer: Lexer = { at: source.startsWith("#!") ? lineEnd(source, 0) : 0, last: undefined, braces: 0, holes: [] };
    for (skipTrivia(source, lexer); lexer.at < source.length; skipTrivia(source, lexer)) {
        lexer.last = readToken(source, lexer);
        if (!emit(lexer.last)) {
            return;
        }
    }
};

const isPunct = (token: Token, text: string): boolean => token.kind === "punct" && token.text === text;

// What an import or re-export has read between its keyword and `from`, kept to name its bindings once the module is
// known.
interface Clause {
    readonly keyword: "import" | "export";
    readonly tokens: readonly Token[];
}

// Where the reading of an import or re-export stands. A clause is what sits between `import`/`export` and `from`:
// bindings, braces, `*`, `as`, commas, quoted names; `closed` once its braces have closed, when only `from` may follow.
type State =
    | { readonly at: "idle" | "import" | "export" | "dynamic" }
    | { readonly at: "from"; readonly clause: Clause }
    | { readonly at: "argument"; readonly value: string }
    | { readonly at: "clause"; readonly depth: number; readonly closed: boolean; readonly clause: Clause };

const IDLE: State = { at: "idle" };

// What a reading collects: every specifier, and the names each static import or re-export links by.
interface Found {
    readonly specifiers: Set<string>;
    readonly names: Map<string, Set<string>>;
}

// The names a clause links by, once read whole. Inside braces each entry's first word is the module's own name (`a` of
// `a as b`, `default` of `default as d`, a quoted `"a-b"`); a bare binding before them is the default export. A
// namespace (`* as n`, `export *`) takes whatever the module has, so it names nothing a module can lack.
const clauseNames = (clause: Clause): string[] => {
    const names: string[] = [];
    let depth = 0;
    let entry = true;
    for (const token of clause.tokens) {
        if (isPunct(token, "{") || isPunct(token, ",")) {
            depth += isPunct(token, "{") ? 1 : 0;
            entry = true;
        } else if (isPunct(token, "}")) {
            depth--;
            entry = false;
        } else if (entry && (token.kind === "ident" || token.kind === "string")) {
            entry = false;
            if (depth > 0) {
                names.push(token.kind === "string" ? token.value : token.text);
            } else if (clause.keyword === "import") {
                names.push("default");
            }
        } else {
            entry = false;
        }
    }
    return names;
};

const record = (found: Found, specifier: string, clause?: Clause): void => {
    found.specifiers.add(specifier);
    if (clause === undefined) {
        return;
    }
    const names = found.names.get(specifier) ?? new Set<string>();
    for (const name of clauseNames(clause)) {
        names.add(name);
    }
    found.names.set(specifier, names);
};

// The state a clause moves to on `token`, or undefined when the token cannot sit in the clause.
const clauseNext = (depth: number, closed: boolean, clause: Clause, token: Token): State | undefined => {
    if (depth === 0 && token.kind === "ident" && token.text === "from") {
        return { at: "from", clause };
    }
    if (closed) {
        return undefined;
    }
    const next = { ...clause, tokens: [...clause.tokens, token] };
    if (isPunct(token, "{")) {
        return { at: "clause", depth: depth + 1, closed: false, clause: next };
    }
    if (isPunct(token, "}") && depth > 0) {
        return { at: "clause", depth: depth - 1, closed: depth === 1, clause: next };
    }
    const bindingPart = token.kind === "ident" || token.kind === "string" || isPunct(token, ",") || isPunct(token, "*");
    return bindingPart ? { at: "clause", depth, closed, clause: next } : undefined;
};

// A literal module name: a string, or a template with no hole (which only `import()` accepts).
const literalOf = (token: Token): string | undefined => (token.kind === "string" || token.kind === "template" ? token.value : undefined);

const FROM: Token = { kind: "ident", text: "from" };

// The state after `token`, recording what it completes into `found`, or undefined when the token breaks the pattern
// under way (and must be read again from idle, since it may start the next one).
const transition = (state: State, token: Token, found: Found): State | undefined => {
    switch (state.at) {
        case "idle":
            return token.kind === "ident" && (token.text === "import" || token.text === "export") ? { at: token.text } : IDLE;
        case "import":
            if (isPunct(token, "(")) {
                return { at: "dynamic" };
            }
            if (token.kind === "string") {
                record(found, token.value);
                return IDLE;
            }
            return clauseNext(0, false, { keyword: "import", tokens: [] }, token);
        case "export":
            return isPunct(token, "*") || isPunct(token, "{") ? clauseNext(0, false, { keyword: "export", tokens: [] }, token) : undefined;
        case "dynamic": {
            const value = literalOf(token);
            return value === undefined ? undefined : { at: "argument", value };
        }
        case "argument":
            // `import("x")` or `import("x", { with: … })`; `import("x" + y)` names no one module.
            if (isPunct(token, ")") || isPunct(token, ",")) {
                record(found, state.value);
            }
            return undefined;
        case "from":
            if (token.kind === "string") {
                record(found, token.value, state.clause);
                return IDLE;
            }
            // `import from from "x"`: the first `from` was a binding.
            return clauseNext(0, false, { ...state.clause, tokens: [...state.clause.tokens, FROM] }, token);
        case "clause":
            return clauseNext(state.depth, state.closed, state.clause, token);
    }
};

// Reads the specifiers off a token stream: `import … from "x"`, `import "x"`, `export … from "x"` and `import("x")`.
// `leading` stops at the first statement that is none of these, which is where every bundler has put its static
// imports by then; answering false ends the scan.
const specifierReader = (found: Found, leading: boolean): ((token: Token) => boolean) => {
    let state: State = IDLE;
    let previous: Token | undefined;
    return (token) => {
        // `x.import(…)` is a method and `x.export` a property, never the keyword. No pattern accepts a `.`, so one
        // before this token has already left the reader idle.
        const member = previous !== undefined && (isPunct(previous, ".") || isPunct(previous, "?."));
        previous = token;
        if (member) {
            return true;
        }
        state = transition(state, token, found) ?? transition(IDLE, token, found) ?? IDLE;
        // Past the leading imports: anything but the start of another, a `;`, or a directive's string.
        return !leading || state.at !== "idle" || isPunct(token, ";") || token.kind === "string";
    };
};

const readBundle = (source: string, leading = false): Found => {
    const found: Found = { specifiers: new Set(), names: new Map() };
    tokenize(source, specifierReader(found, leading));
    return found;
};

// Every specifier a single-file ESM bundle names, in source order: static imports, re-exports, bare side-effect
// imports and dynamic import() of a literal, wherever they sit (a minified bundle puts them all on one line), never
// counting the word inside a string, a template, a comment or a regex.
export const bundleSpecifiers = (source: string): string[] => [...readBundle(source).specifiers];

// What a host's published modules export, by specifier: the names the import map's shim for each re-exports. A
// specifier left out is not checked.
export type HostExports = Readonly<Partial<Record<string, readonly string[]>>>;

// Names a bundle imports that a host module does not export, by specifier.
export interface MissingImport {
    readonly specifier: string;
    readonly names: readonly string[];
}

// The names a bundle links against, by specifier: `import { a, b as c } from "x"` and `export { a } from "x"` name `a`
// (and `b`), a default import names `default`. Only static imports link, so a dynamic import() names none.
// `leading` reads only the imports before the first other statement, which is where a bundler puts them all: cheap
// enough to run on every load, and a check built on it can only miss an import, never invent one.
export const bundleImportedNames = (source: string, options: { readonly leading?: boolean } = {}): Map<string, string[]> =>
    new Map([...readBundle(source, options.leading).names].map(([specifier, names]) => [specifier, [...names]]));

// The imports in `source` that `host` cannot satisfy: each is a SyntaxError when the bundle links ("does not provide
// an export named …"), before a line of the extension runs and without naming the extension or what to do.
export const missingImports = (source: string, host: HostExports, options: { readonly leading?: boolean } = {}): MissingImport[] =>
    [...bundleImportedNames(source, options)].flatMap(([specifier, names]) => {
        const exported = host[specifier];
        if (exported === undefined) {
            return [];
        }
        const has = new Set(exported);
        const missing = names.filter((name) => !has.has(name));
        return missing.length === 0 ? [] : [{ specifier, names: missing }];
    });

// Why this bundle cannot load, or undefined when it can, naming the offending specifiers. Given what the host exports,
// it also names each import the host lacks, which only a newer or older build of the extension would ask for.
export const bundleProblem = (source: string, host?: HostExports): string | undefined => {
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
    const missing = host === undefined ? [] : missingImports(source, host);
    if (missing.length > 0) {
        const named = missing.map((entry) => `${entry.names.join(", ")} from ${entry.specifier}`).join("; ");
        return `imports ${named}, which this version of the app does not export: it was built against a different version, and the extension needs updating`;
    }
    return undefined;
};
