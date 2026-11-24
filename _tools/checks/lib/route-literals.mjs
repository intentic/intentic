// The literals a file spells, and which of them name a sandbox contract route (contract-paths.mjs). Read without a
// parser, since the checks run pre-install: comments skipped, a template's substitutions become HOLE, and a `/` after
// an operand is division while anywhere else it opens a regex literal, whose quotes are not strings.
import { allowedAt } from "./allow.mjs";

// Stands for one `${…}` of a template literal: whatever it holds, it is one segment's worth.
export const HOLE = "\u0000";

// A line that hands a literal to the daemon, whatever else it looks like: an extension's backend reaches it as `daemon`.
const DAEMON_CALL = /\bsandbox(Json|Request|Blob|Upload)\w*\s*[<(]|\bpostTurnControl\(|\.(sandbox|daemon)\.(json|request)\s*[<(]/;

/** Every `path: "…"` literal of a contract or router file. */
export const pathsIn = (text) => [...text.matchAll(/\bpath:\s*["'`]([^"'`]*)["'`]/g)].map((match) => match[1]);

// Characters that only ever continue an operand ([\w$]), and blank ones that never touch the scanner's state.
const WORD = new Uint8Array(128);
for (const char of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$") {
    WORD[char.charCodeAt(0)] = 1;
}
const BLANK = new Set([" ", "\t", "\r", "\v", "\f"]);
const BRACES = { "{": 1, "}": -1 };

// Whether a character of code leaves an operand behind (`x`, `)`, `]`), else undefined for a blank, which keeps what was.
const endsOperand = (char) => {
    const code = char.charCodeAt(0);
    if (code < 128) {
        return BLANK.has(char) || char === "\n" ? undefined : WORD[code] === 1 || char === ")" || char === "]";
    }
    return /\S/.test(char) ? /[\w$)\]]/.test(char) : undefined;
};

// FASTER, NOT DIFFERENT (2026-11-24). Two checks read every tracked file through this scanner, 2.6 s of scanning
// each, nearly all of it spent a character at a time: two regex tests and a closure call per character of code, every
// literal built up one character at a time, and every closure made again for each of the thousands of snippets a
// component's attributes are scanned as. A run of word characters or blanks changes nothing but the operand flag, so
// it is passed in one step; a literal is sliced out between its escapes. The line still advances exactly where it did,
// including at the newlines the regex reader steps over without counting.
class Scanner {
    constructor(text) {
        this.text = text;
        this.i = 0;
        this.line = 1;
        this.operand = false;
        this.found = [];
    }

    next() {
        this.line += this.text[this.i] === "\n" ? 1 : 0;
        this.i += 1;
    }

    // Moves to `to`, counting the newlines passed.
    advance(to) {
        for (let newline = this.text.indexOf("\n", this.i); newline !== -1 && newline < to; newline = this.text.indexOf("\n", newline + 1)) {
            this.line += 1;
        }
        this.i = to;
    }

    escaped() {
        this.next();
        const char = this.text[this.i] ?? "";
        this.next();
        return char;
    }

    quoted(quote) {
        const { text } = this;
        const line = this.line;
        let value = "";
        this.next();
        let from = this.i;
        while (this.i < text.length && text[this.i] !== quote && text[this.i] !== "\n") {
            if (text[this.i] === "\\") {
                value += text.slice(from, this.i) + this.escaped();
                from = this.i;
            } else {
                this.i += 1;
            }
        }
        value += text.slice(from, Math.min(this.i, text.length));
        this.next();
        this.found.push({ value, line });
    }

    template() {
        const { text } = this;
        const line = this.line;
        let value = "";
        this.next();
        let from = this.i;
        while (this.i < text.length && text[this.i] !== "`") {
            const char = text[this.i];
            if (char === "$" && text[this.i + 1] === "{") {
                value += text.slice(from, this.i) + HOLE;
                this.i += 2;
                this.code(true);
                from = this.i;
            } else if (char === "\\") {
                value += text.slice(from, this.i) + this.escaped();
                from = this.i;
            } else {
                this.next();
            }
        }
        value += text.slice(from, Math.min(this.i, text.length));
        this.next();
        this.found.push({ value, line });
    }

    regex() {
        const { text } = this;
        let inClass = false;
        this.next();
        while (this.i < text.length && text[this.i] !== "\n" && (inClass || text[this.i] !== "/")) {
            inClass = text[this.i] === "[" || (inClass && text[this.i] !== "]");
            this.i += text[this.i] === "\\" ? 2 : 1;
        }
        this.next();
    }

    comment() {
        const { text } = this;
        if (text[this.i + 1] === "/") {
            const newline = text.indexOf("\n", this.i);
            this.i = newline === -1 ? Math.max(this.i, text.length) : newline;
            return true;
        }
        if (text[this.i + 1] === "*") {
            this.i += 2;
            const close = text.indexOf("*/", this.i);
            this.advance(close === -1 ? Math.max(this.i, text.length) : close);
            this.i += 2;
            return true;
        }
        return false;
    }

    // Reads the literal opening here and answers true, if one does: a quote or backtick, or a `/` where no operand
    // has just ended.
    literal(char) {
        if (char === '"' || char === "'") {
            this.quoted(char);
        } else if (char === "`") {
            this.template();
        } else if (char === "/" && !this.operand) {
            this.regex();
        } else {
            return false;
        }
        this.operand = true;
        return true;
    }

    // One token of code, returning the brace depth after it: -1 once a substitution's own closing brace is passed.
    token(depth, inTemplate) {
        const char = this.text[this.i];
        if ((char === "/" && this.comment()) || this.literal(char)) {
            return depth;
        }
        this.next();
        if (char === "}" && depth === 0) {
            return inTemplate ? -1 : 0;
        }
        this.operand = endsOperand(char) ?? this.operand;
        return depth + (BRACES[char] ?? 0);
    }

    // A run of word characters ends an operand and a run of blanks leaves everything as it was, whatever their length.
    skipRun() {
        const { text } = this;
        const start = this.i;
        while (this.i < text.length && WORD[text.charCodeAt(this.i)] === 1) {
            this.i += 1;
        }
        if (this.i > start) {
            this.operand = true;
            return true;
        }
        while (this.i < text.length && BLANK.has(text[this.i])) {
            this.i += 1;
        }
        return this.i > start;
    }

    code(inTemplate) {
        let depth = 0;
        while (this.i < this.text.length && depth >= 0) {
            if (!this.skipRun()) {
                depth = this.token(depth, inTemplate);
            }
        }
    }
}

export const scan = (text) => {
    const scanner = new Scanner(text);
    scanner.code(false);
    return scanner.found;
};

// The code of a file: a Vue component's script blocks, whose template attributes are markup rather than literals.
export const codeOf = (path, text) =>
    path.endsWith(".vue") ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi)].map((match) => match[1]).join("\n") : text;

/* Matching a literal to a route, segment by segment; the query is dropped. */

const isParam = (segment) => (segment.startsWith("{") && segment.endsWith("}")) || segment.startsWith(":");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A route's literal segment is matched by the same text, or by a partly substituted one that could spell it; a whole
// substitution is a value, so it only ever stands where the route has a parameter, and so is one whose own text is only
// punctuation (`${n}-${name}`, a file name being built), which says nothing of any route.
const spells = (wanted, actual) => {
    if (wanted === actual || isParam(wanted)) {
        return wanted === actual || actual !== "";
    }
    return /[A-Za-z0-9]/.test(actual.replaceAll(HOLE, "")) && new RegExp(`^${actual.split(HOLE).map(escape).join(".+")}$`).test(wanted);
};
const pathOf = (value) => value.split("?")[0];
// An app route's `:param?` may be absent; any param takes any one segment, since a screen is named by value.
const answersTo = (pattern, value) => {
    const wanted = pattern.split("/");
    const actual = pathOf(value).split("/");
    const required = wanted.filter((segment) => !segment.endsWith("?")).length;
    return (
        actual.length >= required &&
        actual.length <= wanted.length &&
        actual.every((segment, index) => (isParam(wanted[index]) ? segment !== "" : segment === wanted[index]))
    );
};

// The path a literal spells: the literal itself when it is absolute, or what follows a leading substitution, which is
// a base the route is joined to (`${target.base}/system/session`, `${origin}/logs/client`).
const spelledPath = (value) => {
    if (value.startsWith("/")) {
        return value;
    }
    return value.startsWith(`${HOLE}/`) ? value.slice(HOLE.length) : undefined;
};

// Every literal of the code, and every literal inside one: a code sample shipped as a string spells its routes a level
// down, where the file's own scan reads one long string. A nested literal keeps the file's line.
const literalsIn = (text, above = 0) =>
    scan(text).flatMap(({ value, line }) => [{ value, line: above + line }, ...(/["'`]/.test(value) ? literalsIn(value, above + line - 1) : [])]);

/**
 * The contract routes `code` spells, each at its 1-based line: `routes` are the contract's paths, `appRoutes` the app's
 * own screens, a literal naming one of which is navigation unless its line hands it to a daemon call. A site that
 * carries `// allow(contract-paths): <reason>` is excused.
 */
export const spelledRoutes = (code, { routes, appRoutes }) => {
    const contractRoute = (path) => {
        const actual = pathOf(path).split("/");
        return routes.find((route) => {
            const wanted = route.split("/");
            return wanted.length === actual.length && wanted.every((segment, index) => spells(segment, actual[index]));
        });
    };
    const isNavigation = (path, line) => !DAEMON_CALL.test(line) && appRoutes.some((pattern) => answersTo(pattern, path));
    const lines = code.split("\n");
    return literalsIn(code).flatMap(({ value, line }) => {
        const path = spelledPath(value);
        const route = path === undefined ? undefined : contractRoute(path);
        if (route === undefined || isNavigation(path, lines[line - 1] ?? "") || allowedAt(lines, line, "contract-paths")) {
            return [];
        }
        return [{ line, route }];
    });
};
